// Compile the real sketch against a simulated I2C bus. This tests selection
// and acquisition decisions, not the electrical behavior of the components.
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
#include <algorithm>

static uint32_t nowMs = 0;
uint32_t millis() { return nowMs; }
void delay(unsigned n) { nowMs += n; }
void delayMicroseconds(unsigned) {}
constexpr int INPUT_PULLUP=0, INPUT_PULLDOWN=1, OUTPUT_OPEN_DRAIN=2, HIGH=1, LOW=0;
void pinMode(int,int) {}
int digitalRead(int) { return HIGH; }
void digitalWrite(int,int) {}
struct SerialStub {
  void begin(int) {}
  void println(const char* = "") {}
  template<class... A> void printf(const char*, A...) {}
} Serial;

struct Module { bool awake=false, contact=false, timeout=false, sleepFails=false; unsigned wakes=0; uint8_t rd=0; };
static Module modules[4];
static int selected=0;
static uint8_t overflow=0;
static unsigned readCount=0;
static unsigned lowSamples=0;
static bool missingMux=false;
struct WireStub {
  uint8_t address=0, reg=0;
  std::vector<uint8_t> tx, rx;
  size_t cursor=0;
  void begin(int,int) {}
  void end() {}
  void beginTransmission(uint8_t addr) { address=addr; tx.clear(); }
  void write(uint8_t b) { tx.push_back(b); }
  int endTransmission() {
    if (address==0x70) {
      if (missingMux) return 2;
      assert(tx.size()==1 && tx[0] && !(tx[0] & (tx[0]-1)));
      selected=0;
      while ((1u<<selected)!=tx[0]) ++selected;
      assert(selected<4);
    } else if (!tx.empty()) reg=tx[0];
    return 0;
  }
  size_t requestFrom(uint16_t, size_t n) {
    rx.clear(); cursor=0;
    if (reg==0x09) rx.push_back(modules[selected].awake ? 0 : 0x80);
    else {
      assert(reg==0x07 && n%6==0 && modules[selected].awake);
      for (size_t i=0; i<n/6; ++i) {
        ++readCount;
        const uint32_t red=150000, ir=modules[selected].contact && !lowSamples ? 220000 : 1000;
        if (lowSamples) --lowSamples;
        for (auto value : {red, ir}) {
          rx.push_back(value>>16); rx.push_back(value>>8); rx.push_back(value);
        }
        modules[selected].rd=(modules[selected].rd+1)&31;
      }
    }
    return rx.size();
  }
  int read() { assert(cursor<rx.size()); return rx[cursor++]; }
} Wire;
constexpr int I2C_SPEED_FAST=400000;
struct MAX30105 {
  bool begin(WireStub&,int) { return true; }
  void setup(int,int,int,int,int,int) { wakeUp(); }
  void wakeUp() {
    for (int i=0;i<4;++i) if (i!=selected) assert(!modules[i].awake);
    modules[selected].awake=true; ++modules[selected].wakes;
  }
  void shutDown() { if (!modules[selected].sleepFails) modules[selected].awake=false; }
  void clearFIFO() { modules[selected].rd=0; overflow=0; }
  uint8_t readRegister8(uint8_t,uint8_t reg) {
    auto& m=modules[selected];
    if (reg==0x05) return overflow;
    if (reg==0x06) return m.rd;
    assert(reg==0x04);
    nowMs+=10;
    return m.awake && !m.timeout ? ((m.rd+1)&31) : m.rd;
  }
};
const uint8_t uch_spo2_table[184]={};
void maxim_heart_rate_and_oxygen_saturation(uint32_t*,int,uint32_t*,int32_t*,int8_t*,int32_t*,int8_t*) {}
using esp_bd_addr_t=uint8_t[6];
struct BLE2902 {};
struct BLEServer;
struct BLEServerCallbacks { virtual void onConnect(BLEServer*) {} virtual void onDisconnect(BLEServer*) {} };
struct BLECharacteristic {
  enum {PROPERTY_NOTIFY, PROPERTY_WRITE};
  void setValue(uint8_t*,size_t) {} void notify() {} void addDescriptor(BLE2902*) {}
};
struct BLEService {
  BLECharacteristic* createCharacteristic(const char*,int) { static BLECharacteristic c; return &c; }
  void start() {}
};
struct BLEServer {
  uint16_t getPeerMTU(int) { return 247; } int getConnId() { return 0; }
  void setCallbacks(BLEServerCallbacks*) {}
  BLEService* createService(const char*) { static BLEService s; return &s; }
  bool requestConnParams(esp_bd_addr_t,int,int,int,int) { return true; }
};
struct BLEAdvertising { void addServiceUUID(const char*) {} void setScanResponse(bool) {} };
constexpr int ESP_PWR_LVL_P9=0, ESP_BLE_PWR_TYPE_ADV=1, ESP_BLE_PWR_TYPE_CONN_HDL0=2, ESP_BLE_PWR_TYPE_DEFAULT=3;
struct BLEDevice {
  static void init(const char*) {} static void setMTU(int) {} static void setPower(int,int) {}
  static BLEServer* createServer() { static BLEServer s; return &s; }
  static BLEAdvertising* getAdvertising() { static BLEAdvertising a; return &a; }
  static void startAdvertising() {}
};
#include "../esp32/ppg_transmitter/ppg_transmitter.ino"

static void fresh() {
  for (auto& m:modules) m=Module{};
  nowMs=10000; overflow=0; missingMux=false; readCount=0; lowSamples=0;
  activeSensor=3; acquisitionReady=false; frameSeq=0;
  resetSignalState();
}
int main() {
  fresh(); searchSensors();
  assert(!acquisitionReady);
  for (auto& m:modules) assert(!m.awake && m.wakes==1);

  // Stop at the FIRST contact, even if another channel also has contact.
  fresh(); modules[1].contact=modules[2].contact=true; searchSensors();
  assert(acquisitionReady && activeSensor==1 && modules[1].awake);
  assert(modules[2].wakes==0 && modules[3].wakes==0);
  for (int i=0;i<4;++i) if (i!=1) assert(!modules[i].awake);
  loop(); loop();
  assert(frameSeq==2 && histFilled==50 && activeSensor==1);
  assert(modules[2].wakes==0); // remains idle during streaming

  // Loss drops the incomplete frame, clears history, and finds next contact.
  modules[1].contact=false; loop();
  assert(!acquisitionReady && histFilled==0 && frameSeq==2);
  loop();
  assert(acquisitionReady && activeSensor==2 && frameSeq==3 && histFilled==25);
  for (auto value:frameIr) assert(value==220000); // only new source in frame
  assert(!modules[1].awake);

  // Overflow and timeout must never publish discontinuous partial data.
  overflow=1; loop();
  assert(frameSeq==3 && histFilled==0);
  modules[2].timeout=true; loop();
  assert(!acquisitionReady && histFilled==0 && frameSeq==3);

  // Brief contact interruption keeps the channel but invalidates old history.
  fresh(); modules[0].contact=true; searchSensors(); loop(); loop();
  lowSamples=2; loop();
  assert(acquisitionReady && activeSensor==0 && frameSeq==3 && histFilled==0);
  assert((frameBytes[3] & (ppg::kHrValid | ppg::kSpo2Valid))==0);
  loop(); assert(histFilled==25);

  // Failure to confirm shutdown must stop search before any other wake.
  fresh(); modules[0].awake=true; modules[0].sleepFails=true;
  searchSensors(); assert(!acquisitionReady);
  for (auto& m:modules) assert(m.wakes==0);
  fresh(); missingMux=true; searchSensors(); assert(!acquisitionReady);
  for (auto& m:modules) assert(m.wakes==0);
  std::puts("MUX selection, idle channels, failover, frame isolation and fault tests passed");
}
