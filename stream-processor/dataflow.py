import os
import logging
import httpx
from datetime import datetime, timedelta, timezone
from bytewax import operators as op
from bytewax.dataflow import Dataflow
from bytewax.connectors.stdio import StdOutSink
from bytewax.operators import windowing as win
from bytewax.operators.windowing import SystemClock, TumblingWindower

from rabbit_source import RabbitSource
from telemetry_parser import parse_trace, parse_log

# Configuration
DASHBOARD_URL = "http://localhost:8000"
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

flow = Dataflow("otel-anomaly-detection")

# Source
stream = op.input("rabbitmq-stream", flow, RabbitSource("otel-telemetry"))

# Parsing
parsed_traces = op.flat_map("parse-traces", stream, parse_trace)
parsed_logs = op.flat_map("parse-logs", stream, parse_log)

# Bytewax 0.20 Windowing API Globals
clock = SystemClock()
align_to = datetime(2023, 1, 1, tzinfo=timezone.utc)
window_cfg = TumblingWindower(length=timedelta(seconds=10), align_to=align_to)

# Anomaly Scorer Mock
class AnomalyScorer:
    def score(self, duration):
        return 0.95 if duration > 500 else 0.05

scorers = {}

def apply_anomaly_score(item):
    svc = item["service_name"]
    if svc not in scorers: scorers[svc] = AnomalyScorer()
    score = scorers[svc].score(item["duration_ms"])
    item["anomaly_score"] = score
    item["is_anomaly"] = score > 0.5
    return item

scored_spans = op.map("score-spans", parsed_traces, apply_anomaly_score)

# --- Unified Trace Reconstruction & Metrics ---
def get_trace_id_key(span):
    return span["trace_id"]

def build_full_trace():
    return {
        "duration_ms": 0,
        "spans": [],
        "has_anomaly": False,
        "start_time": None
    }

def fold_full_trace(stats, span):
    start_time = span.get("start_time") or datetime.now(timezone.utc).isoformat()
    stats["spans"].append({
        "name": span.get("route", "unknown"),
        "service": span.get("service_name", "unknown"),
        "duration_ms": span.get("duration_ms", 0),
        "start_time": start_time,
        "trace_id": span.get("trace_id", "unknown"),
        "is_anomaly": span.get("is_anomaly", False)
    })
    # Estimate total trace duration
    stats["duration_ms"] = max(stats["duration_ms"], span.get("duration_ms", 0))
    if span.get("is_anomaly"):
        stats["has_anomaly"] = True
    if not stats["start_time"] or start_time < stats["start_time"]:
        stats["start_time"] = start_time
    return stats

def merge_full_trace(s1, s2):
    return {
        "duration_ms": max(s1["duration_ms"], s2["duration_ms"]),
        "spans": s1["spans"] + s2["spans"],
        "has_anomaly": s1["has_anomaly"] or s2["has_anomaly"],
        "start_time": s1["start_time"] if (not s2["start_time"] or (s1["start_time"] and s1["start_time"] < s2["start_time"])) else s2["start_time"]
    }

keyed_by_trace = op.key_on("key-by-trace", scored_spans, get_trace_id_key)
trace_reconstructor = win.fold_window("window-reconstruct", keyed_by_trace, clock, window_cfg, build_full_trace, fold_full_trace, merge_full_trace)

def send_to_dashboard(path, payload):
    try:
        with httpx.Client() as client:
            client.post(f"{DASHBOARD_URL}{path}", json=payload, timeout=1.0)
    except Exception as e:
        logger.error(f"Failed to send to dashboard: {e}")

# --- Log Buffer for Anomaly Correlation ---
# Logs are buffered by trace_id in memory. When a trace window closes:
#   - If anomalous: flush buffered logs to the dashboard backend
#   - If normal: discard the buffered logs
log_buffer = {}  # trace_id -> list of log dicts
LOG_BUFFER_MAX_PER_TRACE = 50

def process_full_trace(item):
    trace_id, (metadata, stats) = item
    if not stats["spans"]: return item

    # 1. Send to Trace Inventory (Forensics) + correlated logs
    if stats["has_anomaly"]:
        send_to_dashboard("/api/traces", {
            "trace_id": trace_id,
            "duration_ms": stats["duration_ms"],
            "spans": stats["spans"]
        })
        # Flush correlated logs for this anomalous trace
        correlated_logs = log_buffer.pop(trace_id, [])
        for log in correlated_logs:
            send_to_dashboard("/api/logs", log)
        logger.info(f"Flushed {len(correlated_logs)} correlated logs for anomalous trace {trace_id[:12]}")
    else:
        # Discard buffered logs for non-anomalous traces
        log_buffer.pop(trace_id, None)

    # 2. Extract and emit Service Metrics
    services_seen = set(s["service"] for s in stats["spans"])
    for svc in services_seen:
        svc_spans = [s for s in stats["spans"] if s["service"] == svc]
        avg_latency = sum(s["duration_ms"] for s in svc_spans) / len(svc_spans)

        # Throughput
        send_to_dashboard("/api/metrics", {
            "service": svc,
            "metric_type": "throughput",
            "value": float(len(svc_spans)),
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        # Latency
        send_to_dashboard("/api/metrics", {
            "service": svc,
            "metric_type": "p99_latency",
            "value": float(avg_latency),
            "timestamp": datetime.now(timezone.utc).isoformat()
        })

        # Alerts if anomaly
        if any(s["is_anomaly"] for s in svc_spans):
            send_to_dashboard("/api/alerts", {
                "service": svc,
                "route": svc_spans[0]["name"],
                "anomaly_score": 1.0,
                "is_anomaly": True,
                "duration_ms": avg_latency,
                "trace_id": trace_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "spans": svc_spans[:10]
            })

    return item

op.map("emit-trace-data", trace_reconstructor.down, process_full_trace)

# --- Log Buffering + Redaction Logic ---
def handle_log_with_redaction(state, log):
    """Counts redactions and buffers logs by trace_id for anomaly correlation."""
    if state is None:
        state = {"redaction_count": 0}

    # 1. Redaction counting (existing logic preserved)
    body = log.get("body", "")
    if any(p in body for p in ["[REDACTED_EMAIL]", "[REDACTED_AUTHOR]"]):
        state["redaction_count"] += 1
        if state["redaction_count"] % 5 == 0:
            send_to_dashboard("/api/metrics", {
                "service": log.get("service_name", "unknown"),
                "metric_type": "redaction_count",
                "value": float(state["redaction_count"]),
                "timestamp": datetime.now(timezone.utc).isoformat()
            })

    # 2. Buffer logs by trace_id (only if trace_id present)
    trace_id = log.get("trace_id", "")
    if trace_id:
        if trace_id not in log_buffer:
            log_buffer[trace_id] = []
        if len(log_buffer[trace_id]) < LOG_BUFFER_MAX_PER_TRACE:
            log_buffer[trace_id].append({
                "trace_id": trace_id,
                "span_id": log.get("span_id", ""),
                "service_name": log.get("service_name", "unknown"),
                "body": body,
                "severity": log.get("severity", "INFO"),
                "timestamp": log.get("timestamp", datetime.now(timezone.utc).isoformat())
            })

    return (state, state)

log_keyed = op.key_on("key-log-svc", parsed_logs, lambda x: x.get("service_name", "unknown"))
op.stateful_map("log-handler", log_keyed, handle_log_with_redaction)

op.output("stdout", trace_reconstructor.down, StdOutSink())
