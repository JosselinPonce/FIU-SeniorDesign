"""Randomized simulation generator for the Raspberry Pi algorithm prototype.

This module is designed only for software testing.
It does not represent medically realistic patient data.
"""

import random
from typing import Dict, List


def generate_random_sample(profile: Dict[str, object]) -> Dict[str, object]:
    """Create a randomized sample based on the stored testing profile."""
    age = profile.get('age', 25)
    sex = profile.get('sex', 'female')
    bmi = profile.get('bmi', 22.0)
    conditions = profile.get('medical_conditions', [])

    # This is software-test randomization only.
    # It is not a clinical dataset and should not be treated as physiologically realistic.
    heart_rate = random.uniform(60, 120)
    spo2 = random.uniform(94, 100)

    if isinstance(age, int) and age > 60:
        heart_rate = random.uniform(55, 110)

    if sex == 'male':
        heart_rate = random.uniform(58, 112)

    if 'hypertension' in conditions:
        heart_rate = random.uniform(60, 115)

    if 'diabetes' in conditions:
        heart_rate = random.uniform(58, 118)

    if bmi and bmi >= 30:
        heart_rate = random.uniform(60, 120)

    return {
        'heart_rate_bpm': round(heart_rate, 2),
        'spo2_percent': round(spo2, 2),
        'finger_detected': True,
        'signal_quality': round(random.uniform(0.7, 0.99), 2),
        'elapsed_seconds': round(random.uniform(0.0, 120.0), 2),
        'age': age,
        'sex': sex,
        'bmi': bmi,
        'medical_conditions': conditions,
    }


def generate_warning_cluster(profile: Dict[str, object], count: int = 3) -> List[Dict[str, object]]:
    """Generate consecutive warning-level data for testing the persistence rule.

    The prototype is configured to escalate from WARNING to CRITICAL after three
    consecutive warning samples. This count is still configurable for future tuning.
    """
    samples = []
    for _ in range(count):
        sample = generate_random_sample(profile)
        sample['heart_rate_bpm'] = 95
        sample['spo2_percent'] = 96
        sample['signal_quality'] = 0.8
        samples.append(sample)
    return samples


def generate_critical_cluster(profile: Dict[str, object]) -> List[Dict[str, object]]:
    """Generate a critical-level sample for immediate critical classification."""
    sample = generate_random_sample(profile)
    sample['heart_rate_bpm'] = 130
    sample['spo2_percent'] = 92
    sample['signal_quality'] = 0.9
    return [sample]
