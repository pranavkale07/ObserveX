import os
import logging
import json
import asyncio
import aiosqlite
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

app = FastAPI(title="ObserverAI Analytical API")

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
                    spans_json TEXT
                )
            """)
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
            await db.commit()

    async def save_alert(self, alert: Dict):
        async with aiosqlite.connect(self.db_path) as db:
            spans_json = json.dumps(alert.get("spans", []))
            await db.execute(
                "INSERT INTO alerts (service, route, anomaly_score, is_anomaly, duration_ms, trace_id, timestamp, spans_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (alert["service"], alert["route"], alert["anomaly_score"], alert["is_anomaly"], 
                 alert["duration_ms"], alert["trace_id"], alert["timestamp"], spans_json)
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

storage = SQLiteStorage()

@app.on_event("startup")
async def startup():
    await storage.init_db()

# --- GEMINI AI ---

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel('gemini-2.5-flash-lite')
else:
    logger.warning("GEMINI_API_KEY not set. AI RCA will be unavailable.")
    model = None

# --- MODELS ---

class SpanInfo(BaseModel):
    name: str
    service: str
    duration_ms: float
    start_time: str

class AnomalyEvent(BaseModel):
    service: str
    route: str
    anomaly_score: float
    is_anomaly: bool
    duration_ms: float
    trace_id: str
    timestamp: str
    spans: Optional[List[SpanInfo]] = None

class TraceInventory(BaseModel):
    trace_id: str
    duration_ms: float
    spans: List[SpanInfo]

class MetricUpdate(BaseModel):
    service: str
    metric_type: str
    value: float
    timestamp: str

# --- REAL-TIME HUB ---

active_connections: List[WebSocket] = []

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
        active_connections.remove(websocket)

@app.post("/api/alerts")
async def receive_alert(event: AnomalyEvent):
    event_dict = event.dict()
    await storage.save_alert(event_dict)
    
    # Broadcast
    for connection in active_connections:
        try:
            await connection.send_json({"type": "new_anomaly", "data": event_dict})
        except Exception:
            active_connections.remove(connection)
    return {"status": "ok"}

@app.post("/api/metrics")
async def receive_metric(metric: MetricUpdate):
    metric_dict = metric.dict()
    await storage.save_metric(metric_dict)
    
    # Broadcast metrics update if needed (or let frontend poll)
    for connection in active_connections:
        try:
            await connection.send_json({"type": "metric_update", "data": metric_dict})
        except Exception:
            active_connections.remove(connection)
    return {"status": "ok"}

@app.get("/api/alerts")
async def get_alerts(service: Optional[str] = None):
    return await storage.get_alerts(service=service)

@app.post("/api/traces")
async def receive_trace(trace: TraceInventory):
    await storage.save_trace(trace.dict())
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

@app.post("/api/rca/{trace_id}")
async def analyze_trace(trace_id: str, trace_data: Dict):
    if not model:
        raise HTTPException(status_code=503, detail="Gemini API not configured")
    
    prompt = f"""
    You are an expert SRE. Analyze this anomalous trace ID: {trace_id}.
    
    FORENSIC CONTEXT:
    {json.dumps(trace_data, indent=2)}
    
    MISSION: Identify why this specific request failed or was slow.
    
    FORMAT YOUR RESPONSE AS STRICT JSON:
    {{
      "root_cause": "brief explanation (max 20 words)",
      "suggested_fixes": ["fix 1", "fix 2"],
      "risk_prediction": "one-sentence impact if not solved",
      "confidence": 0.95
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
        return {"root_cause": f"Analysis failed: {str(e)}", "suggested_fixes": [], "risk_prediction": "N/A", "confidence": 0}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
