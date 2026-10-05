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
        self.assertIn('all four sampling continuously', output)

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


if __name__ == '__main__':
    unittest.main()
