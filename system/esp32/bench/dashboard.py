#!/usr/bin/env python3
"""USB JSON dashboard for mux_diagnostic. Python standard library, Fedora/Linux."""
import argparse
import curses
import datetime
import errno
import fcntl
import json
import os
from pathlib import Path
import select
import termios
import time


class Dashboard:
    def __init__(self, labels=None):
        self.labels = labels or {}
        self.muxes = {}
        self.routes = {}
        self.active = None
        self.active_state = 'SEARCHING'
        self.hz = None
        self.status = 'Waiting for diagnostic telemetry'
        self.link = 'Not connected'
        self.last_event = None
        self.events = []
        self.parse_errors = 0
        self.scan = 0
        self.expected_muxes = 1
        self.expected_ppgs = 4
        self.latest_frame = None
        self.continuous = False

    def ingest(self, event, now=None):
        now = time.monotonic() if now is None else now
        kind = event.get('event')
        if not isinstance(kind, str):
            return
        self.last_event = now
        if kind == 'scan_start':
            self.scan += 1
            self.hz = event['hz']
            self.expected_muxes = event.get('expected_muxes', self.expected_muxes)
            self.expected_ppgs = event.get('expected_ppgs', self.expected_ppgs)
            self.active = None
            self.muxes = {}
            for row in self.routes.values():
                row['verified_scan'] = -1
            self.status = 'Discovering upstream MUXes and channels'
        elif kind == 'mux':
            self.muxes[event['address']] = event['present']
        elif kind == 'route':
            key = (event['mux'], event['channel'])
            old = self.routes.get(key, {})
            # Preserve last samples, but never show old samples as current presence.
            self.routes[key] = {**old, **event, 'verified_scan': self.scan}
        elif kind == 'scan_done':
            self.status = f"Detected {event['mux_count']}/{self.expected_muxes} MUXes and {event['sensor_count']}/{self.expected_ppgs} PPGs"
        elif kind == 'active':
            self.active = (event['mux'], event['channel'])
            self.active_state = event.get('state', 'SEARCHING')
            self.muxes[event['mux']] = True
            self.routes.setdefault(self.active, {}).update(present=True, verified_scan=self.scan)
        elif kind == 'sample':
            key = (event['mux'], event['channel'])
            # A dashboard can attach in the middle of a six-second probe.
            # Firmware emits samples only after identifying and selecting the route.
            self.muxes[event['mux']] = True
            if 'selected_channel' in event:
                self.continuous = True
                chosen = event['selected_channel']
                self.active = (event['mux'], chosen) if chosen >= 0 else None
                self.active_state = 'TRACKING' if chosen >= 0 else 'WAITING'
            elif 'state' in event:
                self.active = key
                self.active_state = event['state']
            if 'hz' in event:
                self.hz = event['hz']
            self.routes.setdefault(key, {}).update(event, observed=now,
                                                  present=True, verified_scan=self.scan)
        elif kind == 'frame':
            self.latest_frame = event
        elif kind == 'sensor_fault':
            self.status = f"PPG{event['channel'] + 1} fault: {event['reason']}"
        elif kind == 'probe_done':
            key = (event['mux'], event['channel'])
            self.routes.setdefault(key, {}).update(result=event)
            self.active = None
        elif kind == 'status':
            state = event['state']
            if state == 'BOOT':
                self.muxes.clear(); self.routes.clear(); self.active = None
            if state == 'BLOCKED':
                self.active = None
            message = f"{state}: {event['message']}"
            if state == 'SEARCHING' and event['message'].endswith('NO_CONTACT'):
                message = 'Waiting for finger contact and a usable pulse'
            # Keep the actual blocking reason visible during the retry countdown.
            if not (state == 'WAIT' and self.status.startswith('BLOCKED:')):
                self.status = message
        if kind in ('status', 'probe_done', 'scan_done'):
            # Keep rapid empty-sensor checks in the capture, not in the visible
            # event history: they are background discovery, not a selection.
            if kind == 'probe_done' and event.get('ok') and event.get('contact_samples') == 0:
                return
            if kind == 'status' and event['state'] == 'SEARCHING' and event['message'].endswith('NO_CONTACT'):
                return
            self.events.append(f"{event['state']}: {event['message']}" if kind == 'status'
                               else json.dumps(event, separators=(',', ':')))
            self.events = self.events[-4:]

    def lines(self, port, log, now=None):
        now = time.monotonic() if now is None else now
        telemetry_age = None if self.last_event is None else now - self.last_event
        live = self.link == 'Connected' and telemetry_age is not None and telemetry_age < 3
        detected = sorted(key for key, row in self.routes.items()
                          if row.get('present') and row.get('verified_scan') == self.scan)
        selection = 'Selected PPG: none — waiting for finger contact and a usable pulse'
        selected = live and self.active_state == 'TRACKING' and self.active in detected
        candidate = live and self.active_state == 'VALIDATING' and self.active in detected
        if selected or candidate:
            mux, channel = self.active
            label = self.labels.get(f'0x{mux:02X}:{channel}', f'PPG{detected.index(self.active) + 1}')
            if selected:
                interrupted = self.routes[self.active].get('quality') != 'USABLE_ESTIMATE'
                selection = f'Selected PPG: {label} | ' + ('recovering signal' if interrupted else 'TRACKING usable pulse')
            else:
                selection = f'Selected PPG: none | Finger detected on {label}; validating pulse'
        elif not live:
            selection = 'Selected PPG: unknown — no fresh telemetry'
        lines = [
            f'TEAM18 | {self.expected_muxes}-MUX / {self.expected_ppgs}-PPG BENCH DASHBOARD',
            f'USB: {port} | {self.link} | bus: {self.hz or "--"} Hz',
            f'Telemetry age: {telemetry_age:.1f}s' if telemetry_age is not None else 'Telemetry age: --',
            'Mode: all four sampling continuously; one source per outgoing packet' if self.continuous
                else 'Mode: rapid contact search -> pulse validation -> single-sensor tracking',
            'MUX addresses: ' + (', '.join(f'0x{a:02X}={"ACK" if p else "missing"}'
                                         for a, p in sorted(self.muxes.items())) or 'awaiting scan'),
            self.status,
            selection,
            (f"Output: PPG{self.latest_frame['channel'] + 1} | packet #{self.latest_frame['seq']} | "
             + ('valid' if self.latest_frame['usable'] else 'invalid readings') + ' | '
             + ('BLE connected' if self.latest_frame['ble_connected'] else 'BLE not connected'))
                if self.latest_frame else 'Output: awaiting packet telemetry',
            '',
            'PPG / position         MUX  CH  State       Contact* Quality*          HR*  SpO2*  IR*      Age',
            '-' * 99,
        ]
        for i, key in enumerate(detected, 1):
            row = self.routes[key]
            label_key = f'0x{key[0]:02X}:{key[1]}'
            label = self.labels.get(label_key, f'PPG{i} (provisional)')
            age = None if 'observed' not in row else now - row['observed']
            active = live and key == self.active
            failed = row.get('result', {}).get('ok') is False
            if not live or (self.continuous and (age is None or age > 1.5)):
                state = 'STALE'
            elif self.continuous:
                state = 'TRACKING' if active else row.get('state', 'WAITING')
            elif active and self.active_state in ('VALIDATING', 'TRACKING'):
                state = self.active_state
            elif failed:
                state = 'FAULT'
            else:
                state = 'IDLE' if selected or candidate else 'WAITING'
            contact = '--' if age is None else 'YES' if row.get('contact') else 'NO'
            quality = row.get('quality', '--')
            show_vitals = (self.continuous and state in ('READY', 'TRACKING') or active and selected) and row.get('quality') == 'USABLE_ESTIMATE'
            hr = '--' if not show_vitals or row.get('hr') is None else f"{row['hr']:.1f}"
            spo2 = '--' if not show_vitals or row.get('spo2') is None else str(row['spo2'])
            lines.append(f'{label[:22]:22}  {key[0]:02X}   {key[1]}   {state:10}  {contact:7}  '
                         f'{quality:16} {hr:>5} {spo2:>6} {str(row.get("ir", "--")):>8} '
                         + ('--' if age is None else f'{age:5.1f}s'))
        if not detected:
            lines.append('No PPG routes verified in the current scan. No sensor values can be displayed.')
        for i in range(len(detected) + 1, self.expected_ppgs + 1):
            lines.append(f'PPG slot {i}: UNMAPPED — address/channel and physical position not verified')
        lines.extend(['', '* All sensors have live readings; only the selected source feeds output.' if self.continuous
                       else '* Idle rows contain LAST observations, not live finger contact.',
                      'Contact uses provisional IR >= 100000; quality uses Luis\'s estimator.',
                      'USABLE_ESTIMATE is a software check; accuracy needs a reference measurement.',
                      f'Log: {log}', f'Ignored non-JSON lines: {self.parse_errors}',
                      'Recent events:'] + self.events + ['Press q or Ctrl+C to close. ESP32 diagnostics continue running.'])
        return lines

    def mapping(self):
        detected = sorted(key for key, row in self.routes.items()
                          if row.get('present') and row.get('verified_scan') == self.scan)
        return {
            'topology': 'single_mux_on_gpio21_22_from_photos_and_schematic',
            'expected_mux_count': self.expected_muxes, 'expected_sensor_count': self.expected_ppgs,
            'bus_hz': self.hz,
            'mux_addresses': [f'0x{a:02X}' for a, present in sorted(self.muxes.items()) if present],
            'sensors': [{'provisional_id': f'PPG{i}', 'mux': f'0x{mux:02X}', 'channel': channel,
                         'physical_position': self.labels.get(f'0x{mux:02X}:{channel}')}
                        for i, (mux, channel) in enumerate(detected, 1)],
            'status': self.status,
        }


def open_serial(port):
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = termios.tcgetattr(fd)
        attrs = termios.tcgetattr(fd)
        attrs[0] = attrs[1] = attrs[3] = 0
        attrs[2] = termios.CLOCAL | termios.CREAD | termios.CS8
        attrs[4] = attrs[5] = termios.B115200
        attrs[6][termios.VMIN] = attrs[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        return fd, previous
    except BaseException:
        os.close(fd)
        raise


def close_serial(fd, previous):
    try:
        termios.tcsetattr(fd, termios.TCSANOW, previous)
    except OSError:
        pass
    os.close(fd)


def run(args, screen=None):
    labels = json.loads(Path(args.labels).read_text()) if args.labels else {}
    model = Dashboard(labels)
    start = time.monotonic()
    fd = previous = None
    buffer = b''
    next_connect = 0
    if screen is not None:
        screen.nodelay(True)
        try: curses.curs_set(0)
        except curses.error: pass
    with open(args.log, 'a', encoding='utf-8') as log:
        try:
            while args.duration is None or time.monotonic() - start < args.duration:
                now = time.monotonic()
                if screen is not None and screen.getch() in (ord('q'), ord('Q')):
                    break
                if fd is None and now >= next_connect:
                    try:
                        fd, previous = open_serial(args.port)
                        model.link = 'Connected'
                        buffer = b''
                    except OSError as error:
                        model.link = f'USB unavailable: {error.strerror}'
                        next_connect = now + 2
                if fd is not None:
                    try:
                        if select.select([fd], [], [], 0.1)[0]:
                            data = os.read(fd, 8192)
                            if not data: raise OSError(errno.ENODEV, 'Device disconnected')
                            buffer += data
                            if len(buffer) > 65536:
                                buffer = b''; model.parse_errors += 1
                            while b'\n' in buffer:
                                raw, buffer = buffer.split(b'\n', 1)
                                try:
                                    event = json.loads(raw.decode('utf-8'))
                                    if not isinstance(event, dict): raise ValueError('Not an object')
                                    # Raw firmware events are stored with receive timestamps.
                                    log.write(json.dumps({'received_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                                          'event': event}) + '\n')
                                    log.flush()
                                    model.ingest(event)
                                    if args.map_out and event.get('event') in ('scan_done', 'status'):
                                        Path(args.map_out).write_text(json.dumps(model.mapping(), indent=2) + '\n')
                                except (ValueError, UnicodeError, KeyError, TypeError):
                                    model.parse_errors += 1
                    except OSError as error:
                        close_serial(fd, previous); fd = None
                        model.active = None
                        model.link = f'USB disconnected: {error.strerror}'
                        next_connect = now + 2
                else:
                    time.sleep(0.1)
                if screen is not None:
                    screen.erase()
                    height, width = screen.getmaxyx()
                    for y, line in enumerate(model.lines(args.port, args.log)[:height-1]):
                        try: screen.addnstr(y, 0, line, max(0, width-1))
                        except curses.error: pass
                    screen.refresh()
        finally:
            if fd is not None: close_serial(fd, previous)
    result = '\n'.join(model.lines(args.port, args.log)) + '\n'
    if args.snapshot: Path(args.snapshot).write_text(result)
    if screen is None: print(result, end='')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', default='/dev/ttyUSB0')
    parser.add_argument('--labels', help='JSON mapping of 0x70:0 keys to physical labels')
    parser.add_argument('--log', default='/tmp/team18-ppg-dashboard-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.jsonl')
    parser.add_argument('--duration', type=float, help='Stop after this many seconds')
    parser.add_argument('--headless', action='store_true', help='Capture without a terminal screen')
    parser.add_argument('--snapshot', help='Write final dashboard text to this path')
    parser.add_argument('--map-out', help='Write detected route mapping as JSON; physical labels remain unknown until confirmed')
    args = parser.parse_args()
    try:
        if args.headless: run(args)
        else: curses.wrapper(lambda screen: run(args, screen))
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError) as error:
        parser.exit(1, f'Dashboard error: {error}\n')


if __name__ == '__main__':
    main()
