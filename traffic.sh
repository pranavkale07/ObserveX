#!/bin/bash

# ══════════════════════════════════════════════════════════════════
#  ObserveX Synthetic Traffic Generator
# ══════════════════════════════════════════════════════════════════
#  Generates traffic matching the statistical models from the paper:
#    "ObserveX: A Cognitive Observability Pipeline" (Section V & VI.A)
#
#  Traffic Profile:
#    Normal:   80%  — Poisson inter-arrivals (λ=10/s), log-normal latency
#    N+1:      10%  — 1 parent + U(50,100) child DB spans
#    Bimodal:   5%  — Mixture fast (µ=100ms) / slow (µ=2000ms), ratio 0.2
#    PII:       5%  — Redaction density probing
#
#  Usage:
#    ./traffic.sh                          # 60s paper-profile at λ=10 RPS
#    ./traffic.sh 120                      # 120s mixed traffic
#    ./traffic.sh 60 anomaly              # 60s anomalous traffic only
#    ./traffic.sh 30 pii                  # 30s PII redaction traffic
#    ./traffic.sh 180 burst               # 180s ramping 20→100 RPS
#    ./traffic.sh 60 mixed 10             # 60s paper distribution at λ=10
#    ./traffic.sh 0 mixed 10 1000         # Corpus mode: exactly 1000 traces
#    ./traffic.sh 60 mixed 10 0 --concurrent  # High-throughput concurrent mode
#
#  Modes: mixed (default), normal, anomaly, pii, all, burst
# ══════════════════════════════════════════════════════════════════

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="$PROJECT_DIR/venv/bin/python"

DURATION="${1:-60}"
MODE="${2:-mixed}"
RPS="${3:-10}"
CORPUS="${4:-0}"
shift 4 2>/dev/null
EXTRA_ARGS="$@"

echo "══════════════════════════════════════════"
echo "  ObserveX Synthetic Traffic Generator"
echo "══════════════════════════════════════════"
echo "  Duration: ${DURATION}s | Mode: ${MODE} | RPS(λ): ${RPS}"
if [ "$CORPUS" -gt 0 ] 2>/dev/null; then
    echo "  Corpus:   ${CORPUS} traces (overrides duration)"
fi
echo "══════════════════════════════════════════"

CMD="$PYTHON $PROJECT_DIR/trigger_traffic.py --duration $DURATION --mode $MODE --rps $RPS"

if [ "$CORPUS" -gt 0 ] 2>/dev/null; then
    CMD="$CMD --corpus $CORPUS"
fi

if echo "$EXTRA_ARGS" | grep -q "\-\-concurrent"; then
    CMD="$CMD --concurrent"
fi

exec $CMD
