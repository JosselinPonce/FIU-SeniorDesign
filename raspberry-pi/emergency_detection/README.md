# Raspberry Pi Physiological-State Detection Prototype

This branch is intentionally limited to the Raspberry Pi detection engine.

Scope for this branch:
- connect to simulated or manually injected readings
- validate the sample
- compare with medically informed reference ranges
- classify the sample as STABLE / WARNING / CRITICAL
- support a warning persistence rule for repeated warning readings
- keep the network/Supabase/mobile app work out of scope for now

Important design notes:
- The reference data is a statistical or population-based comparison layer.
- The action thresholds are separate and are used for state classification.
- A value above a statistical reference point does not automatically become danger.
- In this prototype, warning persistence is configurable and should be adjusted in tests.

Future storage strategy (not implemented in this prototype):
- Instead of storing every sample, store only summary values such as peak, average, and the
  moments when a trigger condition occurs.
- Store only a limited amount of recent raw data in the ESP layer to avoid memory bloat.
- Delete older readings after aggregation, keeping only compact summaries for the database.
- Keep a small number of representative drive recordings for model-context building.
- The warning-to-critical escalation rule is set to 3 consecutive warnings for this phase.
