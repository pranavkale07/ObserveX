#!/usr/bin/env python3
"""
ObserverAI Traffic Generator

Usage:
    python trigger_traffic.py                    # Default: 60s mixed traffic
    python trigger_traffic.py --duration 120     # Run for 2 minutes
    python trigger_traffic.py --mode anomaly     # Only slow/anomalous requests
    python trigger_traffic.py --mode normal      # Only normal requests
    python trigger_traffic.py --mode pii         # Only PII redaction requests
    python trigger_traffic.py --mode all         # All endpoint types
    python trigger_traffic.py --rps 5            # 5 requests per second
"""

import argparse
import requests
import time
import random
import sys
import threading
from datetime import datetime

GATEWAY = "http://localhost:3001"

ENDPOINTS = {
    "normal":  {"url": f"{GATEWAY}/api/proxy-quote",      "label": "Normal Quote"},
    "slow":    {"url": f"{GATEWAY}/api/proxy-slow-quote",  "label": "Slow (Anomaly)"},
    "n_plus_1":{"url": f"{GATEWAY}/api/proxy-n-plus-1",   "label": "N+1 Pattern"},
    "pii":     {"url": f"{GATEWAY}/api/proxy-pii",         "label": "PII Redaction"},
}

MODE_ENDPOINTS = {
    "normal":  ["normal"],
    "anomaly": ["slow", "n_plus_1"],
    "pii":     ["pii"],
    "all":     ["normal", "slow", "n_plus_1", "pii"],
    "mixed":   ["normal", "normal", "normal", "slow", "n_plus_1"],  # weighted: 60% normal, 20% slow, 20% n+1
}

# Stats
stats = {"total": 0, "success": 0, "errors": 0, "latencies": []}
stats_lock = threading.Lock()


def send_request(endpoint_key):
    ep = ENDPOINTS[endpoint_key]
    try:
        start = time.time()
        resp = requests.get(ep["url"], timeout=10)
        latency = (time.time() - start) * 1000
        with stats_lock:
            stats["total"] += 1
            stats["success"] += 1
            stats["latencies"].append(latency)
        status = f"\033[32m{resp.status_code}\033[0m"
        print(f"  [{datetime.now().strftime('%H:%M:%S')}] {ep['label']:20s} {status}  {latency:7.0f}ms")
    except requests.exceptions.ConnectionError:
        with stats_lock:
            stats["total"] += 1
            stats["errors"] += 1
        print(f"  [{datetime.now().strftime('%H:%M:%S')}] {ep['label']:20s} \033[31mCONNECTION REFUSED\033[0m")
    except Exception as e:
        with stats_lock:
            stats["total"] += 1
            stats["errors"] += 1
        print(f"  [{datetime.now().strftime('%H:%M:%S')}] {ep['label']:20s} \033[31mERROR: {e}\033[0m")


def print_summary():
    print("\n==========================================")
    print("  Traffic Generation Summary")
    print("==========================================")
    print(f"  Total Requests:  {stats['total']}")
    print(f"  Successful:      \033[32m{stats['success']}\033[0m")
    print(f"  Errors:          \033[31m{stats['errors']}\033[0m")
    if stats["latencies"]:
        lats = sorted(stats["latencies"])
        avg = sum(lats) / len(lats)
        p50 = lats[len(lats) // 2]
        p99 = lats[int(len(lats) * 0.99)]
        print(f"  Avg Latency:     {avg:.0f}ms")
        print(f"  P50 Latency:     {p50:.0f}ms")
        print(f"  P99 Latency:     {p99:.0f}ms")
    print("==========================================")


def main():
    parser = argparse.ArgumentParser(description="ObserverAI Traffic Generator")
    parser.add_argument("--duration", type=int, default=60, help="Duration in seconds (default: 60)")
    parser.add_argument("--mode", choices=["normal", "anomaly", "pii", "all", "mixed"], default="mixed", help="Traffic mode (default: mixed)")
    parser.add_argument("--rps", type=float, default=2, help="Requests per second (default: 2)")
    args = parser.parse_args()

    endpoint_pool = MODE_ENDPOINTS[args.mode]
    interval = 1.0 / args.rps

    print(f"Traffic Generator Started")
    print(f"  Mode:     {args.mode}")
    print(f"  Duration: {args.duration}s")
    print(f"  RPS:      {args.rps}")
    print(f"  Endpoints: {', '.join(set(endpoint_pool))}")
    print("------------------------------------------")

    start_time = time.time()
    try:
        while time.time() - start_time < args.duration:
            endpoint_key = random.choice(endpoint_pool)
            send_request(endpoint_key)
            elapsed = time.time() - start_time
            remaining = args.duration - elapsed
            if remaining > 0 and remaining > interval:
                time.sleep(interval)
    except KeyboardInterrupt:
        print("\nStopped by user.")

    print_summary()


if __name__ == "__main__":
    main()
