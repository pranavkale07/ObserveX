import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Activity, AlertTriangle, Cpu, Globe, RefreshCcw, Zap, Search, Brain, X,
  Server, Shield, Box, LayoutPanelLeft, ChevronRight, BarChart3, Clock3, FileText
} from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// Build a smooth SVG path from a series of values mapped into a viewBox.
// Uses Catmull-Rom → Cubic Bezier so data lines look polished instead of
// zig-zaggy when stretched to fill a card width.
function smoothPath(values, { width = 100, height = 20, padding = 2 } = {}) {
  if (!Array.isArray(values) || values.length === 0) return "";
  if (values.length === 1) {
    const y = height / 2;
    return `M 0 ${y} L ${width} ${y}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => ({
    x: (i / (values.length - 1)) * width,
    y: height - padding - ((v - min) / range) * (height - padding * 2),
  }));
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

const BACKEND_URL = "http://localhost:8000";
const WS_URL = "ws://localhost:8000/ws";

// Maps backend `anomaly_type` → Tailwind classes for the row badge and panel header.
const ANOMALY_STYLE = {
  "N+1 Query Regression":            { text: "text-orange-300", bg: "bg-orange-500/15", border: "border-orange-500/30", dot: "bg-orange-500" },
  "Bimodal Latency":                  { text: "text-amber-300", bg: "bg-amber-500/15", border: "border-amber-500/30", dot: "bg-amber-500" },
  "Dependency Chain Break":           { text: "text-red-300", bg: "bg-red-600/15", border: "border-red-600/30", dot: "bg-red-600" },
  "PII Redaction Density":            { text: "text-purple-300", bg: "bg-purple-500/15", border: "border-purple-500/30", dot: "bg-purple-500" },
  "Statistical Outlier (HS-Trees)":   { text: "text-sky-300", bg: "bg-sky-500/15", border: "border-sky-500/30", dot: "bg-sky-500" },
  "Statistical Outlier (LOF)":        { text: "text-cyan-300", bg: "bg-cyan-500/15", border: "border-cyan-500/30", dot: "bg-cyan-500" },
  "Statistical Outlier (Isolation Forest)": { text: "text-teal-300", bg: "bg-teal-500/15", border: "border-teal-500/30", dot: "bg-teal-500" },
  "Reconstruction Anomaly (Autoencoder)":   { text: "text-pink-300", bg: "bg-pink-500/15", border: "border-pink-500/30", dot: "bg-pink-500" },
  "Boundary Anomaly (SVM)":           { text: "text-violet-300", bg: "bg-violet-500/15", border: "border-violet-500/30", dot: "bg-violet-500" },
  "ML Ensemble Anomaly":              { text: "text-blue-300", bg: "bg-blue-500/15", border: "border-blue-500/30", dot: "bg-blue-500" },
  "Unclassified Anomaly":             { text: "text-slate-300", bg: "bg-slate-500/15", border: "border-slate-500/30", dot: "bg-slate-500" },
};
const DEFAULT_STYLE = { text: "text-rose-300", bg: "bg-rose-500/15", border: "border-rose-500/30", dot: "bg-rose-500" };
const styleFor = (type) => ANOMALY_STYLE[type] || DEFAULT_STYLE;

// Rule-flag → pill metadata. `fmt` renders the numeric detail (count / variance / ratio).
const RULE_PILLS = [
  { key: "n_plus_1",         label: "N+1 Queries",      metaKey: "n_plus_1_count",   fmt: (v) => v > 0 ? `×${v}` : null, color: "orange" },
  { key: "bimodal_latency",  label: "Bimodal Latency",  metaKey: "latency_variance", fmt: (v) => v > 0 ? `σ²≈${Math.round(v).toLocaleString()}` : null, color: "amber" },
  { key: "dependency_break", label: "Dangling Parent",  metaKey: "dangling_span",    fmt: (v) => v ? `@${v}` : null, color: "red" },
  { key: "pii_density",      label: "PII Density",      metaKey: "redaction_ratio",  fmt: (v) => v > 0 ? `${Math.round(v * 100)}%` : null, color: "purple" },
];
const PILL_COLOR = {
  orange: "bg-orange-500/10 text-orange-300 border-orange-500/30",
  amber:  "bg-amber-500/10 text-amber-300 border-amber-500/30",
  red:    "bg-red-500/10 text-red-300 border-red-500/30",
  purple: "bg-purple-500/10 text-purple-300 border-purple-500/30",
};

export default function App() {
  const [anomalies, setAnomalies] = useState([]);
  const [stats, setStats] = useState({ total_traces: 0, anomaly_count: 0 });
  const [statsHistory, setStatsHistory] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [selectedTrace, setSelectedTrace] = useState(null);
  const [selectedService, setSelectedService] = useState("All Services");
  const [monitoringMode, setMonitoringMode] = useState("SRE (Standard)");
  const [liveMode, setLiveMode] = useState(true);
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const [autoCorrelation, setAutoCorrelation] = useState(true);

  const [traceContext, setTraceContext] = useState(null);
  const [traceLogs, setTraceLogs] = useState([]);
  const [traceLogsLoading, setTraceLogsLoading] = useState(false);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [activeTab, setActiveTab] = useState("Traces");
  const [status, setStatus] = useState("connecting");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const ws = useRef(null);
  const liveModeRef = useRef(liveMode);
  const unmountedRef = useRef(false);

  // Keep refs in sync
  useEffect(() => { liveModeRef.current = liveMode; }, [liveMode]);

  // Load history and initialize WS
  useEffect(() => {
    unmountedRef.current = false;
    fetchHistory();
    connectWS();
    return () => {
      unmountedRef.current = true;
      if (ws.current) {
        ws.current.onclose = null;
        ws.current.close();
      }
    };
  }, []);

  const fetchHistory = async () => {
    try {
      const alertRes = await fetch(`${BACKEND_URL}/api/alerts`);
      if (!alertRes.ok) throw new Error("Failed to fetch alerts");
      const alertData = await alertRes.json();
      setAnomalies(alertData);

      fetch(`${BACKEND_URL}/api/stats`)
        .then(r => r.ok ? r.json() : null)
        .then(s => {
          if (s) {
            setStats(s);
            const rate = s.total_traces > 0 ? (s.anomaly_count / s.total_traces) * 100 : 0;
            setStatsHistory(prev => [...prev, rate].slice(-30));
          }
        })
        .catch(() => {});

      // Fetch metrics history for current service context.
      // Fetch both the chart metric (p99/redaction) AND throughput so the
      // summary StatCard has data on first paint instead of waiting for WS.
      const metricType = getMetricTypeForMode(monitoringMode);
      const typesToFetch = metricType === "throughput"
        ? [metricType]
        : [metricType, "throughput"];
      const metricResults = await Promise.all(
        typesToFetch.map(t =>
          fetch(`${BACKEND_URL}/api/metrics/${selectedService}/${t}`)
            .then(r => r.ok ? r.json() : [])
            .catch(() => [])
        )
      );
      const merged = metricResults.flat().sort((a, b) =>
        new Date(a.timestamp) - new Date(b.timestamp)
      );
      setMetrics(merged);
    } catch (err) { console.error(err); }
    finally { setIsLoading(false); }
  };

  const getMetricTypeForMode = (mode) => {
    if (mode === "Security (Redaction)") return "redaction_count";
    if (mode === "Bimodal Analysis") return "p99_latency";
    return "p99_latency";
  };

  const connectWS = () => {
    if (unmountedRef.current) return;
    if (ws.current) {
      ws.current.onclose = null;
      ws.current.close();
    }
    ws.current = new WebSocket(WS_URL);
    ws.current.onopen = () => setStatus("connected");
    ws.current.onclose = () => {
      setStatus("disconnected");
      if (!unmountedRef.current) setTimeout(connectWS, 2000);
    };
    ws.current.onerror = () => {};
    ws.current.onmessage = (event) => {
      if (!liveModeRef.current) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "new_anomaly") {
          setAnomalies(prev => {
            const incoming = msg.data;
            const key = incoming.id ?? `${incoming.trace_id}-${incoming.timestamp}`;
            const filtered = prev.filter(a => (a.id ?? `${a.trace_id}-${a.timestamp}`) !== key);
            return [incoming, ...filtered].slice(0, 50);
          });
          fetch(`${BACKEND_URL}/api/stats`)
            .then(r => r.ok ? r.json() : null)
            .then(s => {
              if (s) {
                setStats(s);
                const rate = s.total_traces > 0 ? (s.anomaly_count / s.total_traces) * 100 : 0;
                setStatsHistory(prev => [...prev, rate].slice(-30));
              }
            })
            .catch(() => {});
        } else if (msg.type === "metric_update") {
          setMetrics(prev => [...prev, msg.data].slice(-60));
        } else if (msg.type === "history") {
          setAnomalies(msg.data);
        }
      } catch (err) { console.error("WS message parse error:", err); }
    };
  };

  const runRCA = async (alert) => {
    setSelectedTrace(alert);
    setIsAnalyzing(false);
    setAnalysis(null);
    setTraceContext(null);
    setTraceLogs([]);
    setTraceLogsLoading(true);
    setActiveTab("Overview");
    try {
      // 1. Fetch FULL trace inventory for waterfall
      const traceRes = await fetch(`${BACKEND_URL}/api/traces/${alert.trace_id}`);
      const fullTrace = await traceRes.json();

      const spans = fullTrace.spans || [];
      const firstStart = spans.length > 0 ? Math.min(...spans.map(s => new Date(s.start_time).getTime())) : 0;

      const normalizedSpans = spans.sort((a, b) => new Date(a.start_time) - new Date(b.start_time)).map(s => ({
        name: s.name,
        service: s.service,
        start: new Date(s.start_time).getTime() - firstStart,
        duration: s.duration_ms,
        type: s.service === "api-gateway" ? "API" : s.name.includes("db") ? "DATABASE" : "SERVICE"
      }));

      const context = {
        trace_id: alert.trace_id,
        duration_ms: fullTrace.duration_ms,
        spans: normalizedSpans
      };

      setTraceContext(context);

      // 2. Fetch correlated logs for this trace (when auto-correlation is on)
      if (autoCorrelation) {
        const logRes = await fetch(`${BACKEND_URL}/api/logs?trace_id=${alert.trace_id}`);
        const logData = await logRes.json();
        setTraceLogs(logData);
      }
    } catch (err) {
      console.error("RCA Failed:", err);
    } finally {
      setTraceLogsLoading(false);
    }
  };

  const handleTabClick = async (tab) => {
    setActiveTab(tab);

    if (tab === "AI Analysis" && traceContext && !analysis && !isAnalyzing) {
      setIsAnalyzing(true);
      try {
        const rcaPayload = {
          ...traceContext,
          service: selectedTrace?.service || "unknown",
          route: selectedTrace?.route || "unknown",
          anomaly_score: selectedTrace?.anomaly_score ?? 0,
          is_anomaly: selectedTrace?.is_anomaly ?? true,
          anomaly_type: selectedTrace?.anomaly_type,
          timestamp: selectedTrace?.timestamp || new Date().toISOString(),
          reasons: selectedTrace?.reasons,
          rule_flags: selectedTrace?.rule_flags,
          ml_scores: selectedTrace?.ml_scores,
          spans: (traceContext.spans || []).map(s => ({
            name: s.name || "unknown",
            service: s.service || "unknown",
            duration_ms: s.duration ?? s.duration_ms ?? 0,
            start_time: s.start_time || new Date().toISOString(),
            status_code: s.status_code,
            is_anomaly: s.is_anomaly,
            span_id: s.span_id,
            parent_span_id: s.parent_span_id,
          })),
        };
        const response = await fetch(`${BACKEND_URL}/api/rca/${traceContext.trace_id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rcaPayload)
        });
        if (!response.ok) {
          const errBody = await response.text();
          console.error(`RCA API error ${response.status}:`, errBody);
          throw new Error(`API ${response.status}: ${errBody}`);
        }
        const data = await response.json();
        setAnalysis({ ...data, traceData: traceContext });
      } catch (err) {
        console.error("AI Analysis Failed:", err);
        setAnalysis({
          root_cause: `AI analysis failed: ${err.message || "Unknown error"}`,
          suggested_fixes: ["Check GEMINI_API_KEY configuration", "Check backend logs for details", "Try again in a few moments"],
          risk_prediction: "N/A",
          traceData: traceContext
        });
      } finally {
        setIsAnalyzing(false);
      }
    }
  };

  const chartData = useMemo(() => {
    const metricType = getMetricTypeForMode(monitoringMode);
    const filtered = metrics.filter(m =>
      (selectedService === "All Services" || m.service === selectedService) &&
      (m.metric_type === metricType)
    );
    return filtered.slice(-30).map((m) => {
      const ts = new Date(m.timestamp);
      return {
        // Human-readable timestamp for the X axis / tooltip
        time: ts.toLocaleTimeString(),
        // Raw numeric timestamp (ms) if needed later
        ts: ts.getTime(),
        val: m.value
      };
    });
  }, [metrics, selectedService, monitoringMode]);

  const chartLabel = useMemo(() => {
    const metricType = getMetricTypeForMode(monitoringMode);
    if (metricType === "redaction_count") {
      return "Security Redaction Count Over Time";
    }
    // Default is p99_latency in milliseconds
    return "P99 Latency (ms) Over Time";
  }, [monitoringMode]);

  // Derived summary stats for StatCards (Phase 2: replace hardcoded values)
  const summaryStats = useMemo(() => {
    const latencies = metrics.filter(m => m.metric_type === "p99_latency").map(m => m.value);
    const throughputs = metrics.filter(m => m.metric_type === "throughput").map(m => m.value);
    const throughputVal = throughputs.length > 0
      ? throughputs.reduce((a, b) => a + b, 0).toFixed(0)
      : "—";
    const latencyVal = latencies.length > 0
      ? latencies[latencies.length - 1].toFixed(0) + "ms"
      : "—";
    const errorRate = stats.total_traces > 0
      ? ((stats.anomaly_count / stats.total_traces) * 100).toFixed(1) + "%"
      : "0%";
    const latencyTrend = latencies.length > 0 && latencies[latencies.length - 1] > 500
      ? "Critical" : "Normal";
    const throughputTrend = throughputs.length >= 2
      ? ((throughputs[throughputs.length - 1] - throughputs[throughputs.length - 2]) >= 0 ? "+" : "") +
        ((throughputs[throughputs.length - 1] - throughputs[throughputs.length - 2])).toFixed(0)
      : "—";

    const throughputSeries = throughputs.slice(-20);
    const p99Series = latencies.slice(-20);
    const anomalySeries = statsHistory.slice(-20);

    return {
      throughput: throughputVal, p99: latencyVal, errorRate,
      latencyTrend, throughputTrend,
      throughputSeries, p99Series,
      anomalySeries,
    };
  }, [metrics, anomalies, stats, statsHistory]);

  // Dynamic AI Insight from latest anomaly
  const aiInsight = useMemo(() => {
    if (anomalies.length === 0) return { text: "No active anomalies detected. System operating normally.", hasAnomaly: false };
    const latest = anomalies[0];
    return {
      text: `Detected anomaly in ${latest.service} — ${(latest.duration_ms ?? 0).toFixed(0)}ms latency on ${latest.route}. Investigate for potential performance degradation.`,
      hasAnomaly: true,
      alert: latest,
    };
  }, [anomalies]);

  // Filtered anomalies for search + anomaliesOnly toggle
  const filteredAnomalies = useMemo(() => {
    let filtered = anomalies;
    if (anomaliesOnly) {
      filtered = filtered.filter(a => a.is_anomaly);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(a =>
        (a.service || "").toLowerCase().includes(q) ||
        (a.route || "").toLowerCase().includes(q) ||
        (a.trace_id || "").toLowerCase().includes(q)
      );
    }
    return filtered;
  }, [anomalies, anomaliesOnly, searchQuery]);

  // Sync metrics when mode/service changes
  useEffect(() => {
    fetchHistory();
  }, [selectedService, monitoringMode]);

  return (
    <div className="flex min-h-screen bg-[#020617] text-slate-100 font-sans">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800/50 bg-[#020617] p-6 flex flex-col gap-8">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
            <Activity className="w-5 h-5" />
          </div>
          <span className="text-xl font-bold tracking-tight">ObserverAI</span>
        </div>

        <nav className="space-y-4">
          <label className="text-[10px] uppercase font-black tracking-widest text-slate-500">Service Topology</label>
          <div className="space-y-1">
            {["All Services", "api-gateway", "python-service"].map(svc => (
              <button
                key={svc}
                onClick={() => setSelectedService(svc)}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md text-sm transition-all flex items-center justify-between group",
                  selectedService === svc ? "bg-indigo-600/10 text-indigo-400 font-bold" : "text-slate-400 hover:bg-slate-800"
                )}
              >
                <div className="flex items-center gap-2">
                  <Server className="w-4 h-4" />
                  {svc}
                </div>
                {selectedService === svc && <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]" />}
              </button>
            ))}
          </div>
        </nav>

        <div className="space-y-6 mt-4">
          <label className="text-[10px] uppercase font-black tracking-widest text-slate-500">Display Options</label>
          <div className="space-y-4">
            <Toggle label="Live Mode" active={liveMode} onClick={() => setLiveMode(!liveMode)} />
            <Toggle label="Anomalies Only" active={anomaliesOnly} onClick={() => setAnomaliesOnly(!anomaliesOnly)} />
            <Toggle label="Auto-Correlation" active={autoCorrelation} onClick={() => setAutoCorrelation(!autoCorrelation)} />
          </div>

          <div className={cn("border p-4 rounded-xl mt-6", aiInsight.hasAnomaly ? "bg-rose-600/10 border-rose-500/20" : "bg-indigo-600/10 border-indigo-500/20")}>
            <div className="flex items-center gap-2 mb-2">
              <div className={cn("w-1.5 h-1.5 rounded-full", aiInsight.hasAnomaly ? "bg-rose-500 animate-ping" : "bg-indigo-500")} />
              <span className={cn("text-[10px] uppercase font-black tracking-widest", aiInsight.hasAnomaly ? "text-rose-400" : "text-indigo-400")}>AI Insight</span>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              {aiInsight.text}
            </p>
            {aiInsight.hasAnomaly && (
              <button
                onClick={() => runRCA(aiInsight.alert)}
                className="w-full mt-3 py-2 bg-indigo-600 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-indigo-500 transition-colors"
              >
                Investigate Root Cause
              </button>
            )}
          </div>
        </div>

        <div className="mt-auto space-y-4 pt-6 border-t border-slate-800/50">
          <label className="text-[10px] uppercase font-black tracking-widest text-slate-500">Monitoring Mode</label>
          <select
            value={monitoringMode}
            onChange={(e) => setMonitoringMode(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded-md p-2 text-sm text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option>SRE (Standard)</option>
            <option>N+1 Detection</option>
            <option>Security (Redaction)</option>
            <option>Bimodal Analysis</option>
          </select>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-y-auto custom-scrollbar">
        <header className="flex justify-between items-center mb-8 bg-slate-900/40 p-4 rounded-2xl border border-slate-800/50">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 rounded-md">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] font-black text-emerald-500 uppercase">Production</span>
            </div>
          </div>

          <div className="flex-1 max-w-md mx-8 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by service, route, or trace ID..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 pl-10 pr-4 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
            />
          </div>

          <div className="flex items-center gap-4">
            <div className="px-3 py-1.5 bg-slate-950 rounded-full border border-slate-800 text-xs flex items-center gap-2">
              <div className={cn("w-2 h-2 rounded-full", status === "connected" ? "bg-emerald-500 animate-pulse" : "bg-red-500")} />
              <span className="text-slate-400 uppercase font-black text-[9px]">{liveMode ? "Live" : "Paused"}</span>
            </div>
            <button onClick={fetchHistory} className="relative p-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors" title="Refresh data">
              <RefreshCcw className="w-4 h-4" />
            </button>
            <button
              onClick={() => { if (anomalies.length > 0) runRCA(anomalies[0]); }}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20"
            >
              <Brain className="w-4 h-4" />
              AI Assistant
            </button>
          </div>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-6 mb-8">
          <StatCard label="Throughput" value={summaryStats.throughput} trend={summaryStats.throughputTrend} icon={<Activity className="text-indigo-400" />} color="indigo" series={summaryStats.throughputSeries} />
          <StatCard label="P99 Latency" value={summaryStats.p99} trend={summaryStats.latencyTrend} icon={<Clock3 className="text-rose-400" />} color="rose" series={summaryStats.p99Series} />
          <StatCard label="Anomaly Rate" value={summaryStats.errorRate} trend={stats.total_traces > 0 ? `${stats.anomaly_count}/${stats.total_traces}` : "Normal"} icon={<Shield className="text-emerald-400" />} color="emerald" series={summaryStats.anomalySeries} />
        </div>

        {/* Chart View */}
        <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 mb-8">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-sm font-bold flex items-center gap-2 text-slate-300">
              <BarChart3 className="w-4 h-4 text-indigo-400" />
              {chartLabel}
            </h3>
            <div className="flex gap-2 text-[10px] text-slate-500">
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-indigo-500" />
                {getMetricTypeForMode(monitoringMode) === "redaction_count" ? "Redactions" : "P99 Latency (ms)"}
              </span>
            </div>
          </div>
          <div className="h-64 mt-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                <XAxis
                  dataKey="time"
                  stroke="#475569"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis stroke="#475569" fontSize={10} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px' }}
                  itemStyle={{ color: '#818cf8', fontWeight: 'bold' }}
                />
                <Area type="monotone" dataKey="val" stroke="#818cf8" strokeWidth={3} fillOpacity={1} fill="url(#colorVal)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Incident Stream */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-400" />
              Historical Incident Stream
            </h3>
            <div className="space-y-3 max-h-[600px] overflow-y-auto custom-scrollbar pr-1">
              {isLoading ? (
                <div className="text-center py-12 text-slate-600 text-sm">
                  <div className="w-8 h-8 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin mx-auto mb-3" />
                  Loading incidents...
                </div>
              ) : filteredAnomalies.length === 0 ? (
                <div className="text-center py-12 text-slate-600 text-sm">
                  <AlertTriangle className="w-8 h-8 mx-auto mb-3 opacity-20" />
                  {searchQuery ? "No incidents match your search." : "No incidents detected yet. Generate traffic to see anomalies."}
                </div>
              ) : (
                filteredAnomalies.map((item, idx) => (
                  <AnomalyRow key={item.id ?? `${item.trace_id}-${item.timestamp}-${idx}`} item={item} onClick={() => runRCA(item)} />
                ))
              )}
            </div>
          </div>

          {/* Diagnostics Right Panel */}
          <div className="space-y-6">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Brain className="w-5 h-5 text-purple-400" />
              Diagnostic Center
            </h3>
            {selectedTrace ? (
              <div className="glass-morphism rounded-2xl p-6 border border-slate-800 animate-in fade-in slide-in-from-bottom-2 min-h-[500px] flex flex-col">
                <div className="flex justify-between items-start mb-6">
                  {(() => {
                    const ts = styleFor(selectedTrace.anomaly_type);
                    return (
                      <div>
                        <span className={cn("text-[10px] font-black uppercase px-2 py-0.5 rounded tracking-widest border", ts.text, ts.bg, ts.border)}>
                          {selectedTrace.anomaly_type || "Critical Severity"}
                        </span>
                        <h4 className="text-xl font-bold mt-2">{selectedTrace.anomaly_type ? `${selectedTrace.anomaly_type} in ${selectedTrace.service}` : `Critical Latency Spike in ${selectedTrace.service}`}</h4>
                        <p className="text-xs text-slate-400 flex items-center gap-2 mt-1">
                          <Server className="w-3 h-3" /> {selectedTrace.service} {selectedTrace.route ? `| ${selectedTrace.route}` : ""}
                        </p>
                      </div>
                    );
                  })()}
                  <button onClick={() => setSelectedTrace(null)} className="p-1 hover:bg-slate-800 rounded-full transition-colors">
                    <X className="w-4 h-4 text-slate-500" />
                  </button>
                </div>

                {/* Tabs */}
                <div className="flex gap-6 border-b border-slate-800 mb-6">
                  {["Overview", "Traces", "Logs", "Metrics", "Scores", "AI Analysis"].map(tab => (
                    <button
                      key={tab}
                      onClick={() => handleTabClick(tab)}
                      className={cn(
                        "pb-3 text-xs font-bold transition-all relative",
                        activeTab === tab ? "text-white" : "text-slate-500 hover:text-slate-300"
                      )}
                    >
                      {tab}
                      {activeTab === tab && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]" />}
                    </button>
                  ))}
                </div>

                <div className="flex-1">
                  {isAnalyzing ? (
                    <div className="h-full flex flex-col items-center justify-center gap-4 text-slate-500">
                      <div className="w-12 h-12 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
                      <p className="text-sm font-medium animate-pulse">Consulting AI Assistant...</p>
                    </div>
                  ) : activeTab === "AI Analysis" && analysis ? (
                    <div className="space-y-8 animate-in fade-in duration-500">
                      <div className="relative p-6 bg-indigo-600/5 border border-indigo-500/20 rounded-2xl overflow-hidden">
                        <div className="absolute top-0 right-0 p-4 opacity-10"><Brain size={80} /></div>
                        <h5 className="text-indigo-400 text-xs font-black uppercase tracking-widest flex items-center gap-2 mb-4">
                          <Zap size={14} className="fill-indigo-400" /> Root Cause Analysis
                        </h5>
                        <p className="text-lg font-bold text-slate-100 leading-tight mb-4 tracking-tight">
                          ✨ {analysis.root_cause}
                        </p>
                        <div className="grid grid-cols-2 gap-6 mt-8">
                          <div className="space-y-3">
                            <h6 className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Suggested Fixes</h6>
                            <ul className="space-y-2">
                              {analysis.suggested_fixes.map((f, i) => (
                                <li key={i} className="text-xs text-slate-400 flex items-start gap-2">
                                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 mt-1 flex-shrink-0" />
                                  {f}
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div className="space-y-3">
                            <h6 className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Risk Prediction</h6>
                            <p className="text-xs text-slate-400 leading-relaxed bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                              {analysis.risk_prediction}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Visual Blocks — data-driven from trace context */}
                      <div className="grid grid-cols-3 gap-4">
                        <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
                          <h6 className="text-[9px] font-black text-slate-500 uppercase mb-3">Timeline</h6>
                          <div className="h-2 bg-slate-800 rounded-full relative overflow-hidden">
                            {analysis.traceData?.spans?.map((s, i) => (
                              <div key={i} className={cn("absolute h-full rounded-full", s.type === "API" ? "bg-indigo-500" : s.type === "DATABASE" ? "bg-rose-500" : "bg-emerald-500")}
                                style={{
                                  left: `${((s.start || 0) / (analysis.traceData.duration_ms || 1)) * 100}%`,
                                  width: `${Math.max(4, ((s.duration || 0) / (analysis.traceData.duration_ms || 1)) * 100)}%`,
                                }} />
                            ))}
                          </div>
                          <div className="flex justify-between text-[8px] text-slate-600 mt-2 font-mono">
                            <span>0ms</span>
                            <span className="text-rose-400">{((analysis.traceData?.duration_ms ?? 0) / 2).toFixed(0)}ms</span>
                            <span>{(analysis.traceData?.duration_ms ?? 0).toFixed(0)}ms</span>
                          </div>
                        </div>
                        <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
                          <h6 className="text-[9px] font-black text-slate-500 uppercase mb-3">Affected Services</h6>
                          <div className="flex items-center justify-center gap-2 flex-wrap">
                            {[...new Set(analysis.traceData?.spans?.map(s => s.service) || [])].map((svc, i, arr) => (
                              <React.Fragment key={svc}>
                                <div className={cn("px-2 py-1 rounded text-[8px] font-bold border",
                                  i === arr.length - 1 ? "bg-rose-500/20 border-rose-500/50 text-rose-300" : "bg-slate-800 border-slate-700 text-slate-400"
                                )}>{svc}</div>
                                {i < arr.length - 1 && <div className="w-3 h-px bg-slate-700" />}
                              </React.Fragment>
                            ))}
                          </div>
                        </div>
                        <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
                          <h6 className="text-[9px] font-black text-slate-500 uppercase mb-3">Span Breakdown</h6>
                          <div className="space-y-1.5">
                            {(analysis.traceData?.spans || []).slice(0, 4).map((s, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <div className={cn("h-1 rounded-full", s.type === "API" ? "bg-indigo-500" : s.type === "DATABASE" ? "bg-rose-500" : "bg-emerald-500")}
                                  style={{ width: `${Math.max(10, ((s.duration || 0) / (analysis.traceData.duration_ms || 1)) * 100)}%` }} />
                                <span className="text-[7px] text-slate-500 flex-shrink-0">{(s.duration || 0).toFixed(0)}ms</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
                        <button onClick={() => setSelectedTrace(null)} className="px-4 py-2 text-xs font-bold text-slate-500 hover:text-white transition-colors">Dismiss</button>
                        <button onClick={() => { navigator.clipboard.writeText(JSON.stringify(analysis, null, 2)); alert("Analysis copied to clipboard — ticket created (demo mode)"); }} className="px-6 py-2 bg-white text-slate-950 text-xs font-black uppercase tracking-tight rounded-lg hover:bg-slate-200 transition-colors">Create Ticket</button>
                      </div>
                    </div>
                  ) : activeTab === "Traces" && traceContext ? (
                    <div className="space-y-4 animate-in fade-in">
                      <div className="flex justify-between items-center mb-4">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Detailed Waterfall</label>
                        <span className="text-[10px] text-slate-500 font-mono">Total Duration: {(traceContext.duration_ms ?? 0).toFixed(2)}ms</span>
                      </div>
                      <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                        {traceContext.spans.map((span, i) => (
                          <div key={i} className="group">
                            <div className="flex justify-between text-[10px] mb-1">
                              <span className="text-slate-300 font-bold">{span.service} <span className="text-slate-500 font-medium">| {span.name}</span></span>
                              <span className="text-slate-500 tabular-nums">{span.duration.toFixed(1)}ms</span>
                            </div>
                            <div className="h-2 bg-slate-900 rounded-full relative overflow-hidden ring-1 ring-slate-800">
                              <div
                                className={cn(
                                  "absolute h-full rounded-full transition-all duration-1000",
                                  span.type === "API" ? "bg-indigo-500" : span.type === "DATABASE" ? "bg-rose-500 shadow-[0_0_5px_rgba(244,63,94,0.5)]" : "bg-emerald-500"
                                )}
                                style={{
                                  left: `${(span.start / traceContext.duration_ms) * 100}%`,
                                  width: `${(span.duration / traceContext.duration_ms) * 100}%`,
                                  minWidth: '2px'
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : activeTab === "Logs" ? (
                    <div className="space-y-4 animate-in fade-in">
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2">
                          <FileText className="w-3 h-3" /> Correlated Logs
                        </label>
                        <span className="text-[10px] text-slate-500 font-mono">{traceLogs.length} log{traceLogs.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="max-h-[350px] overflow-y-auto pr-2 custom-scrollbar space-y-1">
                        {traceLogs.length === 0 ? (
                          <div className="text-center py-12 text-slate-600 text-xs">
                            {traceLogsLoading ? "Loading logs..." : "No logs found for this trace"}
                          </div>
                        ) : (
                          traceLogs.map((log, idx) => (
                            <LogRow key={idx} log={log} />
                          ))
                        )}
                      </div>
                    </div>
                  ) : activeTab === "Overview" && selectedTrace ? (
                    <div className="space-y-4 animate-in fade-in">
                      {(() => {
                        const flags = selectedTrace.rule_flags || {};
                        const activePills = RULE_PILLS
                          .map(p => ({ ...p, active: !!flags[p.key], meta: flags[p.metaKey] }))
                          .filter(p => p.active);
                        const mlScores = selectedTrace.ml_scores || {};
                        const mlEntries = Object.entries(mlScores);
                        if (!activePills.length && !mlEntries.length) return null;
                        return (
                          <div className="bg-slate-950/50 p-4 rounded-lg border border-slate-800 space-y-4">
                            {activePills.length > 0 && (
                              <div>
                                <div className="text-[9px] text-slate-500 uppercase font-bold mb-2 tracking-widest">Detectors Fired</div>
                                <div className="flex flex-wrap gap-2">
                                  {activePills.map(p => {
                                    const detail = p.fmt(p.meta);
                                    return (
                                      <span key={p.key} className={cn("text-[10px] font-bold px-2 py-0.5 rounded border", PILL_COLOR[p.color])}>
                                        {p.label}{detail ? ` ${detail}` : ""}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {mlEntries.length > 0 && (
                              <div>
                                <div className="text-[9px] text-slate-500 uppercase font-bold mb-2 tracking-widest">ML Scores</div>
                                <div className="space-y-2">
                                  {mlEntries.map(([name, val]) => {
                                    const pct = Math.max(0, Math.min(1, Number(val) || 0)) * 100;
                                    return (
                                      <div key={name}>
                                        <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                                          <span className="font-mono">{name}</span>
                                          <span className="font-bold text-slate-200">{pct.toFixed(1)}%</span>
                                        </div>
                                        <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden ring-1 ring-slate-800">
                                          <div className="h-full bg-sky-500 rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Incident Overview</label>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                          <div className="text-[9px] text-slate-500 uppercase font-bold mb-1">Service</div>
                          <div className="text-sm font-bold text-slate-200">{selectedTrace.service}</div>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                          <div className="text-[9px] text-slate-500 uppercase font-bold mb-1">Route</div>
                          <div className="text-sm font-bold text-slate-200">{selectedTrace.route || "—"}</div>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                          <div className="text-[9px] text-slate-500 uppercase font-bold mb-1">Duration</div>
                          <div className="text-sm font-bold text-rose-400">{(selectedTrace.duration_ms ?? 0).toFixed(1)}ms</div>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800">
                          <div className="text-[9px] text-slate-500 uppercase font-bold mb-1">Anomaly Score</div>
                          <div className="text-sm font-bold text-amber-400">{(selectedTrace.anomaly_score ?? 0).toFixed(2)}</div>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800 col-span-2">
                          <div className="text-[9px] text-slate-500 uppercase font-bold mb-1">Trace ID</div>
                          <div className="text-xs font-mono text-indigo-400 break-all">{selectedTrace.trace_id}</div>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800 col-span-2">
                          <div className="text-[9px] text-slate-500 uppercase font-bold mb-1">Timestamp</div>
                          <div className="text-xs text-slate-300">{selectedTrace.timestamp ? new Date(selectedTrace.timestamp).toLocaleString() : "—"}</div>
                        </div>
                      </div>
                      {traceContext && (
                        <div className="mt-2 text-[10px] text-slate-500">
                          {traceContext.spans.length} span{traceContext.spans.length !== 1 ? "s" : ""} reconstructed
                        </div>
                      )}
                    </div>
                  ) : activeTab === "Metrics" && selectedTrace ? (
                    <div className="space-y-4 animate-in fade-in">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Service Metrics — {selectedTrace.service}</label>
                      <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                            <XAxis dataKey="time" stroke="#475569" fontSize={9} tickLine={false} axisLine={false} />
                            <YAxis stroke="#475569" fontSize={9} axisLine={false} tickLine={false} />
                            <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px' }} itemStyle={{ color: '#818cf8', fontWeight: 'bold' }} />
                            <Area type="monotone" dataKey="val" stroke="#818cf8" strokeWidth={2} fillOpacity={0.2} fill="#6366f1" isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="text-[10px] text-slate-500 italic">
                        Showing {getMetricTypeForMode(monitoringMode)} for {selectedService === "All Services" ? "all services" : selectedService}
                      </div>
                    </div>
                  ) : activeTab === "Scores" && selectedTrace ? (
                    <div className="space-y-5 animate-in fade-in max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                      {/* ── Anomaly Score Gauge ─────────────────────── */}
                      <div className="bg-slate-950/50 p-5 rounded-xl border border-slate-800">
                        <div className="text-[9px] text-slate-500 uppercase font-bold tracking-widest mb-4">Anomaly Score</div>
                        <div className="flex items-center gap-6">
                          <div className="relative w-20 h-20 flex-shrink-0">
                            <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                              <circle cx="18" cy="18" r="15.91" fill="none" stroke="#1e293b" strokeWidth="3" />
                              <circle cx="18" cy="18" r="15.91" fill="none"
                                stroke={(() => {
                                  const s = selectedTrace.anomaly_score ?? 0;
                                  if (s >= 0.8) return "#f43f5e";
                                  if (s >= 0.5) return "#f59e0b";
                                  return "#10b981";
                                })()}
                                strokeWidth="3" strokeLinecap="round"
                                strokeDasharray={`${(selectedTrace.anomaly_score ?? 0) * 100} ${100 - (selectedTrace.anomaly_score ?? 0) * 100}`}
                                className="transition-all duration-1000"
                              />
                            </svg>
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="text-lg font-black text-white">{(selectedTrace.anomaly_score ?? 0).toFixed(2)}</span>
                            </div>
                          </div>
                          <div className="flex-1 space-y-2">
                            <div className="flex justify-between text-xs">
                              <span className="text-slate-400">Classification</span>
                              <span className={cn("font-bold",
                                (selectedTrace.anomaly_score ?? 0) >= 0.8 ? "text-rose-400" :
                                (selectedTrace.anomaly_score ?? 0) >= 0.5 ? "text-amber-400" : "text-emerald-400"
                              )}>
                                {(selectedTrace.anomaly_score ?? 0) >= 0.8 ? "Critical" :
                                 (selectedTrace.anomaly_score ?? 0) >= 0.5 ? "Warning" : "Low Risk"}
                              </span>
                            </div>
                            <div className="flex justify-between text-xs">
                              <span className="text-slate-400">Anomaly Type</span>
                              <span className={cn("font-bold", styleFor(selectedTrace.anomaly_type).text)}>
                                {selectedTrace.anomaly_type || "Unclassified"}
                              </span>
                            </div>
                            <div className="flex justify-between text-xs">
                              <span className="text-slate-400">Is Anomaly</span>
                              <span className={cn("font-bold", selectedTrace.is_anomaly ? "text-rose-400" : "text-emerald-400")}>
                                {selectedTrace.is_anomaly ? "Yes" : "No"}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* ── ML Model Scores ────────────────────────── */}
                      {(() => {
                        const mlScores = selectedTrace.ml_scores || {};
                        const mlEntries = Object.entries(mlScores);
                        if (!mlEntries.length) return null;
                        return (
                          <div className="bg-slate-950/50 p-5 rounded-xl border border-slate-800">
                            <div className="text-[9px] text-slate-500 uppercase font-bold tracking-widest mb-4">ML Ensemble Scores</div>
                            <div className="space-y-3">
                              {mlEntries.map(([name, val]) => {
                                const pct = Math.max(0, Math.min(1, Number(val) || 0)) * 100;
                                const isHigh = pct > 70;
                                const isMed = pct > 40;
                                return (
                                  <div key={name}>
                                    <div className="flex justify-between text-[11px] mb-1.5">
                                      <span className="text-slate-300 font-medium font-mono">{name}</span>
                                      <span className={cn("font-black tabular-nums",
                                        isHigh ? "text-rose-400" : isMed ? "text-amber-400" : "text-emerald-400"
                                      )}>{Number(val).toFixed(3)}</span>
                                    </div>
                                    <div className="h-2 bg-slate-900 rounded-full overflow-hidden ring-1 ring-slate-800">
                                      <div
                                        className={cn("h-full rounded-full transition-all duration-700",
                                          isHigh ? "bg-gradient-to-r from-rose-600 to-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.4)]" :
                                          isMed ? "bg-gradient-to-r from-amber-600 to-amber-400" :
                                          "bg-gradient-to-r from-emerald-600 to-emerald-400"
                                        )}
                                        style={{ width: `${pct}%` }}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="mt-3 pt-3 border-t border-slate-800 flex justify-between text-[10px]">
                              <span className="text-slate-500">Ensemble Average</span>
                              <span className="text-white font-bold">
                                {(mlEntries.reduce((sum, [, v]) => sum + (Number(v) || 0), 0) / mlEntries.length).toFixed(3)}
                              </span>
                            </div>
                          </div>
                        );
                      })()}

                      {/* ── Rule Detectors ─────────────────────────── */}
                      {(() => {
                        const flags = selectedTrace.rule_flags || {};
                        return (
                          <div className="bg-slate-950/50 p-5 rounded-xl border border-slate-800">
                            <div className="text-[9px] text-slate-500 uppercase font-bold tracking-widest mb-4">Rule Detector Flags</div>
                            <div className="space-y-2">
                              {RULE_PILLS.map(pill => {
                                const active = !!flags[pill.key];
                                const meta = flags[pill.metaKey];
                                const detail = pill.fmt(meta);
                                return (
                                  <div key={pill.key} className={cn(
                                    "flex items-center justify-between p-2.5 rounded-lg border transition-all",
                                    active
                                      ? `${PILL_COLOR[pill.color]} border-opacity-50`
                                      : "bg-slate-900/40 border-slate-800 text-slate-600"
                                  )}>
                                    <div className="flex items-center gap-2.5">
                                      <div className={cn("w-2 h-2 rounded-full",
                                        active ? `bg-${pill.color}-500 shadow-[0_0_6px_rgba(255,255,255,0.2)]` : "bg-slate-700"
                                      )} />
                                      <span className={cn("text-[11px] font-bold", active ? "" : "text-slate-600")}>{pill.label}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {detail && <span className="text-[10px] font-mono font-bold">{detail}</span>}
                                      <span className={cn("text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded",
                                        active ? "bg-white/10 text-white" : "bg-slate-800 text-slate-600"
                                      )}>{active ? "FIRED" : "CLEAR"}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {/* ── Detector Reasons ───────────────────────── */}
                      {(selectedTrace.reasons || []).length > 0 && (
                        <div className="bg-slate-950/50 p-5 rounded-xl border border-slate-800">
                          <div className="text-[9px] text-slate-500 uppercase font-bold tracking-widest mb-3">Detector Reason Tags</div>
                          <div className="flex flex-wrap gap-2">
                            {selectedTrace.reasons.map((reason, i) => (
                              <span key={i} className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
                                {reason}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* ── Event Attributes Grid ──────────────────── */}
                      <div className="bg-slate-950/50 p-5 rounded-xl border border-slate-800">
                        <div className="text-[9px] text-slate-500 uppercase font-bold tracking-widest mb-4">Event Attributes</div>
                        <div className="grid grid-cols-2 gap-3">
                          {[
                            { label: "Service", value: selectedTrace.service, color: "text-indigo-400" },
                            { label: "Route", value: selectedTrace.route || "—", color: "text-slate-200" },
                            { label: "Duration", value: `${(selectedTrace.duration_ms ?? 0).toFixed(1)}ms`, color: "text-rose-400" },
                            { label: "Anomaly Score", value: (selectedTrace.anomaly_score ?? 0).toFixed(4), color: "text-amber-400" },
                            { label: "Trace ID", value: selectedTrace.trace_id, color: "text-indigo-400", mono: true, span: true },
                            { label: "Timestamp", value: selectedTrace.timestamp ? new Date(selectedTrace.timestamp).toLocaleString() : "—", color: "text-slate-300", span: true },
                          ].map((attr, i) => (
                            <div key={i} className={cn("bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/50", attr.span ? "col-span-2" : "")}>
                              <div className="text-[9px] text-slate-500 uppercase font-bold mb-1">{attr.label}</div>
                              <div className={cn("text-xs font-bold break-all", attr.color, attr.mono ? "font-mono" : "")}>{attr.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* ── Raw Event JSON ─────────────────────────── */}
                      <div className="bg-slate-950/50 p-5 rounded-xl border border-slate-800">
                        <div className="flex justify-between items-center mb-3">
                          <div className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Raw Anomaly Event</div>
                          <button
                            onClick={() => navigator.clipboard.writeText(JSON.stringify(selectedTrace, null, 2))}
                            className="text-[9px] text-indigo-400 hover:text-indigo-300 font-bold uppercase tracking-wider px-2 py-0.5 rounded border border-indigo-500/30 hover:border-indigo-500/50 transition-all"
                          >
                            Copy JSON
                          </button>
                        </div>
                        <pre className="text-[10px] text-slate-400 font-mono bg-slate-900/60 p-3 rounded-lg border border-slate-800/50 max-h-48 overflow-y-auto custom-scrollbar leading-relaxed whitespace-pre-wrap">
                          {JSON.stringify(selectedTrace, null, 2)}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center text-slate-600 text-xs italic">
                      Select a tab to view data.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="py-20 text-center border-2 border-dashed border-slate-800 rounded-2xl text-slate-500">
                <Search className="w-10 h-10 mx-auto mb-4 opacity-20" />
                <p className="text-sm font-medium">Select an incident to investigate root cause</p>
              </div>
            )}
          </div>
        </div>
        {/* PII Redaction Density — paper §IV-C novel security primitive */}
        <div className="mt-8">
          <PIIRedactionPanel backendUrl={BACKEND_URL} />
        </div>
      </main>
    </div>
  );
}

function AnomalyRow({ item, onClick }) {
  const style = styleFor(item.anomaly_type);
  return (
    <div
      onClick={onClick}
      className="group bg-slate-900/40 p-3 rounded-xl border border-slate-800/50 hover:border-slate-700 hover:bg-slate-800/40 transition-all cursor-pointer flex items-center justify-between"
    >
      <div className="flex items-center gap-4 min-w-0">
        <div className={cn("w-2 h-8 rounded-full flex items-center justify-center", style.bg)}>
          <div className={cn("w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(244,63,94,0.5)]", style.dot)} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-bold text-slate-200 truncate">{item.service} <span className="text-slate-500 font-medium">→ {item.route}</span></div>
            {item.anomaly_type && (
              <span className={cn("text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border", style.text, style.bg, style.border)}>
                {item.anomaly_type}
              </span>
            )}
          </div>
          <div className="text-[10px] text-slate-500 font-mono">#{(item.trace_id ?? "").slice(0, 12)} • {new Date(item.timestamp).toLocaleTimeString()}</div>
        </div>
      </div>
      <div className="text-right flex items-center gap-2">
        <div className="text-sm font-black text-rose-500">{(item.duration_ms ?? 0).toFixed(0)}ms</div>
        <ChevronRight className="w-4 h-4 text-slate-600 group-hover:translate-x-1 transition-transform" />
      </div>
    </div>
  );
}

function PIIRedactionPanel({ backendUrl }) {
  const [series, setSeries] = useState({ "api-gateway": [], "python-service": [] });

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      try {
        const [gw, py] = await Promise.all([
          fetch(`${backendUrl}/api/metrics/api-gateway/redaction_count`).then(r => r.ok ? r.json() : []),
          fetch(`${backendUrl}/api/metrics/python-service/redaction_count`).then(r => r.ok ? r.json() : []),
        ]);
        if (!cancelled) setSeries({ "api-gateway": gw, "python-service": py });
      } catch {}
    };
    fetchAll();
    const id = setInterval(fetchAll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [backendUrl]);

  const chartData = useMemo(() => {
    const merged = {};
    for (const [svc, rows] of Object.entries(series)) {
      for (const r of rows) {
        const t = new Date(r.timestamp).toLocaleTimeString();
        if (!merged[t]) merged[t] = { time: t };
        merged[t][svc] = r.value;
      }
    }
    return Object.values(merged).slice(-30);
  }, [series]);

  const latest = {
    gw: series["api-gateway"].slice(-1)[0]?.value ?? 0,
    py: series["python-service"].slice(-1)[0]?.value ?? 0,
  };
  const total = (latest.gw + latest.py).toFixed(0);

  return (
    <div className="bg-slate-900/40 border border-slate-800/80 p-6 rounded-2xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h6 className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
            <Shield className="w-3 h-3 text-emerald-400" />
            PII Redaction Density
          </h6>
          <p className="text-[10px] text-slate-600 mt-1 italic">Paper §IV-C — novel security primitive derived from redaction-token counts</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-black text-emerald-400">{total}</div>
          <div className="text-[10px] text-slate-500 uppercase tracking-widest">total tokens redacted</div>
        </div>
      </div>
      <div className="h-40">
        {chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-600">
            No redaction events yet. Run <code className="text-slate-400 mx-1">./traffic.sh 60 pii</code> to populate.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="redact-gw" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="redact-py" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#818cf8" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#818cf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
              <XAxis dataKey="time" stroke="#475569" fontSize={10} tickLine={false} axisLine={false} />
              <YAxis stroke="#475569" fontSize={10} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px' }} />
              <Area type="monotone" dataKey="api-gateway" stroke="#10b981" strokeWidth={2} fill="url(#redact-gw)" isAnimationActive={false} />
              <Area type="monotone" dataKey="python-service" stroke="#818cf8" strokeWidth={2} fill="url(#redact-py)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function Toggle({ label, active, onClick }) {
  return (
    <div className="flex items-center justify-between group cursor-pointer" onClick={onClick}>
      <span className="text-xs text-slate-400 group-hover:text-slate-200 transition-colors font-medium">{label}</span>
      <div className={cn(
        "w-8 h-4 rounded-full transition-all relative",
        active ? "bg-indigo-600" : "bg-slate-800"
      )}>
        <div className={cn(
          "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all shadow-sm",
          active ? "left-[18px]" : "left-0.5"
        )} />
      </div>
    </div>
  );
}

function LogRow({ log, onTraceClick }) {
  const severityColors = {
    DEBUG: "text-slate-500 bg-slate-500/10",
    INFO: "text-blue-400 bg-blue-400/10",
    WARNING: "text-amber-400 bg-amber-400/10",
    WARN: "text-amber-400 bg-amber-400/10",
    ERROR: "text-rose-400 bg-rose-400/10",
    FATAL: "text-red-500 bg-red-500/10 font-black",
  };
  const colorClass = severityColors[log.severity] || severityColors.INFO;

  return (
    <div className="flex items-start gap-3 py-1.5 px-2 rounded-md hover:bg-slate-800/40 transition-colors text-[11px] font-mono group">
      <span className="text-slate-600 flex-shrink-0 w-20 tabular-nums">
        {new Date(log.timestamp).toLocaleTimeString()}
      </span>
      <span className={cn("flex-shrink-0 w-14 text-center rounded px-1 py-0.5 text-[9px] font-black uppercase", colorClass)}>
        {log.severity}
      </span>
      <span className="text-indigo-400 flex-shrink-0 w-28 truncate">
        {log.service_name}
      </span>
      <span className="text-slate-300 flex-1 truncate" title={log.body}>
        {log.body}
      </span>
      {log.trace_id && onTraceClick && (
        <button
          onClick={(e) => { e.stopPropagation(); onTraceClick(); }}
          className="flex-shrink-0 text-[9px] text-indigo-400 hover:text-indigo-300 opacity-0 group-hover:opacity-100 transition-opacity border border-indigo-500/30 rounded px-1.5 py-0.5"
        >
          Trace
        </button>
      )}
    </div>
  );
}

const statCardColorMap = {
  indigo: "text-indigo-400 bg-indigo-400/10",
  rose: "text-rose-400 bg-rose-400/10",
  emerald: "text-emerald-400 bg-emerald-400/10",
};

function StatCard({ label, value, trend, color, series }) {
  const stroke = color === 'indigo' ? '#6366f1' : color === 'rose' ? '#f43f5e' : '#10b981';
  const gradId = `spark-grad-${color}`;
  const hasData = Array.isArray(series) && series.length >= 2;
  const sparkPath = hasData
    ? smoothPath(series, { width: 100, height: 20, padding: 2 })
    : "M 0 15 Q 10 5, 20 15 T 40 15 T 60 5 T 80 15 T 100 10";
  const areaPath = hasData ? `${sparkPath} L 100 20 L 0 20 Z` : null;
  return (
    <div className="bg-slate-900/40 border border-slate-800/50 p-6 rounded-2xl relative overflow-hidden group hover:border-slate-700 transition-all">
      <div className="flex justify-between items-start mb-6">
        <div className="space-y-1">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{label}</div>
          <div className="text-2xl font-black text-white">{value}</div>
        </div>
        <div className={cn("text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded", statCardColorMap[color] || "text-slate-400 bg-slate-400/10")}>
          {trend}
        </div>
      </div>

      <div className="h-12 w-full mt-4">
        <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="w-full h-full overflow-visible">
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          {areaPath && <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />}
          <path
            d={sparkPath}
            fill="none"
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className={hasData ? "" : "animate-wave"}
          />
        </svg>
      </div>
    </div>
  );
}
