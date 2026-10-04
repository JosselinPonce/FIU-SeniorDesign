"""Exercise the actual ESP32 sketch with a simulated bus; no hardware needed."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest


class TestMux(unittest.TestCase):
    @unittest.skipUnless(shutil.which("g++"), "g++ required")
    def test_firmware_selection_and_faults(self):
        source = pathlib.Path(__file__).with_name("test_mux_host.cpp")
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            # The harness supplies Arduino/BLE types; satisfy sketch includes.
            for name in ("Wire.h", "MAX30105.h", "spo2_algorithm.h", "BLEDevice.h",
                         "BLEServer.h", "BLEUtils.h", "BLE2902.h"):
                (root / name).write_text("")
            binary = root / "mux-test"
            subprocess.run(["g++", "-std=c++11", "-O2", "-I", tmp,
                            str(source), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True, capture_output=True)
