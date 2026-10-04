# FIU-SeniorDesign — Biometric Steering Wheel (Team 18)

> **Branch: `samantha/multi-ppg`.** The multi-PPG documentation below describes this branch only. Luis’s original guide is retained as the ecosystem reference.

A steering wheel that watches the driver's heart rate and blood oxygen. It
learns what is normal for each driver, and checks in by voice when something
stays unusual. **Student prototype — not a medical device.**

```
4 MAX30102 --MUX/I2C--> ESP32 --BLE--> Raspberry Pi 5 --BLE--> iPhone app --cellular--> Supabase --> website
100 Hz PPG         472-byte        logs + relays          stores, flags,       database,        live dashboard
                   packet/s        verbatim               voice check          storage
```

## Multi-PPG implementation

The ESP32 now selects one of four PPG modules through a TCA9548A MUX and
retains the existing single-source packet format. Firmware starts automatically
when powered; development and flashing use Luis's terminal workflow.

- **[Multi-PPG technical guide (PDF)](docs/Team18_Multi_PPG_Implementation_Guide.pdf)**
- [Editable guide](docs/MULTI_PPG_IMPLEMENTATION_GUIDE.md)
- [ESP32 README and terminal commands](system/esp32/README.md)

The guide explains every implementation file, the distinction between raw
samples and result frames, the observed delay before accepted readings, and
why `-999?` changed to `--` only in USB diagnostics. The earlier multi-PPG
notes are consolidated into this edition. Luis's original ecosystem guide
remains available below.

**Current verification boundary:** four-channel selection and contact switching
were exercised. Some accepted vitals remain inconsistent; measurement accuracy
and live ESP32 → Pi → phone delivery have not been verified in this extension.

## Start here

| If you are… | Read |
|---|---|
| on the team | **[docs/Team18_System_Guide.pdf](docs/Team18_System_Guide.pdf)** (source: [docs/SYSTEM_GUIDE.md](docs/SYSTEM_GUIDE.md)): every subsystem, the algorithms and their sources, setup on any Linux, tests, results, troubleshooting |
| an AI coding agent | **[HANDOFF.md](HANDOFF.md)**: repository map, contracts that must not break, gotchas, current state, rules |
| looking for the live dashboard | https://smart-wheel-dashboard.vercel.app |

## Repository

| Folder | What | Tests |
|---|---|---|
| `system/esp32/` | ESP32 firmware (Arduino C++): sensor FIFO, heart rate + SpO₂ estimator, protocol v3 packets over BLE | `system/tests/` (C++ host tests) |
| `system/pi/` | Raspberry Pi relay (Python/asyncio), terminal dashboard, one-shot installer | `cd system && python3 -m unittest discover -s tests` |
| `system/laptop/` | Bench viewer (PySide6) | — |
| `mobile-app/` | Expo / React Native app: drivers, drives, flag engine, voice check, learning, sync | `cd mobile-app && npm test && npm run typecheck` |
| `mobile-app/supabase/` | Database migrations — run in order: `schema` → `live` → `v3_dashboard` → `v4_flags` → `v5_delete` → `v6_quality` → `v7_history`. Or run **`apply_all.sql`** (all seven in one file), **`revert_all.sql`** (removes everything we added, keeps the team's `test_readings`) and **`legacy_samantha.sql`** (makes the database serve the older `samantha/mobile-app-setup` app, alongside ours or after a revert) | `npm run test:sql` proves the round trip on Postgres 18 |
| `mobile-app/tools/` | `intent/` trains the offline yes/no voice model · `tuning/` team tuning report (`npm run tune`) | — |
| `website/` | Vite dashboard: live drives, history, drivers and how their thresholds adapted, waveform unfolding | `npm run build` |
| `docs/` | Team guide (Markdown + PDF) and the PDF builder | — |

## Quick commands

```
cd mobile-app && npm ci && npm test            # 53 app tests (protocol vs firmware, codec, flags, voice, learning)
cd system && python3 -m unittest discover -s tests   # 21 protocol/firmware tests
system/esp32/flash_esp32.sh /dev/ttyUSB0       # flash the ESP32 (needs arduino-cli; see the guide)
cd website && npm ci && npm run dev            # dashboard (needs website/.env)
cd mobile-app && npm run tune                  # team tuning report from Supabase
```

The iPhone app is built by GitHub Actions (`.github/workflows/ios-build.yml`)
as an unsigned `.ipa` and sideloaded with a free Apple ID. See the guide, §7.

`mobile-app/App.supabase.tsx.bak` keeps the team's original Supabase test
screen, unchanged.
