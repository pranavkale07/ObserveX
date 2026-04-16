"""Feature extraction, rule detectors, ML adapter, and composition.

Scorer contract (all implementations return this shape):
    {
        "score":     float in [0,1],          # aggregate severity
        "is_anomaly": bool,
        "reasons":   List[str],                # machine-readable tags
        "metadata":  Dict[str, Any] (optional), # numeric detail per reason
        "per_model": Dict[str, float] (optional), # ML sub-model scores
    }

Rule detectors map to §IV of the paper:
  - N+1 Query Regression (Chebyshev bound on span count)
  - Bimodal Latency (EWMA variance, eq. 2)
  - Dangling Parent (dependency-chain break)
  - PII Redaction Density (§IV-C, log-stream — separate class)
"""
import math
import time
import logging
from abc import ABC, abstractmethod
from collections import deque
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


def extract_features(trace_stats: Dict, spans: List[Dict]) -> Dict:
    """Derive the feature vector consumed by every Scorer."""
    if not spans:
        return {
            "duration_ms": 0.0,
            "span_count": 0,
            "error_rate": 0.0,
            "primary_service": "unknown",
        }

    errors = sum(1 for s in spans if s.get("status_code", 0) not in (0, 1))

    per_svc = {}
    for s in spans:
        svc = s.get("service", "unknown")
        per_svc[svc] = per_svc.get(svc, 0.0) + s.get("duration_ms", 0.0)
    primary = max(per_svc, key=per_svc.get) if per_svc else "unknown"

    return {
        "duration_ms": float(trace_stats.get("duration_ms", 0.0)),
        "span_count": len(spans),
        "error_rate": errors / len(spans),
        "primary_service": primary,
    }


class Scorer(ABC):
    @abstractmethod
    def score(self, features: Dict, spans: List[Dict]) -> Dict: ...


class RuleDetectorScorer(Scorer):
    """Three deterministic trace-level detectors with online rolling stats."""

    N_PLUS_1_K = 3
    N_PLUS_1_WARMUP = 10
    N_PLUS_1_FLOOR = 10

    BIMODAL_LAMBDA = 0.2
    BIMODAL_STD_MS = 500.0
    BIMODAL_MEAN_MIN_MS = 200.0
    BIMODAL_WARMUP = 10

    def __init__(self):
        self._span_count_stats: Dict[str, Dict[str, float]] = {}
        self._latency_ewma: Dict[str, Dict[str, float]] = {}

    def score(self, features: Dict, spans: List[Dict]) -> Dict:
        reasons: List[str] = []
        metadata: Dict = {}
        service = features["primary_service"]

        if self._check_n_plus_1(service, features["span_count"]):
            reasons.append("n_plus_1")
            metadata["n_plus_1_count"] = features["span_count"]

        pre_var = self._latency_ewma.get(service, {}).get("var", 0.0)
        if self._check_bimodal(service, features["duration_ms"]):
            reasons.append("bimodal_latency")
            metadata["latency_variance"] = pre_var

        dangling = self._find_dangling_span(spans)
        if dangling:
            reasons.append("dangling_parent")
            metadata["dangling_span"] = dangling

        return {
            "score": 1.0 if reasons else 0.0,
            "is_anomaly": bool(reasons),
            "reasons": reasons,
            "metadata": metadata,
        }

    def _check_n_plus_1(self, service: str, span_count: int) -> bool:
        stats = self._span_count_stats.setdefault(
            service, {"n": 0, "mean": 0.0, "m2": 0.0}
        )
        fire = False
        if stats["n"] >= self.N_PLUS_1_WARMUP and span_count >= self.N_PLUS_1_FLOOR:
            variance = stats["m2"] / (stats["n"] - 1) if stats["n"] > 1 else 0.0
            std = math.sqrt(variance)
            if span_count > stats["mean"] + self.N_PLUS_1_K * std:
                fire = True
        stats["n"] += 1
        delta = span_count - stats["mean"]
        stats["mean"] += delta / stats["n"]
        stats["m2"] += delta * (span_count - stats["mean"])
        return fire

    def _check_bimodal(self, service: str, duration_ms: float) -> bool:
        state = self._latency_ewma.setdefault(
            service, {"n": 0, "mean": 0.0, "var": 0.0, "seeded": 0}
        )
        fire = False
        if state["n"] >= self.BIMODAL_WARMUP and state["seeded"]:
            std = math.sqrt(state["var"])
            if std > self.BIMODAL_STD_MS and state["mean"] > self.BIMODAL_MEAN_MIN_MS:
                fire = True
        if not state["seeded"]:
            state["mean"] = duration_ms
            state["var"] = 0.0
            state["seeded"] = 1
        else:
            delta = duration_ms - state["mean"]
            state["var"] = (
                self.BIMODAL_LAMBDA * (delta * delta)
                + (1 - self.BIMODAL_LAMBDA) * state["var"]
            )
            state["mean"] += self.BIMODAL_LAMBDA * delta
        state["n"] += 1
        return fire

    def _find_dangling_span(self, spans: List[Dict]) -> Optional[str]:
        span_ids = {s.get("span_id") for s in spans if s.get("span_id")}
        for s in spans:
            parent = s.get("parent_span_id") or ""
            if not parent:
                continue
            if parent not in span_ids:
                return s.get("name", "unknown")
        return None


class MLScorer(Scorer):
    """Adapter that plugs an ObserveXScorer (or any score_one/learn_one model)
    into the `Scorer` contract. Does not call learn_one — the owner of the
    ML instance is responsible for online updates."""

    def __init__(self, ml_model):
        self.ml = ml_model

    def score(self, features: Dict, spans: List[Dict]) -> Dict:
        r = self.ml.score_one(features)
        is_anom = bool(r.get("is_anomaly", False))
        per_model = {k: v for k, v in r.items()
                     if k not in ("aggregate_score", "is_anomaly", "observations")}
        return {
            "score": float(r.get("aggregate_score", 0.0)),
            "is_anomaly": is_anom,
            "reasons": ["ml_hs_trees"] if is_anom else [],
            "metadata": {},
            "per_model": per_model,
        }


class CompositeScorer(Scorer):
    """Runs a list of scorers; score = max, reasons/metadata/per_model unioned."""

    def __init__(self, scorers: List[Scorer]):
        self.scorers = scorers

    def score(self, features: Dict, spans: List[Dict]) -> Dict:
        top = 0.0
        reasons: List[str] = []
        metadata: Dict = {}
        per_model: Dict = {}
        for s in self.scorers:
            r = s.score(features, spans)
            if r["score"] > top:
                top = r["score"]
            reasons.extend(r.get("reasons", []))
            metadata.update(r.get("metadata", {}))
            per_model.update(r.get("per_model", {}))
        return {
            "score": top,
            "is_anomaly": bool(reasons),
            "reasons": reasons,
            "metadata": metadata,
            "per_model": per_model,
        }


class PIIDensityDetector:
    """Paper §IV-C: redaction ratio per service over a sliding 60s window."""

    WINDOW_SEC = 60
    THRESHOLD = 0.8
    MIN_LOGS = 5
    COOLDOWN_SEC = 60

    def __init__(self):
        self._buffers: Dict[str, deque] = {}
        self._last_fired: Dict[str, float] = {}

    def observe(self, service: str, is_redacted: bool) -> Optional[Dict]:
        now = time.time()
        buf = self._buffers.setdefault(service, deque())
        buf.append((now, is_redacted))
        while buf and (now - buf[0][0]) > self.WINDOW_SEC:
            buf.popleft()
        if len(buf) < self.MIN_LOGS:
            return None
        redacted = sum(1 for _, r in buf if r)
        ratio = redacted / len(buf)
        if ratio <= self.THRESHOLD:
            return None
        if now - self._last_fired.get(service, 0) < self.COOLDOWN_SEC:
            return None
        self._last_fired[service] = now
        return {
            "service": service,
            "redaction_ratio": ratio,
            "window_log_count": len(buf),
            "redacted_count": redacted,
        }


# ---- Reason → payload helpers ---------------------------------------------

def build_rule_flags(reasons: List[str], metadata: Dict) -> Dict:
    """Shape the reasons+metadata bag into the UI-friendly rule_flags dict.
    Note: pii_density is filled in separately by the log-stream alert path."""
    return {
        "n_plus_1": "n_plus_1" in reasons,
        "n_plus_1_count": int(metadata.get("n_plus_1_count", 0)),
        "bimodal_latency": "bimodal_latency" in reasons,
        "latency_variance": float(metadata.get("latency_variance", 0.0)),
        "dependency_break": "dangling_parent" in reasons,
        "dangling_span": metadata.get("dangling_span"),
        "pii_density": False,
        "redaction_ratio": 0.0,
    }


def classify_anomaly(reasons: List[str], per_model: Dict) -> str:
    """Return a human-readable label for the dominant anomaly type.
    Rule-based detections outrank ML because they have named structural causes."""
    if "n_plus_1" in reasons:
        return "N+1 Query Regression"
    if "bimodal_latency" in reasons:
        return "Bimodal Latency"
    if "dangling_parent" in reasons:
        return "Dependency Chain Break"
    if "pii_redaction_density" in reasons:
        return "PII Redaction Density"
    if per_model.get("hs_trees", 0.0) > 0.8:
        return "Statistical Outlier (HS-Trees)"
    if "ml_hs_trees" in reasons:
        return "ML Ensemble Anomaly"
    return "Unclassified Anomaly"
