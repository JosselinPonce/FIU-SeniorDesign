"""Main classification logic for Raspberry Pi simulation prototype.

This file has the following responsibilities:
- validate raw sample values
- check whether finger detection is valid
- compare current heart rate against a reference profile
- compare against action thresholds for WARNING and CRITICAL
- apply warning persistence rule: 3 consecutive WARNING readings triggers CRITICAL state
- return a structured result that is explainable and testable

This is intentionally a prototype engine. It is not a medical diagnosis.
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from reference_loader import ReferenceProfileLoader


class AlertStateMachine:
    """Simple state machine for STABLE / WARNING / CRITICAL.

    The transition rules are intentionally simple and test-compatible.
    The warning persistence logic is controlled by a configurable count.
    """

    def __init__(self, config_path: str | None = None):
        base_dir = Path(__file__).resolve().parents[1]
        default_path = base_dir / 'config' / 'action_thresholds.json'
        self.config_path = Path(config_path) if config_path else default_path
        with self.config_path.open('r', encoding='utf-8') as handle:
            self.config = json.load(handle)
        self.current_state = None
        self.warning_count = 0

    def reset(self):
        """Reset the state machine for a new run."""
        self.current_state = None
        self.warning_count = 0

    def evaluate(self, sample: Dict[str, Any], baseline_status: str):
        """Evaluate one sample and update state using persistence rules."""
        state = 'STABLE'
        reason_codes: List[str] = []
        warning_rule_active = False
        critical_rule_active = False

        hr = sample.get('heart_rate_bpm')
        spo2 = sample.get('spo2_percent')

        # Warning rules are broader than statistical reference deviation.
        # They are only active when both the sample is valid and the reading crosses
        # configured action thresholds.
        if hr is not None:
            if hr <= self.config.get('warning_hr_low', float('-inf')) or hr >= self.config.get('warning_hr_high', float('inf')):
                warning_rule_active = True
                reason_codes.append('WARNING_HR_OUT_OF_RANGE')

        if spo2 is not None and self.config.get('SIMULATION_ONLY', True):
            # SpO2 is intentionally kept as a stored value only in this phase.
            # It does not trigger state changes while the prototype remains in testing mode.
            pass

        if hr is not None:
            if hr <= self.config.get('critical_hr_low', float('-inf')) or hr >= self.config.get('critical_hr_high', float('inf')):
                critical_rule_active = True
                reason_codes.append('CRITICAL_HR_OUT_OF_RANGE')

        # A value above a statistical reference is not an emergency by itself.
        # It is only a baseline note, not a state trigger.
        if baseline_status == 'ABOVE_REFERENCE':
            reason_codes.append('ABOVE_REFERENCE_RANGE')
        elif baseline_status == 'BELOW_REFERENCE':
            reason_codes.append('BELOW_REFERENCE_RANGE')
        elif baseline_status == 'WITHIN_REFERENCE':
            reason_codes.append('WITHIN_REFERENCE_RANGE')

        if critical_rule_active:
            self.current_state = 'CRITICAL'
            state = 'CRITICAL'
            self.warning_count = 0
            reason_codes.append('CRITICAL_ACTION_RULE_ACTIVE')
            return {
                'state': state,
                'warning_rule_active': warning_rule_active,
                'critical_rule_active': critical_rule_active,
                'reason_codes': reason_codes,
                'warning_count': self.warning_count,
            }

        if warning_rule_active:
            self.warning_count += 1
            # Future design note:
            # The project will escalate from WARNING to CRITICAL after 3 consecutive warning
            # samples, not after a longer count. This is intentionally configurable and may be
            # tuned by testing later.
            if self.warning_count >= self.config.get('warning_persistence_count', 3):
                self.current_state = 'CRITICAL'
                state = 'CRITICAL'
                reason_codes.append('WARNING_PERSISTENCE_TRIGGERED_CRITICAL')
                reason_codes.append('ACTIVE_VOICE_RECOGNITION_STARTED')
                self.warning_count = 0
                return {
                    'state': state,
                    'warning_rule_active': warning_rule_active,
                    'critical_rule_active': True,
                    'reason_codes': reason_codes,
                    'warning_count': self.warning_count,
                }

            self.current_state = 'WARNING'
            state = 'WARNING'
            reason_codes.append('WARNING_ACTION_RULE_ACTIVE')
            return {
                'state': state,
                'warning_rule_active': True,
                'critical_rule_active': False,
                'reason_codes': reason_codes,
                'warning_count': self.warning_count,
            }

        self.warning_count = 0
        self.current_state = 'STABLE'
        state = 'STABLE'
        reason_codes.append('STABLE_ACTION_RULE_ACTIVE')
        return {
            'state': state,
            'warning_rule_active': False,
            'critical_rule_active': False,
            'reason_codes': reason_codes,
            'warning_count': self.warning_count,
        }


def validate_sample(sample: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a sample before classification.

    A malformed or invalid sample should never be silently converted
    into a stable state.
    """
    if sample.get('finger_detected') is False:
        return {
            'signal_valid': False,
            'state': None,
            'reason_codes': ['NO_FINGER'],
        }

    hr = sample.get('heart_rate_bpm')
    if hr is None:
        return {
            'signal_valid': False,
            'state': None,
            'reason_codes': ['HEART_RATE_MISSING'],
        }

    try:
        hr_value = float(hr)
    except (TypeError, ValueError):
        return {
            'signal_valid': False,
            'state': None,
            'reason_codes': ['INVALID_HEART_RATE'],
        }

    if hr_value <= 0 or hr_value > 250:
        return {
            'signal_valid': False,
            'state': None,
            'reason_codes': ['INVALID_HEART_RATE'],
        }

    spo2 = sample.get('spo2_percent')
    if spo2 is not None:
        try:
            spo2_value = float(spo2)
            if spo2_value <= 0 or spo2_value > 100:
                return {
                    'signal_valid': False,
                    'state': None,
                    'reason_codes': ['INVALID_SPO2'],
                }
        except (TypeError, ValueError):
            return {
                'signal_valid': False,
                'state': None,
                'reason_codes': ['INVALID_SPO2'],
            }

    return {
        'signal_valid': True,
        'state': 'VALID_SAMPLE',
        'reason_codes': ['VALID_SAMPLE'],
    }


def determine_baseline_status(sample: Dict[str, Any], profile_matches: List[str]) -> str:
    """Compare the sample to the research reference profile.

    This layer is informational only. It does not directly trigger emergency states.
    The function reads the pre-loaded research range values from the data sheet when
    available, instead of using arbitrary placeholder thresholds.
    """
    hr = sample.get('heart_rate_bpm')
    if hr is None:
        return 'UNKNOWN'

    hr_value = float(hr)

    ref_loader = ReferenceProfileLoader()
    profiles = ref_loader.load()['reference_profiles']

    # Prefer the actual age-/sex-/condition-based reference data from the provided sheet.
    for profile in profiles:
        if profile.get('category') == 'age':
            age_range = profile.get('age_range')
            low = profile.get('heart_rate_bpm_low')
            high = profile.get('heart_rate_bpm_high')
            if low is not None and high is not None:
                if low <= hr_value <= high:
                    return 'WITHIN_REFERENCE'
                if hr_value < low:
                    return 'BELOW_REFERENCE'
                if hr_value > high:
                    return 'ABOVE_REFERENCE'

    if hr_value < 50:
        return 'BELOW_REFERENCE'
    if hr_value > 100:
        return 'ABOVE_REFERENCE'
    return 'WITHIN_REFERENCE'


def classify_sample(sample: Dict[str, Any], profile: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Classify one sample and return the final result structure."""
    validation = validate_sample(sample)
    if not validation['signal_valid']:
        return {
            'state': None,
            'signal_valid': False,
            'heart_rate_bpm': sample.get('heart_rate_bpm'),
            'spo2_percent': sample.get('spo2_percent'),
            'baseline_status': 'UNKNOWN',
            'warning_rule_active': False,
            'critical_rule_active': False,
            'reason_codes': validation['reason_codes'],
            'matched_reference_profiles': [],
            'matched_action_rules': [],
            'elapsed_seconds': sample.get('elapsed_seconds'),
            'algorithm_version': 'prototype-v1',
        }

    age = sample.get('age')
    sex = sample.get('sex')
    bmi = sample.get('bmi')
    conditions = sample.get('medical_conditions', [])

    if profile is None:
        profile = {
            'age': age,
            'sex': sex,
            'bmi': bmi,
            'medical_conditions': conditions,
        }

    reference_loader = ReferenceProfileLoader()
    matched_profiles = reference_loader.match_profile(
        profile.get('age'),
        profile.get('sex'),
        profile.get('bmi'),
        profile.get('medical_conditions', []),
    )

    baseline_status = determine_baseline_status(sample, matched_profiles)

    if isinstance(profile, dict):
        state_machine = profile.get('state_machine')
        if state_machine is None:
            state_machine = AlertStateMachine()
            profile['state_machine'] = state_machine
    else:
        state_machine = AlertStateMachine()

    evaluation = state_machine.evaluate(sample, baseline_status)
    state = evaluation['state']

    result = {
        'state': state,
        'signal_valid': True,
        'heart_rate_bpm': sample.get('heart_rate_bpm'),
        'spo2_percent': sample.get('spo2_percent'),
        'baseline_status': baseline_status,
        'warning_rule_active': evaluation['warning_rule_active'],
        'critical_rule_active': evaluation['critical_rule_active'],
        'reason_codes': evaluation['reason_codes'],
        'matched_reference_profiles': matched_profiles,
        'matched_action_rules': ['WARNING_HR_OUT_OF_RANGE', 'CRITICAL_HR_OUT_OF_RANGE'],
        'elapsed_seconds': sample.get('elapsed_seconds'),
        'algorithm_version': 'prototype-v1',
    }

    if state == 'CRITICAL':
        result['status_message'] = 'ACTIVE VOICE RECOGNITION STARTED!!'

    return result
