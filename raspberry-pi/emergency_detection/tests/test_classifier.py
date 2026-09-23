import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'src'
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from classifier import AlertStateMachine, classify_sample


def test_three_warning_samples_trigger_critical():
    machine = AlertStateMachine()
    profile = {'age': 25, 'sex': 'female', 'bmi': 22, 'medical_conditions': []}

    for _ in range(3):
        sample = {
            'heart_rate_bpm': 95,
            'spo2_percent': 96,
            'finger_detected': True,
            'signal_quality': 0.8,
            'age': 25,
            'sex': 'female',
            'bmi': 22,
            'medical_conditions': [],
        }
        result = classify_sample(sample, profile)

    assert result['state'] == 'CRITICAL'
    assert 'ACTIVE_VOICE_RECOGNITION_STARTED' in result['reason_codes']


def test_stable_value_is_stable():
    result = classify_sample({
        'heart_rate_bpm': 72,
        'spo2_percent': 98,
        'finger_detected': True,
        'signal_quality': 0.9,
        'age': 25,
        'sex': 'female',
        'bmi': 22,
        'medical_conditions': [],
    })
    assert result['state'] == 'STABLE'


def test_warning_value_is_warning():
    result = classify_sample({
        'heart_rate_bpm': 95,
        'spo2_percent': 96,
        'finger_detected': True,
        'signal_quality': 0.8,
        'age': 25,
        'sex': 'female',
        'bmi': 22,
        'medical_conditions': [],
    })
    assert result['state'] == 'WARNING'


def test_critical_value_is_critical():
    result = classify_sample({
        'heart_rate_bpm': 128,
        'spo2_percent': 94,
        'finger_detected': True,
        'signal_quality': 0.9,
        'age': 25,
        'sex': 'female',
        'bmi': 22,
        'medical_conditions': [],
    })
    assert result['state'] == 'CRITICAL'


def test_invalid_finger_is_not_classified():
    result = classify_sample({
        'heart_rate_bpm': 70,
        'spo2_percent': 98,
        'finger_detected': False,
        'signal_quality': 0.2,
        'age': 25,
        'sex': 'female',
        'bmi': 22,
        'medical_conditions': [],
    })
    assert result['state'] is None
    assert result['signal_valid'] is False
