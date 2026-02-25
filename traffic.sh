#!/bin/bash

# ObserverAI Traffic Generator Wrapper
#
# Usage:
#   ./traffic.sh                  # 60s mixed traffic at 2 RPS
#   ./traffic.sh 120              # 120s mixed traffic
#   ./traffic.sh 60 anomaly       # 60s anomalous traffic only
#   ./traffic.sh 30 pii           # 30s PII redaction traffic
#   ./traffic.sh 180 all 5        # 180s all endpoints at 5 RPS
#
# Modes: mixed (default), normal, anomaly, pii, all

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="$PROJECT_DIR/venv/bin/python"

DURATION="${1:-60}"
MODE="${2:-mixed}"
RPS="${3:-2}"

echo "=========================================="
echo "  ObserverAI Traffic Generator"
echo "  Duration: ${DURATION}s | Mode: ${MODE} | RPS: ${RPS}"
echo "=========================================="

exec "$PYTHON" "$PROJECT_DIR/trigger_traffic.py" --duration "$DURATION" --mode "$MODE" --rps "$RPS"
