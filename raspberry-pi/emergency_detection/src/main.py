"""Entry point for the Raspberry Pi detection prototype.

This is the main program for the branch RASPI-ALGORITHM.
It asks the user for a testing profile once at startup, then streams automatic sample
updates until a critical state is detected or the user stops the process. This is a
simulation-only prototype and is not connected to live Pi hardware yet.
"""

import json
import time

from classifier import classify_sample
from profile_collector import ask_user_profile
from simulator import generate_random_sample


def compact_state_icon(result: dict) -> str:
    """Return a short emoji state indicator for the console display."""
    state = result.get('state')
    if state == 'CRITICAL':
        return '🚨 CRITICAL'
    if state == 'WARNING':
        return '⚠️ WARNING'
    return '✅ STABLE'


def print_live_value(sample: dict, result: dict):
    """Print only the current reading and the compact state label.

    The user does not need the full JSON dump or the detailed reason codes during this
    testing phase. The goal is to watch a single live value and see the current status.
    """
    print(
        f"{compact_state_icon(result)} | HR={sample.get('heart_rate_bpm')} BPM | SpO2={sample.get('spo2_percent')}%"
    )

    if result.get('state') == 'CRITICAL':
        print('🚨🚨🚨 ACTIVE VOICE RECOGNITION STARTED!! 🚨🚨🚨')


def main():
    """Run the automatic live simulation workflow for local testing."""
    profile = ask_user_profile()
    print('\nProfile loaded for this testing session:')
    print(json.dumps({
        'age': profile['age'],
        'sex': profile['sex'],
        'height_cm': profile['height_cm'],
        'weight_kg': profile['weight_kg'],
        'bmi': profile['bmi'],
        'medical_conditions': profile['medical_conditions'],
    }, indent=2))

    print('\nLive simulation started. Press Ctrl+C to stop manually.')

    while True:
        sample = generate_random_sample(profile)
        # Finger detection is retained in the internal data model for future Pi integration,
        # but it is intentionally omitted from the live terminal view for this testing stage.
        sample['finger_detected'] = True
        result = classify_sample(sample, profile)
        print_live_value(sample, result)

        if result.get('state') == 'CRITICAL':
            print('Stopping simulation: critical state reached.')
            break

        time.sleep(1)


if __name__ == '__main__':
    main()
