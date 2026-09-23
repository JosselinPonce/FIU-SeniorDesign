"""Model definitions for the Raspberry Pi physiological-state detection prototype.

This module intentionally keeps data structures simple and explainable.
It is designed for prototype testing and random input simulation.
"""

from dataclasses import dataclass, field
from typing import List, Optional, Any


@dataclass
class UserProfile:
    """User profile collected once at startup for testing.

    This is only a testing-time profile for simulation and replay workflows.
    The real Pi implementation will eventually receive profile data from the phone,
    but this branch asks for it at launch so we can classify from research-informed
    profiles during development.
    """

    age: Optional[int] = None
    sex: Optional[str] = None
    weight: Optional[float] = None
    bmi: Optional[float] = None
    medical_conditions: List[str] = field(default_factory=list)


@dataclass
class Sample:
    """Single physiologic sample from a simulated or replayed input stream."""

    heart_rate_bpm: Optional[float] = None
    spo2_percent: Optional[float] = None
    finger_detected: Optional[bool] = None
    signal_quality: Optional[float] = None
    elapsed_seconds: Optional[float] = None
    age: Optional[int] = None
    sex: Optional[str] = None
    weight: Optional[float] = None
    bmi: Optional[float] = None
    medical_conditions: Optional[List[str]] = None
    raw: Optional[Any] = None


@dataclass
class ClassificationResult:
    """Structured result returned by the classifier for explainability."""

    state: Optional[str]
    signal_valid: bool
    heart_rate_bpm: Optional[float]
    spo2_percent: Optional[float]
    baseline_status: str
    warning_rule_active: bool
    critical_rule_active: bool
    reason_codes: List[str]
    matched_reference_profiles: List[str]
    matched_action_rules: List[str]
    elapsed_seconds: Optional[float]
    algorithm_version: str = 'prototype-v1'
