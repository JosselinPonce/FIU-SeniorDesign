#!/usr/bin/env python3
"""Decode PPG_SERIAL_RAW=1 serial logs to CSV; verify each packet's CRC.

Usage: python3 system/esp32/decode_serial_capture.py capture.log > samples.csv
Non-RAW status lines are ignored. Malformed RAW lines/packets are errors.
"""
import argparse
import csv
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'common'))
from ppg_protocol import decode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log', type=Path)
    args = parser.parse_args()
    writer = csv.writer(sys.stdout)
    writer.writerow(['ppg', 'seq', 'frame_start_ms', 'sample_offset_ms', 'red', 'ir',
                     'bpm', 'spo2', 'flags', 'quality'])
    for lineno, line in enumerate(args.log.read_text(errors='replace').splitlines(), 1):
        if not line.startswith('RAW '):
            continue
        match = re.fullmatch(r'RAW ppg=([1-4]) ([0-9a-fA-F]+)', line)
        if not match:
            raise ValueError(f'Invalid RAW line at {lineno}')
        frame = decode(bytes.fromhex(match[2]))
        for sample in frame.samples:
            writer.writerow([match[1], frame.seq, frame.start_ms, sample.dt_ms,
                             sample.red, sample.ir, frame.heart_rate, frame.spo2,
                             frame.flags, frame.quality])


if __name__ == '__main__':
    main()
