"""Verify bench UI never mistakes missing/stale hardware for live sensor data."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'esp32' / 'bench' / 'dashboard.py'
spec = importlib.util.spec_from_file_location('bench_dashboard', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TestBenchDashboard(unittest.TestCase):
    def setUp(self):
        self.model = module.Dashboard()
        self.model.link = 'Connected'
        self.model.ingest({'event': 'scan_start', 'hz': 100000}, now=0)

    def test_no_mux_never_invents_four_connected_sensors(self):
        self.model.ingest({'event': 'status', 'state': 'BLOCKED', 'message': 'No MUX ACK'}, now=1)
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('No PPG routes verified', output)
        self.assertEqual(output.count('UNMAPPED'), 4)
        self.assertNotIn('PROBING', output)

    def add_sensor(self):
        self.model.ingest({'event': 'route', 'mux': 113, 'channel': 5, 'present': True}, now=1)
        self.model.ingest({'event': 'active', 'mux': 113, 'channel': 5}, now=1)
        self.model.ingest({'event': 'sample', 'mux': 113, 'channel': 5,
                           'contact': True, 'quality': 'COLLECTING', 'ir': 140000,
                           'hr': None, 'spo2': None}, now=1)

    def test_nondefault_mux_channel_and_invalid_vitals(self):
        self.add_sensor()
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('71   5', output)
        self.assertIn('WAITING', output)
        self.assertIn('Selected PPG: none', output)
        self.assertIn('COLLECTING', output)
        self.assertNotIn('-999', output)

    def test_stale_stream_is_not_live_probe(self):
        self.add_sensor()
        output = '\n'.join(self.model.lines('usb', 'log', now=10))
        self.assertIn('STALE', output)
        self.assertNotIn('PROBING', output)

    def test_rediscovery_does_not_reuse_previous_sensor_presence(self):
        self.add_sensor()
        self.model.ingest({'event': 'scan_start', 'hz': 400000}, now=2)
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('No PPG routes verified', output)
        self.assertNotIn('PPG1 (provisional)', output)

    def test_completed_probe_is_idle_with_last_observation(self):
        self.add_sensor()
        self.model.ingest({'event': 'probe_done', 'mux': 113, 'channel': 5, 'ok': True}, now=2)
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('WAITING', output)
        self.assertIn('LAST observations', output)

    def test_retry_countdown_keeps_blocking_reason_visible(self):
        self.model.ingest({'event': 'status', 'state': 'BLOCKED', 'message': 'Second MUX missing'}, now=1)
        self.model.ingest({'event': 'status', 'state': 'WAIT', 'message': 'Retry in five seconds'}, now=2)
        self.assertEqual(self.model.status, 'BLOCKED: Second MUX missing')
        self.assertIn('WAIT: Retry in five seconds', self.model.events)

    def test_attaching_mid_probe_displays_the_observed_route(self):
        self.model.ingest({'event': 'sample', 'mux': 112, 'channel': 2,
                           'ir': 1000, 'contact': False, 'quality': 'NO_CONTACT',
                           'hr': None, 'spo2': None}, now=1)
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('70   2', output)
        self.assertIn('NO_CONTACT', output)
        self.assertNotIn('No PPG routes verified', output)

    def test_reconnect_during_tracking_restores_state_from_sample(self):
        self.model.ingest({'event': 'sample', 'mux': 112, 'channel': 1,
                           'state': 'TRACKING', 'hz': 400000, 'ir': 200000,
                           'contact': True, 'quality': 'USABLE_ESTIMATE',
                           'hr': 80.0, 'spo2': 97}, now=1)
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('TRACKING', output)
        self.assertIn('400000 Hz', output)
        self.assertEqual(self.model.active, (112, 1))

    def test_empty_sensor_checks_never_select_a_probe(self):
        for channel in range(4):
            self.model.ingest({'event': 'sample', 'mux': 112, 'channel': channel,
                               'state': 'SEARCHING', 'contact': False,
                               'quality': 'NO_CONTACT', 'hr': None, 'spo2': None}, now=1)
            output = '\n'.join(self.model.lines('usb', 'log', now=2))
            self.assertIn('Selected PPG: none', output)
            self.assertNotIn('PROBING', output)
            self.assertNotIn('TRACKING usable pulse', output)

    def test_contact_alone_is_not_a_selected_probe(self):
        self.model.ingest({'event': 'sample', 'mux': 112, 'channel': 2,
                           'state': 'VALIDATING', 'contact': True,
                           'quality': 'COLLECTING', 'hr': None, 'spo2': None}, now=1)
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('Selected PPG: none | Finger detected', output)
        self.assertNotIn('TRACKING usable pulse', output)

    def test_background_ready_sensor_does_not_replace_stream_source(self):
        for channel, state in ((0, 'TRACKING'), (1, 'READY'), (2, 'WAITING')):
            self.model.ingest({'event': 'sample', 'mux': 112, 'channel': channel,
                               'selected_channel': 0, 'state': state,
                               'contact': channel < 2, 'quality': 'USABLE_ESTIMATE' if channel < 2 else 'NO_CONTACT',
                               'hr': 70.0 if channel < 2 else None, 'spo2': 99 if channel < 2 else None}, now=1)
        self.assertEqual(self.model.active, (112, 0))
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('Selected PPG: PPG1', output)
        self.assertIn('READY', output)
        self.assertIn('up to 4 sensors sampling continuously', output)

    def test_hot_handoff_is_reported_without_a_validating_state(self):
        for chosen in (0, 1):
            self.model.ingest({'event': 'sample', 'mux': 112, 'channel': chosen,
                               'selected_channel': chosen, 'state': 'TRACKING',
                               'contact': True, 'quality': 'USABLE_ESTIMATE',
                               'hr': 70.0, 'spo2': 99}, now=1)
        self.assertEqual(self.model.active, (112, 1))
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('Selected PPG: PPG2', output)
        self.assertNotIn('validating pulse', output)

    def test_six_sensors_on_physical_ports_two_through_seven(self):
        self.model.ingest({'event': 'scan_start', 'hz': 400000,
                           'expected_ppgs': 6}, now=1)
        for channel in range(2, 8):
            self.model.ingest({'event': 'route', 'mux': 112,
                               'channel': channel, 'present': True}, now=1)
            self.model.ingest({'event': 'sample', 'mux': 112, 'channel': channel,
                               'selected_channel': 7, 'state': 'READY',
                               'contact': True, 'quality': 'USABLE_ESTIMATE',
                               'hr': 70.0, 'spo2': 99}, now=1)
        self.model.ingest({'event': 'frame', 'channel': 7, 'seq': 10,
                           'usable': True, 'ble_connected': False}, now=1)
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('6-PPG BENCH DASHBOARD', output)
        self.assertIn('Selected PPG: PPG6', output)
        self.assertIn('Output: PPG6 | packet #10', output)
        self.assertNotIn('UNMAPPED', output)
        self.assertEqual([r['channel'] for r in self.model.mapping()['sensors']],
                         list(range(2, 8)))

    def test_late_attachment_learns_six_sources_without_startup_event(self):
        for channel in range(2, 8):
            self.model.ingest({'event': 'sample', 'mux': 112, 'channel': channel,
                               'selected_channel': -1, 'state': 'WAITING'}, now=1)
        self.assertEqual(self.model.expected_ppgs, 6)
        self.assertIn('6-PPG BENCH DASHBOARD',
                      '\n'.join(self.model.lines('usb', 'log', now=2)))

    def test_only_selected_finger_displays_vitals(self):
        for ch, state, hr in [(2, 'TRACKING', 71.0), (3, 'READY', 83.0)]:
            self.model.ingest({'event': 'sample', 'mux': 112, 'channel': ch,
                               'selected_channel': 2, 'state': state,
                               'contact': True, 'quality': 'USABLE_ESTIMATE',
                               'hr': hr, 'spo2': 98}, now=1)
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('71.0', output)
        self.assertNotIn('83.0', output)
        self.assertIn('READY', output)

    def test_invalid_raw_packets_are_not_shown_as_selected_readings(self):
        self.model.ingest({'event': 'sample', 'mux': 112, 'channel': 2,
                           'selected_channel': -1, 'state': 'WAITING',
                           'contact': False, 'quality': 'NO_CONTACT'}, now=1)
        self.model.ingest({'event': 'frame', 'channel': 2, 'seq': 1,
                           'usable': False, 'ble_connected': False}, now=1)
        output = '\n'.join(self.model.lines('usb', 'log', now=2))
        self.assertIn('Selected PPG: none', output)
        self.assertIn('INVALID raw fallback', output)

    def test_old_tracking_row_cannot_survive_selection_change(self):
        for ch in (2, 3):
            self.model.ingest({'event': 'sample', 'mux': 112, 'channel': ch,
                               'selected_channel': ch, 'state': 'TRACKING',
                               'contact': True, 'quality': 'USABLE_ESTIMATE',
                               'hr': 70.0, 'spo2': 98}, now=1)
        lines = self.model.lines('usb', 'log', now=2)
        tracking_rows = [line for line in lines if '(provisional)' in line and 'TRACKING' in line]
        self.assertEqual(len(tracking_rows), 1)
        self.assertIn('PPG2', tracking_rows[0])

    def test_raw_capture_handles_all_six_sources_without_selecting_one(self):
        for sensor in range(1, 7):
            event = module.decode_event_line(f'RAW ppg={sensor} 5aa50000'.encode())
            self.assertEqual(event['event'], 'raw_frame')
            self.assertEqual(event['ppg'], sensor)
            self.model.ingest(event, now=1)
            self.assertIsNone(self.model.active)
        self.assertEqual(module.decode_event_line(b'{"event":"frame","seq":3}')['seq'], 3)

    def test_raw_capture_rejects_malformed_or_unbounded_input(self):
        for line in [b'RAW ppg=7 abcd', b'RAW ppg=1 abc', b'RAW ppg=1 zzzz',
                     b'RAW ppg=1 ' + b'aa' * 1171]:
            with self.assertRaises(ValueError):
                module.decode_event_line(line)


if __name__ == '__main__':
    unittest.main()
