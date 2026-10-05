"""Known-rate physiological waveform tests for the diagnostic time basis."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest


class TestSampleClock(unittest.TestCase):
    @unittest.skipUnless(shutil.which('g++'), 'g++ required')
    def test_timing_bias_rollover_and_reset(self):
        source = pathlib.Path(__file__).with_name('test_sample_clock_host.cpp')
        with tempfile.TemporaryDirectory() as tmp:
            binary = pathlib.Path(tmp) / 'sample-clock-test'
            subprocess.run(['g++', '-std=c++11', '-O2', str(source), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True, capture_output=True)
