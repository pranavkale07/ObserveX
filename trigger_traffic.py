#!/usr/bin/env python3
"""
ObserveX Synthetic Traffic Generator
=====================================
Generates traffic matching the statistical models described in:
  "ObserveX: A Cognitive Observability Pipeline" (Section V & VI.A)

Traffic Profile (from paper):
  - Normal traces:   Poisson inter-arrivals (λ=10/s), log-normal latency
  - N+1 traces:      1 parent + U(50,100) child DB spans
  - Bimodal traces:  Mixture of fast (µ=100ms) and slow (µ=2000ms), ratio 0.2
  - PII traces:      Redaction density probing

Corpus distribution: 80% normal, 10% N+1, 5% bimodal, 5% PII
RPS range: 20-100 req/s (default 10/s = paper's λ)

Usage:
    python trigger_traffic.py                          # Default: 60s research-profile traffic
    python trigger_traffic.py --duration 120           # Run for 2 minutes
    python trigger_traffic.py --mode mixed             # Paper distribution (80/10/5/5)
    python trigger_traffic.py --mode normal            # Only normal requests
    python trigger_traffic.py --mode anomaly           # N+1 + bimodal anomalies
    python trigger_traffic.py --mode pii               # PII redaction probing
    python trigger_traffic.py --mode all               # All endpoints equally
    python trigger_traffic.py --mode burst             # Ramp 20→100 RPS over duration
    python trigger_traffic.py --rps 10                 # Poisson mean λ=10 req/s
    python trigger_traffic.py --corpus 1000            # Generate exactly 1000 traces then stop
"""

import argparse
import requests
import time
import random
import math
import sys
import threading
from datetime import datetime
from collections import defaultdict

# ── Gateway endpoint configuration ────────────────────────────────
GATEWAY = "http://localhost:3001"

ENDPOINTS = {
    "normal":   {"url": f"{GATEWAY}/api/proxy-quote",       "label": "Normal Quote"},
    "slow":     {"url": f"{GATEWAY}/api/proxy-slow-quote",  "label": "Bimodal (Slow)"},
    "n_plus_1": {"url": f"{GATEWAY}/api/proxy-n-plus-1",    "label": "N+1 Pattern"},
    "pii":      {"url": f"{GATEWAY}/api/proxy-pii",         "label": "PII Redaction"},
}

# ── Paper-specified traffic distributions ─────────────────────────
# Section V: "80% normal, 10% N+1, 10% bimodal"
# We split 10% bimodal into 5% bimodal + 5% PII for full coverage
MODE_DISTRIBUTIONS = {
    # Paper-faithful distribution (Section V, corpus of 1000 traces)
    "mixed": {
        "weights": {"normal": 0.80, "slow": 0.05, "n_plus_1": 0.10, "pii": 0.05},
    },
    "normal":  {"weights": {"normal": 1.0}},
    "anomaly": {"weights": {"slow": 0.50, "n_plus_1": 0.50}},
    "pii":     {"weights": {"pii": 1.0}},
    "all":     {"weights": {"normal": 0.25, "slow": 0.25, "n_plus_1": 0.25, "pii": 0.25}},
    # Burst mode: ramps RPS from 20→100 over the duration (Section VI.A)
    "burst":   {"weights": {"normal": 0.80, "slow": 0.05, "n_plus_1": 0.10, "pii": 0.05}},
}

# ── Stats tracking ────────────────────────────────────────────────
stats = {"total": 0, "success": 0, "errors": 0, "latencies": [], "per_type": defaultdict(int)}
stats_lock = threading.Lock()


def poisson_interval(lam):
    """
    Generate Poisson-distributed inter-arrival time.
    Paper Section V: "Poisson-distributed inter-arrivals (λ=10/s)"

    Uses inverse transform: -ln(U) / λ
    """
    return -math.log(1.0 - random.random()) / lam


def weighted_choice(weights):
    """Select an endpoint key based on the paper-specified distribution weights."""
    keys = list(weights.keys())
    vals = list(weights.values())
    return random.choices(keys, weights=vals, k=1)[0]


def send_request(endpoint_key):
    """Send a single HTTP request and track stats."""
    ep = ENDPOINTS[endpoint_key]
    try:
        start = time.time()
        resp = requests.get(ep["url"], timeout=30)
        latency = (time.time() - start) * 1000

        with stats_lock:
            stats["total"] += 1
            stats["success"] += 1
            stats["latencies"].append(latency)
            stats["per_type"][endpoint_key] += 1

        status_color = "\033[32m" if resp.status_code < 400 else "\033[33m"
        print(f"  [{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] "
              f"{ep['label']:20s} {status_color}{resp.status_code}\033[0m  "
              f"{latency:7.0f}ms")
    except requests.exceptions.ConnectionError:
        with stats_lock:
            stats["total"] += 1
            stats["errors"] += 1
            stats["per_type"][endpoint_key] += 1
        print(f"  [{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] "
              f"{ep['label']:20s} \033[31mCONNECTION REFUSED\033[0m")
    except requests.exceptions.Timeout:
        with stats_lock:
            stats["total"] += 1
            stats["errors"] += 1
            stats["per_type"][endpoint_key] += 1
        print(f"  [{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] "
              f"{ep['label']:20s} \033[31mTIMEOUT (>30s)\033[0m")
    except Exception as e:
        with stats_lock:
            stats["total"] += 1
            stats["errors"] += 1
            stats["per_type"][endpoint_key] += 1
        print(f"  [{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] "
              f"{ep['label']:20s} \033[31mERROR: {e}\033[0m")


def send_request_threaded(endpoint_key):
    """Fire a request in a background thread (non-blocking for high RPS)."""
    t = threading.Thread(target=send_request, args=(endpoint_key,), daemon=True)
    t.start()
    return t


def compute_burst_rps(elapsed, duration, rps_min=20, rps_max=100):
    """
    Linearly ramp RPS from rps_min to rps_max over the run duration.
    Paper Section VI.A: "20–100 requests/s"
    """
    progress = min(elapsed / duration, 1.0)
    return rps_min + (rps_max - rps_min) * progress


def print_summary(duration_actual):
    """Print a detailed traffic generation summary with per-type breakdown."""
    print("\n\033[1m==========================================\033[0m")
    print("\033[1m  ObserveX Traffic Generation Summary\033[0m")
    print("\033[1m==========================================\033[0m")
    print(f"  Actual Duration: {duration_actual:.1f}s")
    print(f"  Total Requests:  {stats['total']}")
    print(f"  Successful:      \033[32m{stats['success']}\033[0m")
    print(f"  Errors:          \033[31m{stats['errors']}\033[0m")
    if stats['total'] > 0:
        effective_rps = stats['total'] / max(duration_actual, 0.1)
        print(f"  Effective RPS:   {effective_rps:.1f}")

    # Per-type breakdown
    print("\n  \033[1mPer-Type Breakdown:\033[0m")
    for etype, count in sorted(stats["per_type"].items()):
        pct = (count / stats['total'] * 100) if stats['total'] > 0 else 0
        label = ENDPOINTS[etype]["label"]
        print(f"    {label:20s}  {count:5d}  ({pct:5.1f}%)")

    if stats["latencies"]:
        lats = sorted(stats["latencies"])
        avg = sum(lats) / len(lats)
        p50 = lats[len(lats) // 2]
        p95 = lats[int(len(lats) * 0.95)]
        p99 = lats[int(len(lats) * 0.99)]
        print(f"\n  \033[1mLatency Distribution:\033[0m")
        print(f"    Avg:  {avg:7.0f}ms")
        print(f"    P50:  {p50:7.0f}ms")
        print(f"    P95:  {p95:7.0f}ms")
        print(f"    P99:  {p99:7.0f}ms")
        print(f"    Min:  {lats[0]:7.0f}ms")
        print(f"    Max:  {lats[-1]:7.0f}ms")
    print("\033[1m==========================================\033[0m")


def main():
    parser = argparse.ArgumentParser(
        description="ObserveX Synthetic Traffic Generator (Paper-aligned)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Modes:
  mixed   - Paper distribution: 80%% normal, 10%% N+1, 5%% bimodal, 5%% PII
  normal  - 100%% normal requests
  anomaly - 50%% N+1 + 50%% bimodal (anomaly-only)
  pii     - 100%% PII redaction probing
  all     - 25%% each endpoint type
  burst   - Ramp RPS from 20→100 over duration (paper Section VI.A)

Examples:
  %(prog)s --duration 60 --mode mixed --rps 10     # Paper's λ=10/s Poisson
  %(prog)s --duration 120 --mode burst              # Ramp 20→100 RPS
  %(prog)s --corpus 1000 --mode mixed               # Generate exactly 1000 traces
        """
    )
    parser.add_argument("--duration", type=int, default=60,
                        help="Duration in seconds (default: 60)")
    parser.add_argument("--mode", choices=list(MODE_DISTRIBUTIONS.keys()), default="mixed",
                        help="Traffic mode (default: mixed)")
    parser.add_argument("--rps", type=float, default=10,
                        help="Mean requests/second — Poisson λ (default: 10, paper's λ)")
    parser.add_argument("--corpus", type=int, default=0,
                        help="Generate exactly N traces then stop (overrides --duration). "
                             "Paper uses 1000.")
    parser.add_argument("--concurrent", action="store_true",
                        help="Send requests concurrently (non-blocking, for high RPS)")
    args = parser.parse_args()

    dist = MODE_DISTRIBUTIONS[args.mode]
    is_burst = args.mode == "burst"
    use_corpus = args.corpus > 0

    print(f"\033[1m==========================================\033[0m")
    print(f"\033[1m  ObserveX Synthetic Traffic Generator\033[0m")
    print(f"\033[1m==========================================\033[0m")
    print(f"  Mode:         {args.mode}")
    if use_corpus:
        print(f"  Corpus Size:  {args.corpus} traces")
    else:
        print(f"  Duration:     {args.duration}s")
    if is_burst:
        print(f"  RPS:          20 → 100 (ramping)")
    else:
        print(f"  RPS (λ):      {args.rps} (Poisson inter-arrivals)")
    print(f"  Distribution: {', '.join(f'{k}={v*100:.0f}%' for k,v in dist['weights'].items())}")
    print(f"  Concurrent:   {'Yes' if args.concurrent else 'No'}")
    print(f"------------------------------------------")

    start_time = time.time()
    threads = []
    request_count = 0

    try:
        while True:
            elapsed = time.time() - start_time

            # Stop condition: corpus mode or duration mode
            if use_corpus:
                if request_count >= args.corpus:
                    break
            else:
                if elapsed >= args.duration:
                    break

            # Select endpoint from paper-specified distribution
            endpoint_key = weighted_choice(dist["weights"])

            # Compute current RPS (burst ramps, otherwise constant)
            if is_burst:
                current_rps = compute_burst_rps(elapsed, args.duration)
            else:
                current_rps = args.rps

            # Send request
            if args.concurrent:
                t = send_request_threaded(endpoint_key)
                threads.append(t)
            else:
                send_request(endpoint_key)

            request_count += 1

            # Poisson-distributed inter-arrival delay
            # Paper Section V: "Poisson-distributed inter-arrivals (λ=10/s)"
            delay = poisson_interval(current_rps)
            # Cap delay to avoid extremely long waits from Poisson tail
            delay = min(delay, 2.0 / current_rps)
            time.sleep(delay)

    except KeyboardInterrupt:
        print("\n\033[33mStopped by user (Ctrl+C).\033[0m")

    # Wait for outstanding threads
    if args.concurrent and threads:
        print(f"\n  Waiting for {len(threads)} outstanding requests...")
        for t in threads:
            t.join(timeout=5)

    duration_actual = time.time() - start_time
    print_summary(duration_actual)


if __name__ == "__main__":
    main()
