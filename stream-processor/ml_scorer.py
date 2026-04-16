"""Streaming ML scorer based on River HalfSpaceTrees.

Online anomaly model with `learn_one` / `score_one`. Warmed up at startup on a
synthetic telemetry corpus (`refs/synthetic_telemetry.jsonl`) that matches the
live OTel feature space (duration_ms, span_count, error_rate), then continues
learning from real traffic.

The returned dict surfaces a per-model breakdown so the frontend can render
individual model contributions. Today we ship one model (HS-Trees); if more
are added later, extend the dict — no caller changes needed.
"""
try:
    from river.anomaly import HalfSpaceTrees
except ImportError:
    # Dummy fallback so imports don't explode in envs without River.
    class HalfSpaceTrees:
        def __init__(self, **kwargs): self.kwargs = kwargs
        def learn_one(self, x): pass
        def score_one(self, x): return 0.5


def _feature_vec(features):
    """Map OTel features to the River input dict. Cap duration to dampen
    outliers in the online model (durations beyond 5s dominate otherwise)."""
    return {
        "duration_ms": min(features.get("duration_ms", 0) / 1000.0, 5.0),
        "span_count": float(features.get("span_count", 0)),
        "error_rate": float(features.get("error_rate", 0)),
    }


class ObserveXScorer:
    HS_NORMALIZER = 0.8   # HS-Trees scores roughly max out around this value
    ANOMALY_THRESHOLD = 0.7  # normalised score > this → flag as ML anomaly

    def __init__(self):
        self.hs_trees = HalfSpaceTrees(
            n_trees=25,
            height=8,
            window_size=100,
            seed=42,
        )
        self._observations = 0

    def learn_one(self, features):
        self.hs_trees.learn_one(_feature_vec(features))
        self._observations += 1

    def score_one(self, features):
        """Return per-model + aggregate score dict."""
        raw = self.hs_trees.score_one(_feature_vec(features))
        hs_norm = min(raw / self.HS_NORMALIZER, 1.0)
        return {
            "hs_trees": hs_norm,
            "aggregate_score": hs_norm,
            "is_anomaly": hs_norm > self.ANOMALY_THRESHOLD,
            "observations": self._observations,
        }
