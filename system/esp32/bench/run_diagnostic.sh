#!/usr/bin/env bash
# Editor-independent MUX-first diagnostic upload/dashboard launcher.
set -euo pipefail
BENCH_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ESP_DIR="$(dirname -- "$BENCH_DIR")"
ACTION="${1:-dashboard}"
PORT="${2:-/dev/ttyUSB0}"
CLI="${ARDUINO_CLI:-$(command -v arduino-cli || true)}"
[[ -n "$CLI" ]] || CLI="$HOME/.local/bin/arduino-cli"
FQBN="esp32:esp32:esp32:FlashFreq=40,FlashMode=dio"
case "$ACTION" in
  flash)
    [[ -x "$CLI" ]] || { echo "Arduino CLI not found: $CLI" >&2; exit 1; }
    [[ -r "$PORT" && -w "$PORT" ]] || { echo "USB port absent or inaccessible: $PORT" >&2; exit 1; }
    "$CLI" compile --fqbn "$FQBN" --build-property "compiler.cpp.extra_flags=-I$ESP_DIR/ppg_transmitter" "$ESP_DIR/mux_diagnostic"
    "$CLI" upload --fqbn "$FQBN" -p "$PORT" "$ESP_DIR/mux_diagnostic"
    echo "Continuous-acquisition transmitter installed with dashboard telemetry; single BLE stream enabled. Start: bash $BENCH_DIR/run_diagnostic.sh dashboard $PORT"
    ;;
  dashboard)
    exec python3 "$BENCH_DIR/dashboard.py" --port "$PORT"
    ;;
  restore)
    exec bash "$ESP_DIR/flash_esp32.sh" "$PORT"
    ;;
  *) echo "Usage: bash $0 {flash|dashboard|restore} [/dev/ttyUSB0]" >&2; exit 2 ;;
esac
