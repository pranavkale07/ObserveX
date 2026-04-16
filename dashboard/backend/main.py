import os
import logging
import json
import asyncio
import aiosqlite
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Dict, Optional, Any
from abc import ABC, abstractmethod
from dotenv import load_dotenv

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import google.generativeai as genai

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app):
    await storage.init_db()
    yield

app = FastAPI(title="ObserverAI Analytical API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- STORAGE LAYER (DAO PATTERN) ---

class TelemetryStorage(ABC):
    @abstractmethod
    async def save_alert(self, alert: Dict): pass
    @abstractmethod
    async def get_alerts(self, service: Optional[str] = None, limit: int = 50): pass
    @abstractmethod
    async def save_metric(self, metric: Dict): pass
    @abstractmethod
    async def get_metrics(self, service: str, metric_type: str, limit: int = 60): pass
    @abstractmethod
    async def save_log(self, log: Dict): pass
    @abstractmethod
    async def get_logs(self, service: Optional[str] = None, severity: Optional[str] = None,
                       trace_id: Optional[str] = None, limit: int = 100): pass

class SQLiteStorage(TelemetryStorage):
    def __init__(self, db_path="telemetry.db"):
        self.db_path = db_path

    async def init_db(self):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service TEXT,
                    route TEXT,
                    anomaly_score REAL,
                    is_anomaly BOOLEAN,
                    duration_ms REAL,
                    trace_id TEXT,
                    timestamp TEXT,
                    spans_json TEXT,
                    reasons_json TEXT,
                    ml_scores_json TEXT,
                    rule_flags_json TEXT,
                    anomaly_type TEXT
                )
            """)
            # Idempotent migrations for pre-existing DBs.
            for col_sql in (
                "ALTER TABLE alerts ADD COLUMN reasons_json TEXT",
                "ALTER TABLE alerts ADD COLUMN ml_scores_json TEXT",
                "ALTER TABLE alerts ADD COLUMN rule_flags_json TEXT",
                "ALTER TABLE alerts ADD COLUMN anomaly_type TEXT",
            ):
                try:
                    await db.execute(col_sql)
                except Exception:
                    pass
            await db.execute("""
                CREATE TABLE IF NOT EXISTS metrics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service TEXT,
                    metric_type TEXT,
                    value REAL,
                    timestamp TEXT
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS trace_inventory (
                    trace_id TEXT PRIMARY KEY,
                    duration_ms REAL,
                    spans_json TEXT,
                    timestamp TEXT
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trace_id TEXT,
                    span_id TEXT,
                    service_name TEXT,
                    body TEXT,
                    severity TEXT,
                    timestamp TEXT
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service_name)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_logs_severity ON logs(severity)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_alerts_service ON alerts(service)")
            await db.commit()

    async def save_alert(self, alert: Dict):
        async with aiosqlite.connect(self.db_path) as db:
            spans_json = json.dumps(alert.get("spans", []))
            reasons_json = json.dumps(alert.get("reasons") or [])
            ml_scores_json = json.dumps(alert.get("ml_scores") or {})
            rule_flags_json = json.dumps(alert.get("rule_flags") or {})
            anomaly_type = alert.get("anomaly_type")
            await db.execute(
                "INSERT INTO alerts (service, route, anomaly_score, is_anomaly, duration_ms, trace_id, timestamp, spans_json, reasons_json, ml_scores_json, rule_flags_json, anomaly_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (alert["service"], alert["route"], alert["anomaly_score"], alert["is_anomaly"],
                 alert["duration_ms"], alert["trace_id"], alert["timestamp"], spans_json,
                 reasons_json, ml_scores_json, rule_flags_json, anomaly_type)
            )
            await db.commit()

    async def get_alerts(self, service: Optional[str] = None, limit: int = 50):
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            if service and service != "All Services":
                cursor = await db.execute("SELECT * FROM alerts WHERE service = ? ORDER BY id DESC LIMIT ?", (service, limit))
            else:
                cursor = await db.execute("SELECT * FROM alerts ORDER BY id DESC LIMIT ?", (limit,))
            rows = await cursor.fetchall()
            results = []
            for row in rows:
                d = dict(row)
                d["spans"] = json.loads(d["spans_json"]) if d.get("spans_json") else []
                d["reasons"] = json.loads(d["reasons_json"]) if d.get("reasons_json") else []
                d["ml_scores"] = json.loads(d["ml_scores_json"]) if d.get("ml_scores_json") else {}
                d["rule_flags"] = json.loads(d["rule_flags_json"]) if d.get("rule_flags_json") else {}
                results.append(d)
            return results

    async def save_metric(self, metric: Dict):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "INSERT INTO metrics (service, metric_type, value, timestamp) VALUES (?, ?, ?, ?)",
                (metric["service"], metric["metric_type"], metric["value"], metric["timestamp"])
            )
            await db.commit()

    async def get_metrics(self, service: str, metric_type: str, limit: int = 60):
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            if service == "All Services":
                cursor = await db.execute(
                    "SELECT * FROM metrics WHERE metric_type = ? ORDER BY id DESC LIMIT ?",
                    (metric_type, limit)
                )
            else:
                cursor = await db.execute(
                    "SELECT * FROM metrics WHERE service = ? AND metric_type = ? ORDER BY id DESC LIMIT ?",
                    (service, metric_type, limit)
                )
            rows = await cursor.fetchall()
            return [dict(row) for row in reversed(rows)]

    async def save_trace(self, trace: Dict):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "INSERT OR REPLACE INTO trace_inventory (trace_id, duration_ms, spans_json, timestamp) VALUES (?, ?, ?, ?)",
                (trace["trace_id"], trace["duration_ms"], json.dumps(trace["spans"]), datetime.now(timezone.utc).isoformat())
            )
            await db.commit()

    async def get_trace(self, trace_id: str):
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("SELECT * FROM trace_inventory WHERE trace_id = ?", (trace_id,))
            row = await cursor.fetchone()
            if row:
                d = dict(row)
                d["spans"] = json.loads(d["spans_json"])
                return d
            return None

    async def save_log(self, log: Dict):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "INSERT INTO logs (trace_id, span_id, service_name, body, severity, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                (log.get("trace_id", ""), log.get("span_id", ""), log["service_name"],
                 log["body"], log.get("severity", "INFO"), log["timestamp"])
            )
            # Enforce retention: keep only the last 1000 logs (efficient threshold check)
            await db.execute("""
                DELETE FROM logs WHERE id < (SELECT MAX(id) - 1000 FROM logs)
            """)
            await db.commit()

    async def get_logs(self, service: Optional[str] = None, severity: Optional[str] = None,
                       trace_id: Optional[str] = None, limit: int = 100):
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            query = "SELECT * FROM logs WHERE 1=1"
            params = []

            if service and service != "All Services":
                query += " AND service_name = ?"
                params.append(service)
            if severity and severity != "All":
                query += " AND severity = ?"
                params.append(severity)
            if trace_id:
                query += " AND trace_id = ?"
                params.append(trace_id)

            query += " ORDER BY id DESC LIMIT ?"
            params.append(limit)

            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

storage = SQLiteStorage()

# --- GEMINI AI ---

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel('gemini-2.5-flash')
else:
    logger.warning("GEMINI_API_KEY not set. AI RCA will be unavailable.")
    model = None

# --- MODELS ---

class SpanInfo(BaseModel):
    name: str
    service: str
    duration_ms: float
    start_time: str
    trace_id: Optional[str] = None
    span_id: Optional[str] = None
    parent_span_id: Optional[str] = None
    status_code: Optional[int] = None
    is_anomaly: Optional[bool] = None

class AnomalyEvent(BaseModel):
    service: str
    route: str
    anomaly_score: float
    is_anomaly: bool
    duration_ms: float
    trace_id: str
    timestamp: str
    spans: Optional[List[SpanInfo]] = None
    reasons: Optional[List[str]] = None
    ml_scores: Optional[Dict[str, float]] = None
    rule_flags: Optional[Dict[str, Any]] = None
    anomaly_type: Optional[str] = None

class TraceInventory(BaseModel):
    trace_id: str
    duration_ms: float
    spans: List[SpanInfo]

class MetricUpdate(BaseModel):
    service: str
    metric_type: str
    value: float
    timestamp: str

class LogEvent(BaseModel):
    trace_id: str = ""
    span_id: str = ""
    service_name: str
    body: str
    severity: str = "INFO"
    timestamp: str

# --- REAL-TIME HUB ---

active_connections: List[WebSocket] = []

async def broadcast(message: dict):
    """Broadcast a message to all connected WebSocket clients, safely removing dead ones."""
    dead = []
    for connection in active_connections:
        try:
            await connection.send_json(message)
        except Exception:
            dead.append(connection)
    for d in dead:
        if d in active_connections:
            active_connections.remove(d)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    try:
        # Send history on connect
        history = await storage.get_alerts(limit=20)
        await websocket.send_json({"type": "history", "data": history})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in active_connections:
            active_connections.remove(websocket)

@app.post("/api/alerts")
async def receive_alert(event: AnomalyEvent):
    event_dict = event.model_dump()
    await storage.save_alert(event_dict)
    await broadcast({"type": "new_anomaly", "data": event_dict})
    return {"status": "ok"}

@app.post("/api/metrics")
async def receive_metric(metric: MetricUpdate):
    metric_dict = metric.model_dump()
    await storage.save_metric(metric_dict)
    await broadcast({"type": "metric_update", "data": metric_dict})
    return {"status": "ok"}

@app.get("/api/alerts")
async def get_alerts(service: Optional[str] = None):
    return await storage.get_alerts(service=service)

@app.post("/api/traces")
async def receive_trace(trace: TraceInventory):
    await storage.save_trace(trace.model_dump())
    return {"status": "ok"}

@app.get("/api/traces/{trace_id}")
async def get_trace(trace_id: str):
    trace = await storage.get_trace(trace_id)
    if not trace: 
        raise HTTPException(status_code=404, detail="Trace not found")
    return trace

@app.get("/api/metrics/{service}/{metric_type}")
async def get_metrics_ts(service: str, metric_type: str):
    return await storage.get_metrics(service, metric_type)

@app.post("/api/logs")
async def receive_log(event: LogEvent):
    event_dict = event.model_dump()
    await storage.save_log(event_dict)
    return {"status": "ok"}

@app.get("/api/logs")
async def get_logs(service: Optional[str] = None, severity: Optional[str] = None,
                   trace_id: Optional[str] = None, limit: int = 100):
    return await storage.get_logs(service=service, severity=severity,
                                   trace_id=trace_id, limit=limit)

@app.post("/api/rca/{trace_id}")
async def analyze_trace(trace_id: str, event: AnomalyEvent):
    if not model:
        raise HTTPException(status_code=503, detail="Gemini API not configured")

    # ── Extract typed fields from AnomalyEvent ──────────────────────
    anomaly_type = event.anomaly_type or "Unclassified Anomaly"
    reasons = event.reasons or []
    rule_flags = event.rule_flags or {}
    ml_scores = event.ml_scores or {}
    service = event.service
    route = event.route
    duration_ms = event.duration_ms
    anomaly_score = event.anomaly_score
    timestamp = event.timestamp
    spans = [s.model_dump() for s in (event.spans or [])]

    # ── Span statistics ─────────────────────────────────────────────
    span_count = len(spans)
    error_spans = [s for s in spans if s.get("is_anomaly")]
    error_count = len(error_spans)
    unique_services = list({s.get("service", "?") for s in spans})
    durations = [s.get("duration_ms", 0) for s in spans]
    max_span_dur = max(durations) if durations else 0
    min_span_dur = min(durations) if durations else 0
    avg_span_dur = sum(durations) / len(durations) if durations else 0

    # ── Dependency chain (parent → child relationships) ─────────────
    span_ids = {s.get("span_id") or "" for s in spans if s.get("span_id")}
    dep_chain_lines = []
    dangling_parents = []
    for s in spans:
        parent = s.get("parent_span_id") or ""
        sid = s.get("span_id") or ""
        svc = s.get("service") or "?"
        name = s.get("name") or "?"
        if parent and parent in span_ids:
            dep_chain_lines.append(f"  {parent[:8]}… → {sid[:8]}… ({svc}::{name})")
        elif parent and parent not in span_ids:
            dangling_parents.append(f"  ⚠ {sid[:8]}… ({svc}::{name}) references missing parent {parent[:8]}…")
    dep_block = "\n".join(dep_chain_lines[:15]) if dep_chain_lines else "  (no parent-child links found)"
    dangling_block = "\n".join(dangling_parents) if dangling_parents else "  (none)"

    # ── Rule detectors (human-readable) ─────────────────────────────
    fired_detectors = []
    if rule_flags.get("n_plus_1"):
        fired_detectors.append(
            f"N+1 Query Regression — span_count={rule_flags.get('n_plus_1_count', 0)} "
            "(Chebyshev bound on rolling span-count distribution)"
        )
    if rule_flags.get("bimodal_latency"):
        fired_detectors.append(
            f"Bimodal Latency — EWMA variance≈{rule_flags.get('latency_variance', 0.0):.1f} "
            "(σ exceeds threshold → latency distribution has split into two modes)"
        )
    if rule_flags.get("dependency_break"):
        fired_detectors.append(
            f"Dependency Chain Break — dangling span '{rule_flags.get('dangling_span')}' "
            "(parent_span_id references a span not present in the reconstructed trace)"
        )
    if rule_flags.get("pii_density"):
        ratio = rule_flags.get("redaction_ratio", 0.0)
        fired_detectors.append(
            f"PII Redaction Density — {ratio*100:.0f}% of logs in 60s window redacted "
            "(possible data-exfil path or misconfigured logger)"
        )
    detectors_block = "\n".join(f"- {d}" for d in fired_detectors) or "- (none; ML-only detection)"

    ml_block = "\n".join(f"- {name}: {float(v):.3f}" for name, v in ml_scores.items()) or "- (no ML scores)"

    # ── Span inventory (detailed) ───────────────────────────────────
    span_summary_lines = []
    for s in spans[:20]:
        line = (
            f"  - {s.get('service') or '?'}::{s.get('name') or '?'} "
            f"dur={s.get('duration_ms') or 0:.0f}ms status={s.get('status_code') or 0} "
            f"span={(s.get('span_id') or '')[:8]}… parent={(s.get('parent_span_id') or '')[:8]}…"
        )
        if s.get("is_anomaly"):
            line += " [ANOMALOUS]"
        span_summary_lines.append(line)
    spans_block = "\n".join(span_summary_lines) or "  (no spans)"

    # ── Correlated logs from DB ─────────────────────────────────────
    logs_block = "(no correlated logs)"
    try:
        trace_logs = await storage.get_logs(trace_id=trace_id, limit=25)
        if trace_logs:
            log_lines = []
            for lg in trace_logs:
                log_lines.append(
                    f"  - [{lg.get('severity','INFO')}] {lg.get('service_name','?')}: "
                    f"{(lg.get('body','') or '')[:240]}"
                )
            logs_block = "\n".join(log_lines)
    except Exception as e:
        logger.warning(f"Could not fetch correlated logs for RCA {trace_id}: {e}")

    # ── Raw anomaly event JSON (complete context for LLM) ───────────
    event_json = json.dumps(event.model_dump(), indent=2, default=str)

    prompt = f"""You are an expert SRE performing forensic root-cause analysis on an anomalous distributed trace
detected by the ObserveX Cognitive Observability pipeline. The upstream pipeline has already classified
the anomaly and run rule-based + ML ensemble detectors — use their verdicts as primary evidence.

═══════════════════════════════════════════
ANOMALY EVENT SUMMARY
═══════════════════════════════════════════
TRACE ID:       {trace_id}
TIMESTAMP:      {timestamp}
SERVICE:        {service}
ROUTE:          {route}
DURATION:       {duration_ms:.0f}ms
ANOMALY SCORE:  {anomaly_score:.2f} (0=normal, 1=critical)
ANOMALY TYPE:   {anomaly_type}
DETECTOR TAGS:  {reasons}

═══════════════════════════════════════════
TRACE STRUCTURE
═══════════════════════════════════════════
Total Spans:      {span_count}
Anomalous Spans:  {error_count}
Services Hit:     {', '.join(unique_services)}
Latency Range:    {min_span_dur:.0f}ms – {max_span_dur:.0f}ms (avg {avg_span_dur:.0f}ms)

DEPENDENCY CHAIN (parent → child):
{dep_block}

DANGLING PARENTS (dependency breaks):
{dangling_block}

═══════════════════════════════════════════
RULE DETECTORS FIRED
═══════════════════════════════════════════
{detectors_block}

═══════════════════════════════════════════
ML ENSEMBLE SCORES (0→normal, 1→anomalous)
═══════════════════════════════════════════
{ml_block}

═══════════════════════════════════════════
SPAN INVENTORY (first 20 spans with parent/child IDs)
═══════════════════════════════════════════
{spans_block}

═══════════════════════════════════════════
CORRELATED LOGS (flushed by trace_id at anomaly time)
═══════════════════════════════════════════
{logs_block}

═══════════════════════════════════════════
RAW ANOMALY EVENT (complete pipeline output)
═══════════════════════════════════════════
{event_json}

═══════════════════════════════════════════
MISSION
═══════════════════════════════════════════
1. Explain WHY this trace tripped the detectors that fired — be specific about the
   structural evidence (e.g. "87 sequential DB child spans under one parent indicate
   a missing JOIN or unbatched ORM query").
2. Use the dependency chain and dangling parent data to identify cross-service
   propagation paths and pinpoint the originating service.
3. If multiple detectors fired, identify which is the root cause vs. downstream symptom.
4. Cross-reference correlated logs for error messages, stack traces, or redaction tokens
   that corroborate the detector verdict.
5. Propose concrete, actionable fixes that address the root cause — not the symptom.

Respond as STRICT JSON (no markdown fences, no commentary outside JSON):
{{
  "root_cause": "concise explanation tied to fired detectors and structural evidence (max 30 words)",
  "suggested_fixes": ["concrete fix 1", "concrete fix 2", "concrete fix 3"],
  "risk_prediction": "one-sentence impact if left unresolved",
  "confidence": 0.0-1.0
}}
"""

    try:
        response = model.generate_content(prompt)
        text = response.text.strip()
        # Handle potential markdown formatting from AI
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            text = text.split("```")[1].strip()
        return json.loads(text)
    except Exception as e:
        logger.error(f"RCA analysis failed for trace {trace_id}: {e}")
        raise HTTPException(status_code=502, detail=f"AI analysis failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
