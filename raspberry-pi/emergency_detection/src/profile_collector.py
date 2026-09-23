"""Interactive profile collection for local testing only.

This file is intentionally separated from the Pi runtime design.
The purpose is to collect age, sex, weight, BMI, and medical conditions
at startup in a simulation environment so we can test classification logic.
"""

import re
from typing import List


def sanitize_numeric_input(raw_value: str) -> str:
    """Remove shell formatting artifacts like stray backslashes before conversion."""
    cleaned = raw_value.strip().replace('\\', '').replace('\n', '').replace('\r', '')
    return cleaned


def parse_float_input(prompt: str) -> float:
    """Prompt and convert a numeric value while tolerating pasted copy artifacts."""
    raw_value = input(prompt)
    cleaned = sanitize_numeric_input(raw_value)
    if cleaned == '':
        raise ValueError('Input cannot be empty.')
    return float(cleaned)


def derive_bmi(height_cm: float, weight_kg: float) -> float:
    """Compute BMI from height in centimeters and weight in kilograms.

    This keeps the testing flow practical because the user generally knows their height and
    weight, but not their BMI value itself.
    """
    if height_cm <= 0 or weight_kg <= 0:
        raise ValueError("Height and weight must be positive values.")

    height_m = height_cm / 100.0
    bmi = weight_kg / (height_m ** 2)
    return round(bmi, 2)


def ask_user_profile() -> dict:
    """Prompt the user for the initial testing profile.

    This should only be used during software testing and simulation.
    It is not intended for the real Pi deployment flow.
    """

    print("\n=== TESTING PROFILE INPUT ===")
    print("This is a local simulation profile. It is not used for real Pi deployment.")

    age = int(sanitize_numeric_input(input("Age: ")))
    sex = input("Sex (male/female/other): ").strip().lower() or None
    height_cm = parse_float_input("Height (cm): ")
    weight_kg = parse_float_input("Weight (kg): ")
    bmi = derive_bmi(height_cm, weight_kg)

    print("Medical conditions options:")
    print("1) no_reported_condition")
    print("2) hypertension")
    print("3) diabetes")
    print("4) asthma")
    print("5) copd")
    print("6) arrhythmia")
    print("7) coronary_artery_disease")
    print("8) other")

    selections = input(
        "Enter condition codes separated by commas (example: 2,3): "
    ).strip()

    options = {
        "1": "no_reported_condition",
        "2": "hypertension",
        "3": "diabetes",
        "4": "asthma",
        "5": "copd",
        "6": "arrhythmia",
        "7": "coronary_artery_disease",
        "8": "other",
    }

    medical_conditions: List[str] = []
    if selections:
        for value in selections.split(','):
            key = value.strip()
            if key in options:
                medical_conditions.append(options[key])

    return {
        "age": age,
        "sex": sex,
        "height_cm": height_cm,
        "weight_kg": weight_kg,
        "bmi": bmi,
        "medical_conditions": medical_conditions,
    }
