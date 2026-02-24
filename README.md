# ObserverAI: High-Precision Forensics & Telemetry Platform

ObserverAI is a premium observability stack designed for multi-service environments. It features automated instrumentation, high-throughput stream processing with Bytewax, and an AI-powered diagnostic engine fueled by Gemini.

## 🏗️ System Architecture

```mermaid
graph TD
    subgraph "Microservices Layer"
        AGW["API Gateway (Node.js)"]
        QS["Quote Service (Python)"]
    end

    subgraph "Instrumentation"
        NW["Node Wrapper"]
        PW["Python Wrapper"]
    end

    subgraph "Data Pipeline"
        OC["OTel Collector (Docker)"]
        RMQ["RabbitMQ Stream (Local)"]
        BW["Bytewax Processor"]
    end

    subgraph "Storage & Intelligence"
        DB["SQLite (telemetry.db)"]
        FAST["FastAPI Backend"]
        GEM["Gemini 1.5 Flash (AI)"]
    end

    subgraph "Frontend"
        REACT["React Dashboard (Vite)"]
    end

    %% Flow
    AGW & QS --> NW & PW
    NW & PW --> OC
    OC -->|Redacted OTLP| RMQ
    RMQ --> BW
    BW -->|Windowed Metrics & Traces| FAST
    FAST --> DB
    REACT -->|Query Analytics| FAST
    REACT -->|Request RCA| FAST
    FAST -->|Normalize & Analyze| GEM
    GEM -->|Structured RCA| FAST
```

## 🔍 Forensic Activity Flow

This diagram illustrates how Phase 5 reconstructs cross-service traces for AI analysis.

```mermaid
sequenceDiagram
    participant U as User Traffic
    participant S as Services
    participant C as OTel Collector
    participant B as Bytewax (Stream)
    participant BE as Backend
    participant AI as Gemini AI

    U->>S: Request (/api/proxy-slow-quote)
    S->>S: Multiple Spans Generated
    S->>C: Push Spans (OTLP)
    C->>C: Redact PII (Email/Author)
    C->>B: Stream to RabbitMQ
    B->>B: 10s Tumbling Window
    B->>B: Reconstruct Trace by trace_id
    B->>BE: POST /api/traces (Full Inventory)
    B->>BE: POST /api/alerts (Anomaly Detected)
    BE->>BE: Save to telemetry.db
    Note over BE: User clicks 'Forensics' on Dashboard
    BE->>AI: Send Normalized Full Trace
    AI->>BE: Return Root Cause & Fixes
    BE->>User: Display Diagnostic Modal
```

## 🚀 Getting Started

### Prerequisites
- Docker & Docker Compose
- RabbitMQ installed locally (v3.9+)
- Python 3.10+ & Node.js 18+
- Gemini API Key

### Running the Stack

1. **Environment Setup**
   Ensure your `.env` in `dashboard/backend/` has:
   ```env
   GEMINI_API_KEY=your_key_here
   ```

2. **Run the Master Script**
   Execute the unified startup script from the root directory:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```

3. **Explore the Dashboard**
   Open your browser at: `http://localhost:5173`

## ✨ Key Features (Phase 5)
- **AI RCA**: Instant root cause analysis with suggested fixes.
- **Trace Waterfall**: Multi-service visualization reconstructed in flight.
- **Sparkline Wave**: Real-time throughput and latency trends.
- **Resource Saturation**: Live CPU and Memory tracking.
- **Sidebar Controls**: Production-grade toggles for Live Mode and Auto-Correlation.
