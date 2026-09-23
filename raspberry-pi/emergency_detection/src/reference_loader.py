"""Loads the research-derived reference profile data.

This file intentionally separates reference data from action thresholds.
The goal is to compare current measurements to population reference values
without converting those values into emergency decisions.
"""

import json
from pathlib import Path


class ReferenceProfileLoader:
    """Read reference profiles from the JSON configuration file."""

    def __init__(self, config_path: str | None = None):
        base_dir = Path(__file__).resolve().parents[1]
        default_path = base_dir / 'config' / 'reference_profiles.json'
        self.config_path = Path(config_path) if config_path else default_path

    def load(self):
        """Load the reference profile configuration."""
        with self.config_path.open('r', encoding='utf-8') as handle:
            return json.load(handle)

    def match_profile(self, age: int | None, sex: str | None, bmi: float | None, conditions: list[str] | None):
        """Find the relevant reference profiles for the current user.

        The matching is intentionally simple and explainable.
        It uses the actual age ranges from the research reference table instead of
        placeholder assumptions.
        """
        data = self.load()['reference_profiles']
        matches = []

        def age_in_range(value: int, range_text: str | None) -> bool:
            if range_text is None:
                return False
            range_text = range_text.strip()
            if range_text.startswith('>'):
                lower = float(range_text[1:].strip())
                return value > lower
            if '-' in range_text:
                low_text, high_text = range_text.split('-', 1)
                low = float(low_text.strip())
                high = float(high_text.strip())
                return low <= value <= high
            return False

        if age is not None:
            for profile in data:
                if profile.get('category') == 'age':
                    group = profile.get('group')
                    age_range = profile.get('age_range')
                    if group is None:
                        continue
                    if age_in_range(age, age_range):
                        matches.append(f"AGE_{group.upper()}")

        if sex is not None:
            normalized_sex = sex.lower()
            for profile in data:
                if profile.get('category') == 'sex' and profile.get('group') == normalized_sex:
                    matches.append(f"SEX_{normalized_sex.upper()}")

        if bmi is not None:
            if bmi < 18.5:
                pass
            elif 18.5 <= bmi < 25:
                matches.append('BMI_18_25')
            elif 25 <= bmi < 30:
                matches.append('BMI_25_30')
            elif bmi >= 30:
                matches.append('BMI_30_PLUS')

        if conditions:
            for condition in conditions:
                for profile in data:
                    if profile.get('category') == 'condition' and profile.get('group') == condition:
                        matches.append(f"CONDITION_{condition.upper()}")

        return matches
