// ESP32 + one TCA9548A + four continuously sampling MAX30102s.
// All four sensors stay awake. Per-channel histories stay warm; only one sensor
// contributes to each unchanged protocol-v3 BLE packet. USB bench telemetry is
// optional; the firmware starts autonomously without a dashboard.
#include <Wire.h>
#include <MAX30105.h>
#include "spo2_algorithm.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "ppg_frame.h"
#include "ppg_multi.h"
#ifndef PPG_SERIAL_RAW
#define PPG_SERIAL_RAW 0
#endif
#ifndef PPG_BENCH_TELEMETRY
#define PPG_BENCH_TELEMETRY 0
#endif

// ---------------------------------------------------------------- pins ----
#define SDA_PIN 21
#define SCL_PIN 22

// ---------------------------------------------------------------- BLE -----
// Nordic UART Service UUIDs, unchanged from the previous firmware so existing
// tools and the Pi's scan filter keep working.
#define DEVICE_NAME  "SteeringWheelESP32"
#define SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define RX_UUID      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define TX_UUID      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

// Requested ATT MTU. 247 carries a 472-byte v3 frame in two notifications;
// chunking below keeps the link correct whatever the Pi negotiates.
static constexpr uint16_t kRequestedMtu = 247;

// Four sources collect continuously; the MUX serializes their I2C reads.
static constexpr uint8_t kMuxAddr = 0x70, kSensorAddr = 0x57, kSensorCount = 4;
static constexpr int kRawPerFrame = 100;
MAX30105 sensor;
ppg::MultiPpg acquisition;
uint32_t lastRetryMs[4]{};
uint8_t pollCursor = 0;
uint32_t frameSeq = 0;
uint8_t frameBytes[ppg::v3FrameSize(kRawPerFrame)];
BLEServer* server = nullptr;
BLECharacteristic* txChar = nullptr;
volatile bool clientConnected = false, restartAdvertising = false;

// ------------------------------------------------------------ callbacks ---
// Only flags are set here: these run in the BLE stack's task, and blocking in
// them (the old code called delay(500)) stalls the stack.
// Connection parameters requested from every central right after it connects.
// The ESP32 core requests none itself (BLEServer.cpp, ESP_GATTS_CONNECT_EVT),
// so the link ran on the central's defaults. With BlueZ that meant a short
// supervision timeout, and on hardware we measured repeated drops ~2-3 s into
// a connection with BlueZ reporting org.bluez.Reason.Timeout. A 4 s timeout
// rides out brief radio contention (e.g. a combo Wi-Fi/BT chip).
// The ESP32's only central is the Pi (BlueZ), so Apple's accessory rules do not
// bind this link. (For reference, Apple's Accessory Design Guidelines R30
// §58.6 want supervision timeout 6-18 s and intervals in multiples of 15 ms;
// the phone<->Pi link is the one iOS negotiates.)
// Units per the BLE spec: interval 1.25 ms, timeout 10 ms.
static constexpr uint16_t kConnIntervalMin = 24;     // 30 ms
static constexpr uint16_t kConnIntervalMax = 40;     // 50 ms
static constexpr uint16_t kConnLatency = 0;
static constexpr uint16_t kSupervisionTimeout = 400; // 4 s

// What the central actually accepted, reported from loop() (never print from a
// BLE callback).
volatile bool connParamsChanged = false;
volatile uint16_t connIntervalUnits = 0, connLatency = 0, connTimeoutUnits = 0;
volatile int connParamsStatus = -1;

// Link diagnostics, printed on every serial line: how many times a central
// connected, and why the last link ended (esp_gatt_conn_reason_t = HCI reason:
// 0x08 supervision timeout, 0x13 central closed it, 0x3E never established).
volatile uint32_t connectCount = 0;
// Deferred connection-parameter request (see onConnect).
static constexpr uint32_t kParamsRequestDelayMs = 5000;
static constexpr uint16_t kMinUsableTimeout = 200;  // 2 s, in 10 ms units
esp_bd_addr_t pendingBda = {0};
volatile uint32_t connectedAtMs = 0;
volatile bool paramsRequestPending = false;
volatile bool connectLogPending = false;
volatile uint16_t initInterval = 0, initTimeout = 0;
volatile uint16_t lastDisconnectReason = 0;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    clientConnected = true;
    ++connectCount;
  }
#if defined(CONFIG_BLUEDROID_ENABLED)
  void onConnect(BLEServer*, esp_ble_gatts_cb_param_t* param) override {
    // Do NOT ask for new connection parameters right away. Doing that while
    // the central is still discovering services and enabling notifications
    // collided with connection setup: centrals (the Pi, and a Linux laptop
    // in a bench repro) hung up ~3 s after connecting, ESP32 disconnect
    // reason 0x13. Nordic's SDK waits 5 s (FIRST_CONN_PARAMS_UPDATE_DELAY)
    // for the same reason. If the central already picked usable values --
    // the Pi does, via setup_pi.sh's BlueZ [LE] settings -- skip the request.
    memcpy(pendingBda, param->connect.remote_bda, sizeof(esp_bd_addr_t));
    initInterval = param->connect.conn_params.interval;
    initTimeout = param->connect.conn_params.timeout;
    const bool usable = initInterval >= kConnIntervalMin && initInterval <= kConnIntervalMax &&
                        initTimeout >= kMinUsableTimeout;
    connectedAtMs = millis();
    paramsRequestPending = !usable;
    connectLogPending = true;
  }
  void onDisconnect(BLEServer*, esp_ble_gatts_cb_param_t* param) override {
    lastDisconnectReason = static_cast<uint16_t>(param->disconnect.reason);
  }
  void onConnParamsUpdate(esp_bd_addr_t, uint16_t interval, uint16_t latency,
                          uint16_t timeout, esp_bt_status_t status) override {
    connIntervalUnits = interval;
    connLatency = latency;
    connTimeoutUnits = timeout;
    connParamsStatus = status;
    connParamsChanged = true;
  }
#endif
  void onDisconnect(BLEServer*) override {
    clientConnected = false;
    paramsRequestPending = false;
    restartAdvertising = true;
  }
};

// ------------------------------------------------------------- helpers ----
static bool selectMux(uint8_t channel) {
  if (channel >= kSensorCount) return false;
  Wire.beginTransmission(kMuxAddr);
  Wire.write(static_cast<uint8_t>(1u << channel));
  return Wire.endTransmission() == 0;
}

static bool readReg(uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(kSensorAddr); Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom(static_cast<uint16_t>(kSensorAddr), static_cast<size_t>(1)) != 1) return false;
  value = Wire.read(); return true;
}

static bool verifyAwake(bool awake) {
  if (awake) sensor.wakeUp(); else sensor.shutDown();
  uint8_t mode;
  return readReg(0x09, mode) && bool(mode & 0x80) == !awake;
}

static bool startChannel(uint8_t channel) {
  if (!selectMux(channel) || !sensor.begin(Wire, I2C_SPEED_FAST)) return false;
  sensor.setup(60, 1, 2, 100, 411, 4096);
  if (!verifyAwake(false)) return false;
  sensor.clearFIFO();
  uint8_t wr, rd, ov;
  if (!readReg(0x04, wr) || !readReg(0x06, rd) || !readReg(0x05, ov) || ((wr | rd | ov) & 31)) return false;
  acquisition.channels[channel].clearSignal();
  acquisition.channels[channel].online = true;
  acquisition.channels[channel].lastSampleMs = millis();
  return true;
}

static bool rawPair(uint32_t &red, uint32_t &ir) {
  Wire.beginTransmission(kSensorAddr); Wire.write(uint8_t(0x07));
  if (Wire.endTransmission() != 0 || Wire.requestFrom(static_cast<uint16_t>(kSensorAddr), static_cast<size_t>(6)) != 6) return false;
  red = ir = 0;
  for (int i = 0; i < 3; ++i) red = (red << 8) | Wire.read();
  for (int i = 0; i < 3; ++i) ir = (ir << 8) | Wire.read();
  red &= 0x3ffff; ir &= 0x3ffff; return true;
}

static void channelFault(uint8_t channel, const char *reason) {
  acquisition.fault(channel);
  lastRetryMs[channel] = millis();
  Serial.printf("{\"event\":\"sensor_fault\",\"channel\":%u,\"reason\":\"%s\"}\n", channel, reason);
}

static void pollSensors() {
  for (uint8_t visited = 0; visited < kSensorCount; ++visited) {
    const uint8_t channel = pollCursor;
    pollCursor = (pollCursor + 1) % kSensorCount;
    auto &state = acquisition.channels[channel];
    if (!state.online) {
      if (millis() - lastRetryMs[channel] < 1000) continue;
      lastRetryMs[channel] = millis();
      if (!startChannel(channel) || !verifyAwake(true)) { state.online = false; continue; }
    }
    if (!selectMux(channel)) { channelFault(channel, "MUX_SELECT"); continue; }
    uint8_t wr, rd, ov;
    if (!readReg(0x04, wr) || !readReg(0x06, rd) || !readReg(0x05, ov)) {
      channelFault(channel, "REGISTER_READ"); continue;
    }
    if (ov & 31) { channelFault(channel, "FIFO_OVERFLOW"); continue; }
    uint8_t pending = (wr - rd) & 31;
    for (uint8_t n = 0; n < pending; ++n) {
      uint32_t red, ir;
      if (!rawPair(red, ir)) { channelFault(channel, "FIFO_READ"); break; }
      // Return exactly at the selected packet boundary; leave any unconsumed
      // hardware FIFO samples queued. No sample from another sensor enters it.
      if (acquisition.feed(channel, red, ir, micros(), millis())) return;
    }
    if (state.online && millis() - state.lastSampleMs >= 300) channelFault(channel, "NO_SAMPLES");
  }
}

// I2C bus clear (NXP UM10204 section 3.1.16). If the ESP32 resets in the middle
// of a read, the MAX30102 can be left driving SDA low while it waits for clock
// pulses that never come, and it ignores every later transaction until it is
// power-cycled. Clocking SCL until SDA is released, then issuing a STOP, frees
// it without a power cycle. Returns the idle levels seen, for diagnostics.
static void i2cBusClear(int& sdaBefore, int& sclBefore) {
  pinMode(SDA_PIN, INPUT_PULLUP);
  pinMode(SCL_PIN, INPUT_PULLUP);
  delayMicroseconds(10);
  sdaBefore = digitalRead(SDA_PIN);
  sclBefore = digitalRead(SCL_PIN);
  if (sdaBefore == HIGH || sclBefore == LOW) return;  // bus free, or SCL fault we can't fix

  pinMode(SCL_PIN, OUTPUT_OPEN_DRAIN);
  for (int i = 0; i < 9 && digitalRead(SDA_PIN) == LOW; ++i) {
    digitalWrite(SCL_PIN, LOW);  delayMicroseconds(5);
    digitalWrite(SCL_PIN, HIGH); delayMicroseconds(5);
  }
  // STOP condition: SDA rises while SCL is high.
  pinMode(SDA_PIN, OUTPUT_OPEN_DRAIN);
  digitalWrite(SDA_PIN, LOW);  delayMicroseconds(5);
  digitalWrite(SCL_PIN, HIGH); delayMicroseconds(5);
  digitalWrite(SDA_PIN, HIGH); delayMicroseconds(5);
  pinMode(SDA_PIN, INPUT_PULLUP);
  pinMode(SCL_PIN, INPUT_PULLUP);
}

// Diagnostics for a sensor that will not initialise. Two measurements that,
// together, separate the possible faults instead of leaving them to guesswork:
//  * which I2C addresses ACK (the MAX30102 is 0x57)
//  * whether each line is held high by the module's own pull-up resistor.
//    With the ESP32's weak internal pull-DOWN enabled, a line that still reads
//    1 is being driven up externally -- which indicates an energized pull-up rail,
//    not proof that the MUX chip itself is powered or responding. (Internal pull-ups, as used for the bus clear, would
//    read 1 on a disconnected wire too, so they cannot answer this.)
static void i2cScan(char* out, size_t len) {
  out[0] = 0;
  size_t n = 0;
  for (uint8_t a = 1; a < 127; ++a) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0 && n + 6 < len) n += snprintf(out + n, len - n, "0x%02X ", a);
  }
  if (!n) snprintf(out, len, "none");
}

static void externalPullups(int& sda, int& scl) {
  pinMode(SDA_PIN, INPUT_PULLDOWN);
  pinMode(SCL_PIN, INPUT_PULLDOWN);
  delayMicroseconds(100);
  sda = digitalRead(SDA_PIN);
  scl = digitalRead(SCL_PIN);
  pinMode(SDA_PIN, INPUT_PULLUP);
  pinMode(SCL_PIN, INPUT_PULLUP);
}

// Sends one frame as MTU-sized notifications. The receiver's deframer
// reassembles on the magic bytes and CRC, so the chunk boundary is free.
static void sendFrame(const uint8_t* data, size_t len) {
  if (!clientConnected || txChar == nullptr) return;
  uint16_t mtu = server->getPeerMTU(server->getConnId());
  size_t chunk = (mtu > 3) ? mtu - 3 : 20;
  if (chunk < 20) chunk = 20;
  for (size_t off = 0; off < len; off += chunk) {
    size_t n = (len - off < chunk) ? len - off : chunk;
    txChar->setValue(const_cast<uint8_t*>(data + off), n);
    txChar->notify();
  }
}

static void startBle() {
  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setMTU(kRequestedMtu);
  // Maximum transmit power (+9 dBm instead of the +3 dBm default): ~6 dB of
  // extra link margin. In the car the Pi sits a metre or two away with the
  // column, the wheel's plastic and the driver's body in between, and a
  // marginal link drops with reason 0x3E every few seconds. Set for
  // advertising, for the connection itself, and as the default for handles
  // opened later -- Bluedroid tracks these separately.
  BLEDevice::setPower(ESP_PWR_LVL_P9, ESP_BLE_PWR_TYPE_ADV);
  BLEDevice::setPower(ESP_PWR_LVL_P9, ESP_BLE_PWR_TYPE_CONN_HDL0);
  BLEDevice::setPower(ESP_PWR_LVL_P9, ESP_BLE_PWR_TYPE_DEFAULT);

  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* service = server->createService(SERVICE_UUID);
  txChar = service->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());
  // Reserved Pi -> ESP32 channel, kept for future commands.
  service->createCharacteristic(RX_UUID, BLECharacteristic::PROPERTY_WRITE);
  service->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
}

// ---------------------------------------------------------------- setup ---
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("Steering Wheel PPG transmitter, protocol v3");

  for (int attempt = 1;; ++attempt) {
    int sda, scl;
    i2cBusClear(sda, scl);
    Wire.begin(SDA_PIN, SCL_PIN);
    Wire.setClock(400000); Wire.setTimeOut(30);
    bool allReady = true;
    for (uint8_t ch = 0; ch < kSensorCount; ++ch) {
      if (!startChannel(ch)) { acquisition.fault(ch); allReady = false; }
    }
    if (allReady) break;
    char found[64];
    i2cScan(found, sizeof found);
    Wire.end();
    int extSda, extScl;
    externalPullups(extSda, extScl);
    Serial.printf("MUX/four MAX30102 not ready (attempt %d): selected-bus I2C ACKs: %s| module pull-ups SDA=%d SCL=%d | "
                  "bus-idle SDA=%d SCL=%d\n", attempt, found, extSda, extScl, sda, scl);
    if (attempt == 1 || attempt % 10 == 0) {
      Serial.println(extSda || extScl
          ? "  -> check MUX 0x70 and MAX30102 0x57 on each channel 0..3"
          : "  -> no module pull-ups seen: check VIN/3.3V, GND, SDA->21, SCL->22");
    }
    delay(1000);
  }
  Serial.println("Four MAX30102 ready on MUX 0x70, channels 0..3 (asleep)");

  startBle();
  Serial.printf("BLE advertising as %s, requested MTU %u\n", DEVICE_NAME, kRequestedMtu);

  // Wake all only after BLE initialization, so its startup delay cannot fill FIFOs.
  for (uint8_t ch = 0; ch < kSensorCount; ++ch) {
    if (!selectMux(ch) || !verifyAwake(true)) acquisition.fault(ch);
    else acquisition.channels[ch].lastSampleMs = millis();
  }
  acquisition.nextFrame(millis());
#if PPG_BENCH_TELEMETRY
  Serial.println("{\"event\":\"scan_start\",\"hz\":400000,\"expected_muxes\":1,\"expected_ppgs\":4}");
  Serial.println("{\"event\":\"mux\",\"address\":112,\"present\":true}");
  for (uint8_t ch = 0; ch < kSensorCount; ++ch)
    Serial.printf("{\"event\":\"route\",\"mux\":112,\"channel\":%u,\"present\":%s}\n", ch, acquisition.channels[ch].online ? "true" : "false");
  Serial.println("{\"event\":\"status\",\"state\":\"READY\",\"message\":\"All sensors acquire continuously; one source per BLE packet\"}");
#endif
}

// ----------------------------------------------------------------- loop ---
void loop() {
  if (restartAdvertising) {
    restartAdvertising = false;
    BLEDevice::startAdvertising();
    Serial.println("Pi disconnected - advertising again");
  }
  if (connectLogPending) {
    connectLogPending = false;
    Serial.printf("BLE connected: interval=%.2fms supervision=%ums -> %s\n", initInterval * 1.25f,
                  initTimeout * 10u, paramsRequestPending ? "will request better params in 5 s" : "params OK, no request");
  }
  if (paramsRequestPending && clientConnected && millis() - connectedAtMs >= kParamsRequestDelayMs) {
    paramsRequestPending = false;
    if (!server->requestConnParams(pendingBda, kConnIntervalMin, kConnIntervalMax, kConnLatency, kSupervisionTimeout)) {
      connParamsStatus = -2;
      connParamsChanged = true;
    }
  }
  if (connParamsChanged) {
    connParamsChanged = false;
    Serial.printf("BLE link params: interval=%.2fms latency=%u supervision=%ums status=%d\n",
                  connIntervalUnits * 1.25f, connLatency, connTimeoutUnits * 10u, connParamsStatus);
  }

  pollSensors();
  acquisition.estimateAll(millis(), uch_spo2_table, 184);
  if (acquisition.streamOwner < 0) acquisition.nextFrame(millis());

  if (acquisition.frameCount == kRawPerFrame) {
    const int owner = acquisition.streamOwner;
    const auto &source = acquisition.channels[owner];
    const auto &vit = source.vitals;
    const bool finger = acquisition.frameContinuousContact && source.contact;
    const bool usable = finger && acquisition.eligible(owner, millis());
    const bool hrValid = usable && vit.hrValid;
    const bool spo2Valid = usable && vit.spo2Valid;
    ppg::FrameV3 frame{};
    frame.seq = frameSeq++;
    frame.t0Ms = acquisition.frameStartMs;
    frame.rateHz = 100; // Existing nominal protocol rate; estimator uses measured timing.
    frame.sampleCount = kRawPerFrame;
    frame.quality = usable ? static_cast<uint8_t>(lroundf(vit.periodicity * 100)) : 0;
    frame.heartRate = hrValid ? static_cast<int16_t>(lroundf(vit.heartRate)) : -999;
    frame.spo2 = spo2Valid ? vit.spo2 : -999;
    frame.flags = (hrValid ? ppg::kHrValid : 0) | (spo2Valid ? ppg::kSpo2Valid : 0) |
                  (finger ? ppg::kFinger : 0) | (usable ? ppg::kInRange : 0);
    frame.red = acquisition.frameRed; frame.ir = acquisition.frameIR;
    const size_t frameLen = ppg::encodeV3(frame, frameBytes);
    sendFrame(frameBytes, frameLen);
#if PPG_SERIAL_RAW
    char rawLine[2 * sizeof(frameBytes) + 1];
    const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < frameLen; ++i) { rawLine[2*i] = hex[frameBytes[i] >> 4]; rawLine[2*i+1] = hex[frameBytes[i] & 15]; }
    rawLine[2*frameLen] = 0;
    Serial.printf("RAW ppg=%u %s\n", owner + 1, rawLine);
#endif
#if PPG_BENCH_TELEMETRY
    Serial.printf("{\"event\":\"frame\",\"channel\":%d,\"seq\":%lu,\"t0_ms\":%lu,\"sample_count\":100,\"usable\":%s,\"ble_connected\":%s}\n",
      owner, (unsigned long)frame.seq, (unsigned long)frame.t0Ms, usable ? "true" : "false", clientConnected ? "true" : "false");
#else
    char bpm[16] = "--", sat[16] = "--";
    if (hrValid) snprintf(bpm, sizeof(bpm), "%d", frame.heartRate);
    if (spo2Valid) snprintf(sat, sizeof(sat), "%d", frame.spo2);
    Serial.printf("PPG%u #%lu bpm=%s spo2=%s link=%s len=%u (all four sampling)\n",
      owner + 1, (unsigned long)frame.seq, bpm, sat, clientConnected ? "up" : "down", unsigned(frameLen));
#endif
    // Warm backup histories survive this switch. One source for every full packet.
    acquisition.nextFrame(millis());
  }
#if PPG_BENCH_TELEMETRY
  static uint32_t lastTelemetryMs = 0;
  static uint8_t telemetryChannel = 0;
  if (millis() - lastTelemetryMs >= 125) {
    lastTelemetryMs = millis();
    const uint8_t ch = telemetryChannel;
    telemetryChannel = (telemetryChannel + 1) % kSensorCount;
    const auto &s = acquisition.channels[ch];
    const int selected = acquisition.selected(millis());
    const char *state = !s.online ? "FAULT" : selected == ch ? "TRACKING" :
      acquisition.eligible(ch, millis()) ? "READY" : s.contact ? "VALIDATING" : "WAITING";
    const char *quality = !s.online ? "FAULT" : !s.contact ? "NO_CONTACT" :
      s.historyCount < ppg::kMultiMinimum ? "COLLECTING" : s.ready ? "USABLE_ESTIMATE" : "UNSTABLE";
    char hr[24] = "null", spo2[16] = "null";
    if (s.ready && s.vitals.hrValid) snprintf(hr, sizeof(hr), "%.1f", s.vitals.heartRate);
    if (s.ready && s.vitals.spo2Valid) snprintf(spo2, sizeof(spo2), "%d", s.vitals.spo2);
    Serial.printf("{\"event\":\"sample\",\"mux\":112,\"channel\":%u,\"red\":%lu,\"ir\":%lu,\"samples\":%lu,\"contact\":%s,\"quality\":\"%s\",\"periodicity\":%.3f,\"history_s\":%.2f,\"hr\":%s,\"spo2\":%s,\"state\":\"%s\",\"hz\":400000,\"raw_hz\":%.3f,\"selected_channel\":%d,\"faults\":%lu}\n",
      ch, (unsigned long)s.red, (unsigned long)s.ir, (unsigned long)s.samples, s.contact ? "true" : "false",
      quality, s.vitals.periodicity, s.rawHz > 0 ? s.historyCount / (s.rawHz / 4) : 0,
      hr, spo2, state, s.rawHz, selected, (unsigned long)s.faults);
  }
#endif
  delay(1);
}
