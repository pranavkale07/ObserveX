import os
import json
import time
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
from ml_scorer import ObserveXScorer
from detectors import (
    extract_features,
    CompositeScorer,
    RuleDetectorScorer,
    MLScorer,
    PIIDensityDetector,
    build_rule_flags,
    classify_anomaly,
)

# Configuration
DASHBOARD_URL = "http://localhost:8000"
SPAN_ANOMALY_MS = 500.0  # cosmetic per-span flag; trace-level verdict comes from scorer
WARMUP_JSONL = os.getenv(
    "OBSERVEX_WARMUP_JSONL",
    os.path.join(os.path.dirname(__file__), "synthetic_telemetry.jsonl"),
)

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

flow = Dataflow("otel-anomaly-detection")

# Source
stream = op.input("rabbitmq-stream", flow, RabbitSource("otel-telemetry"))

# Parsing
parsed_traces = op.flat_map("parse-traces", stream, parse_trace)
parsed_logs = op.flat_map("parse-logs", stream, parse_log)

# Bytewax 0.20 windowing
clock = SystemClock()
align_to = datetime(2023, 1, 1, tzinfo=timezone.utc)
window_cfg = TumblingWindower(length=timedelta(seconds=10), align_to=align_to)


# ---- ML warmup -------------------------------------------------------------

def _warmup_ml(path: str, scorer: ObserveXScorer) -> int:
    if not os.path.exists(path):
        logger.warning(f"Warmup corpus not found at {path}; ML scorer starts cold.")
        return 0
    count = 0
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            # Corpus is span-level; feed one row at a time.
            scorer.learn_one({
                "duration_ms": rec.get("duration_ms", 0),
                "span_count": 1,
                "error_rate": 0.0,
            })
            count += 1
    logger.info(f"ObserveXScorer warmed on {count} synthetic records from {path}")
    return count


# ---- Scorer wiring ---------------------------------------------------------
# One ML instance per worker process. Rule detectors own structural rules;
# MLScorer adapts ObserveXScorer to the Scorer interface. CompositeScorer
# unions their verdicts (max score, union of reasons, merged per-model).
ml_scorer = ObserveXScorer()
_warmup_ml(WARMUP_JSONL, ml_scorer)

rule_scorer = RuleDetectorScorer()
scorer = CompositeScorer([rule_scorer, MLScorer(ml_scorer)])
pii_detector = PIIDensityDetector()


# ---- Trace reconstruction --------------------------------------------------

def get_trace_id_key(span):
    return span["trace_id"]


def build_full_trace():
    return {"duration_ms": 0, "spans": [], "has_anomaly": False, "start_time": None}


def fold_full_trace(stats, span):
    start_time = span.get("start_time") or datetime.now(timezone.utc).isoformat()
    duration = span.get("duration_ms", 0)
    stats["spans"].append({
        "name": span.get("route", "unknown"),
        "service": span.get("service_name", "unknown"),
        "duration_ms": duration,
        "start_time": start_time,
        "trace_id": span.get("trace_id", "unknown"),
        "span_id": span.get("span_id", ""),
        "parent_span_id": span.get("parent_span_id", ""),
        "status_code": span.get("status_code", 0),
        "is_anomaly": duration > SPAN_ANOMALY_MS,
    })
    stats["duration_ms"] = max(stats["duration_ms"], duration)
    if duration > SPAN_ANOMALY_MS:
        stats["has_anomaly"] = True
    if not stats["start_time"] or start_time < stats["start_time"]:
        stats["start_time"] = start_time
    return stats


def merge_full_trace(s1, s2):
    return {
        "duration_ms": max(s1["duration_ms"], s2["duration_ms"]),
        "spans": s1["spans"] + s2["spans"],
        "has_anomaly": s1["has_anomaly"] or s2["has_anomaly"],
        "start_time": s1["start_time"] if (
            not s2["start_time"] or (s1["start_time"] and s1["start_time"] < s2["start_time"])
        ) else s2["start_time"],
    }


keyed_by_trace = op.key_on("key-by-trace", parsed_traces, get_trace_id_key)
trace_reconstructor = win.fold_window(
    "window-reconstruct",
    keyed_by_trace,
    clock,
    window_cfg,
    build_full_trace,
    fold_full_trace,
    merge_full_trace,
)

_http_client = httpx.Client(timeout=2.0)


def send_to_dashboard(path, payload):
    try:
        _http_client.post(f"{DASHBOARD_URL}{path}", json=payload)
    except Exception as e:
        logger.error(f"Failed to send to dashboard: {e}")


# ---- Log buffer for anomaly correlation ------------------------------------
log_buffer = {}
LOG_BUFFER_MAX_PER_TRACE = 50


def process_full_trace(item):
    trace_id, (metadata_tw, stats) = item
    spans = stats["spans"]
    if not spans:
        return item

    # 1. Extract features, run composite scorer, update ML online.
    features = extract_features(stats, spans)
    verdict = scorer.score(features, spans)
    ml_scorer.learn_one(features)  # continue learning from live traffic

    is_anom = verdict["is_anomaly"]
    reasons = verdict["reasons"]
    rule_flags = build_rule_flags(reasons, verdict.get("metadata", {}))
    ml_scores = verdict.get("per_model", {})
    anomaly_type = classify_anomaly(reasons, ml_scores) if is_anom else None

    # 2. Forensic inventory + correlated log flush for anomalous traces.
    if is_anom:
        send_to_dashboard("/api/traces", {
            "trace_id": trace_id,
            "duration_ms": stats["duration_ms"],
            "spans": spans,
        })
        correlated = log_buffer.pop(trace_id, [])
        for log in correlated:
            send_to_dashboard("/api/logs", log)
        logger.info(
            f"Anomalous trace {trace_id[:12]} type={anomaly_type} "
            f"reasons={reasons} score={verdict['score']:.2f} "
            f"logs_flushed={len(correlated)}"
        )
    else:
        log_buffer.pop(trace_id, None)

    # 3. Per-service throughput + p99.
    services_seen = {s["service"] for s in spans}
    for svc in services_seen:
        svc_spans = [s for s in spans if s["service"] == svc]
        durations = sorted(s["duration_ms"] for s in svc_spans)
        p99_index = max(0, int(len(durations) * 0.99) - 1)
        p99_latency = durations[p99_index]
        now_iso = datetime.now(timezone.utc).isoformat()
        send_to_dashboard("/api/metrics", {
            "service": svc, "metric_type": "throughput",
            "value": float(len(svc_spans)), "timestamp": now_iso,
        })
        send_to_dashboard("/api/metrics", {
            "service": svc, "metric_type": "p99_latency",
            "value": float(p99_latency), "timestamp": now_iso,
        })

    # 4. One enriched trace-level alert when anomalous.
    if is_anom:
        send_to_dashboard("/api/alerts", {
            "service": features["primary_service"],
            "route": spans[0]["name"],
            "anomaly_score": verdict["score"],
            "is_anomaly": True,
            "duration_ms": stats["duration_ms"],
            "trace_id": trace_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "spans": spans[:20],
            "reasons": reasons,
            "ml_scores": ml_scores,
            "rule_flags": rule_flags,
            "anomaly_type": anomaly_type,
        })

    return item


op.map("emit-trace-data", trace_reconstructor.down, process_full_trace)


# ---- Log handler: redaction counting + PII density + trace correlation -----

REDACTION_TOKENS = ("[REDACTED_EMAIL]", "[REDACTED_AUTHOR]", "[REDACTED_CC]")


def handle_log_with_redaction(state, log):
    if state is None:
        state = {"redaction_count": 0}

    body = log.get("body", "")
    service = log.get("service_name", "unknown")
    is_redacted = any(tok in body for tok in REDACTION_TOKENS)

    if is_redacted:
        state["redaction_count"] += 1
        if state["redaction_count"] % 5 == 0:
            send_to_dashboard("/api/metrics", {
                "service": service, "metric_type": "redaction_count",
                "value": float(state["redaction_count"]),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

    # PII density detector — paper §IV-C (security primitive).
    detection = pii_detector.observe(service, is_redacted)
    if detection:
        ratio = detection["redaction_ratio"]
        logger.warning(
            f"PII density breach: {service} ratio={ratio:.2f} "
            f"over {detection['window_log_count']} logs"
        )
        pii_rule_flags = {
            "n_plus_1": False, "n_plus_1_count": 0,
            "bimodal_latency": False, "latency_variance": 0.0,
            "dependency_break": False, "dangling_span": None,
            "pii_density": True, "redaction_ratio": ratio,
        }
        send_to_dashboard("/api/alerts", {
            "service": service,
            "route": "security.pii_density",
            "anomaly_score": ratio,
            "is_anomaly": True,
            "duration_ms": 0.0,
            "trace_id": log.get("trace_id") or f"pii-{service}-{int(time.time())}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "spans": [],
            "reasons": ["pii_redaction_density"],
            "ml_scores": {},
            "rule_flags": pii_rule_flags,
            "anomaly_type": "PII Redaction Density",
        })

    # Buffer log for trace correlation flush.
    trace_id = log.get("trace_id", "")
    if trace_id:
        if trace_id not in log_buffer:
            log_buffer[trace_id] = []
        if len(log_buffer[trace_id]) < LOG_BUFFER_MAX_PER_TRACE:
            log_buffer[trace_id].append({
                "trace_id": trace_id,
                "span_id": log.get("span_id", ""),
                "service_name": service,
                "body": body,
                "severity": log.get("severity", "INFO"),
                "timestamp": log.get("timestamp", datetime.now(timezone.utc).isoformat()),
            })

    return (state, log)


log_keyed = op.key_on("key-log-svc", parsed_logs, lambda x: x.get("service_name", "unknown"))
op.stateful_map("log-handler", log_keyed, handle_log_with_redaction)

op.output("stdout", trace_reconstructor.down, StdOutSink())
