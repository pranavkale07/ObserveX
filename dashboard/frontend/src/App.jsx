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

const BACKEND_URL = "http://localhost:8000";
const WS_URL = "ws://localhost:8000/ws";

export default function App() {
  const [anomalies, setAnomalies] = useState([]);
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
  const ws = useRef(null);

  // Load history and initialize WS
  useEffect(() => {
    fetchHistory();
    connectWS();
    return () => ws.current?.close();
  }, []);

  const fetchHistory = async () => {
    try {
      const alertRes = await fetch(`${BACKEND_URL}/api/alerts`);
      const alertData = await alertRes.json();
      setAnomalies(alertData);

      // Fetch metrics history for current service context
      const metricType = getMetricTypeForMode(monitoringMode);
      const metricRes = await fetch(`${BACKEND_URL}/api/metrics/${selectedService}/${metricType}`);
      const metricData = await metricRes.json();
      setMetrics(metricData);
    } catch (err) { console.error(err); }
  };

  const getMetricTypeForMode = (mode) => {
    if (mode === "Security (Redaction)") return "redaction_count";
    if (mode === "Bimodal Analysis") return "p99_latency";
    return "p99_latency";
  };

  const connectWS = () => {
    ws.current = new WebSocket(WS_URL);
    ws.current.onopen = () => setStatus("connected");
    ws.current.onclose = () => {
      setStatus("disconnected");
      setTimeout(connectWS, 2000);
    };
    ws.current.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "new_anomaly") {
        setAnomalies(prev => [msg.data, ...prev].slice(0, 50));
      } else if (msg.type === "metric_update") {
        setMetrics(prev => [...prev, msg.data].slice(-60));
      } else if (msg.type === "history") {
        setAnomalies(msg.data);
      }
    };
  };

  const runRCA = async (alert) => {
    setSelectedTrace(alert);
    setIsAnalyzing(false);
    setAnalysis(null);
    setTraceContext(null);
    setTraceLogs([]);
    setActiveTab("Traces");
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

      // 2. Fetch correlated logs for this trace
      const logRes = await fetch(`${BACKEND_URL}/api/logs?trace_id=${alert.trace_id}`);
      const logData = await logRes.json();
      setTraceLogs(logData);
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
        const response = await fetch(`${BACKEND_URL}/api/rca/${traceContext.trace_id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(traceContext)
        });
        const data = await response.json();
        setAnalysis({ ...data, traceData: traceContext });
      } catch (err) {
        console.error("AI Analysis Failed:", err);
        setAnalysis({
          root_cause: "AI analysis is currently unavailable.",
          suggested_fixes: ["Check GEMINI_API_KEY configuration", "Try again in a few moments"],
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
            {["All Services", "api-gateway", "python-service", "node-service"].map(svc => (
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
                {selectedService === svc && <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_indigo]" />}
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

          <div className="bg-indigo-600/10 border border-indigo-500/20 p-4 rounded-xl mt-6">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping" />
              <span className="text-[10px] uppercase font-black text-indigo-400 tracking-widest">AI Insight</span>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              Detecting a 15% drift in latency across **python-service**. Possible database deadlock.
            </p>
            <button className="w-full mt-3 py-2 bg-indigo-600 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-indigo-500 transition-colors">
              Investigate Root Cause
            </button>
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
            <select className="bg-transparent text-xs text-slate-400 font-medium focus:outline-none border-r border-slate-800 pr-4">
              <option>Region: us-east-1</option>
              <option>Region: eu-west-1</option>
            </select>
          </div>

          <div className="flex-1 max-w-md mx-8 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search traces, logs, spans..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 pl-10 pr-4 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
            />
          </div>

          <div className="flex items-center gap-4">
            <div className="px-3 py-1.5 bg-slate-950 rounded-full border border-slate-800 text-xs flex items-center gap-2">
              <div className={cn("w-2 h-2 rounded-full", status === "connected" ? "bg-emerald-500 animate-pulse" : "bg-red-500")} />
              <span className="text-slate-400 uppercase font-black text-[9px]">{liveMode ? "Live" : "Paused"}</span>
            </div>
            <button className="relative p-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors">
              <RefreshCcw className="w-4 h-4" />
            </button>
            <button className="flex items-center gap-2 px-4 py-2 bg-indigo-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20">
              <Brain className="w-4 h-4" />
              AI Assistant
            </button>
          </div>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-6 mb-8">
          <StatCard label="Throughput (RPM)" value="1.2M" trend="+12.4%" icon={<Activity className="text-indigo-400" />} color="indigo" />
          <StatCard label="P99 Latency" value="482ms" trend="Critical" icon={<Clock3 className="text-rose-400" />} color="rose" />
          <StatCard label="Error Rate" value="0.02%" trend="Normal" icon={<Shield className="text-emerald-400" />} color="emerald" />
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
                <Area type="monotone" dataKey="val" stroke="#818cf8" strokeWidth={3} fillOpacity={1} fill="url(#colorVal)" />
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
            <div className="space-y-3">
              {anomalies.map((item, idx) => (
                <AnomalyRow key={idx} item={item} onClick={() => runRCA(item)} />
              ))}
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
                  <div>
                    <span className="text-[10px] font-black uppercase text-rose-500 bg-rose-500/10 px-2 py-0.5 rounded tracking-widest border border-rose-500/20">Critical Severity</span>
                    <h4 className="text-xl font-bold mt-2">Critical Latency Spike in {selectedTrace.service}</h4>
                    <p className="text-xs text-slate-400 flex items-center gap-2 mt-1">
                      <Server className="w-3 h-3" /> {selectedTrace.service} | Region: us-east-1
                    </p>
                  </div>
                  <button onClick={() => setSelectedTrace(null)} className="p-1 hover:bg-slate-800 rounded-full transition-colors">
                    <X className="w-4 h-4 text-slate-500" />
                  </button>
                </div>

                {/* Tabs */}
                <div className="flex gap-6 border-b border-slate-800 mb-6">
                  {["Overview", "Traces", "Logs", "Metrics", "AI Analysis"].map(tab => (
                    <button
                      key={tab}
                      onClick={() => handleTabClick(tab)}
                      className={cn(
                        "pb-3 text-xs font-bold transition-all relative",
                        activeTab === tab ? "text-white" : "text-slate-500 hover:text-slate-300"
                      )}
                    >
                      {tab}
                      {activeTab === tab && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-500 shadow-[0_0_8px_indigo]" />}
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

                      {/* Visual Blocks per Photo 3 */}
                      <div className="grid grid-cols-3 gap-4">
                        <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
                          <h6 className="text-[9px] font-black text-slate-500 uppercase mb-3">Timeline</h6>
                          <div className="h-2 bg-slate-800 rounded-full relative overflow-hidden">
                            <div className="absolute left-1/4 w-1/2 h-full bg-rose-500 shadow-[0_0_10px_rose]" />
                          </div>
                          <div className="flex justify-between text-[8px] text-slate-600 mt-2 font-mono uppercase">
                            <span>14:00</span>
                            <span className="text-rose-400">14:20 (Spike)</span>
                            <span>14:40</span>
                          </div>
                        </div>
                        <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
                          <h6 className="text-[9px] font-black text-slate-500 uppercase mb-3">Affected Services</h6>
                          <div className="flex items-center justify-center gap-2">
                            <div className="w-6 h-6 rounded bg-slate-800 flex items-center justify-center text-[8px]">UI</div>
                            <div className="w-1 h-px bg-slate-700" />
                            <div className="w-8 h-8 rounded bg-amber-500/20 border border-amber-500/50 flex items-center justify-center text-[10px] font-bold">API</div>
                            <div className="w-1 h-px bg-slate-700" />
                            <div className="w-6 h-6 rounded bg-rose-500 border border-rose-500 flex items-center justify-center text-[8px] font-bold shadow-[0_0_8px_rose]">DB</div>
                          </div>
                        </div>
                        <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl">
                          <h6 className="text-[9px] font-black text-slate-500 uppercase mb-3">Trace Waterfall</h6>
                          <div className="space-y-1.5 opacity-50">
                            {[1, 2, 3].map(i => (
                              <div key={i} className={`h-1 rounded-full ${i === 2 ? 'bg-rose-500 w-full' : 'bg-slate-700 w-1/2'}`} style={{ marginLeft: `${i * 10}%` }} />
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
                        <button onClick={() => setSelectedTrace(null)} className="px-4 py-2 text-xs font-bold text-slate-500 hover:text-white transition-colors">Dismiss</button>
                        <button className="px-6 py-2 bg-white text-slate-950 text-xs font-black uppercase tracking-tight rounded-lg hover:bg-slate-200 transition-colors">Create Ticket</button>
                      </div>
                    </div>
                  ) : activeTab === "Traces" && traceContext ? (
                    <div className="space-y-4 animate-in fade-in">
                      <div className="flex justify-between items-center mb-4">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Detailed Waterfall</label>
                        <span className="text-[10px] text-slate-500 font-mono">Total Duration: {traceContext.duration_ms.toFixed(2)}ms</span>
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
                  ) : (
                    <div className="h-full flex items-center justify-center text-slate-600 text-xs italic">
                      Tab context coming soon or data loading...
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
        {/* Resource Saturation per Photo 4 */}
        <div className="grid grid-cols-2 gap-6 mt-8">
          <div className="bg-slate-900/40 border border-slate-800/80 p-6 rounded-2xl group">
            <div className="flex justify-between items-center mb-6">
              <h6 className="text-[10px] font-black uppercase text-slate-500 tracking-widest">CPU Usage / Pod</h6>
              <span className="text-[8px] text-slate-600 font-mono">60s window</span>
            </div>
            <div className="flex items-end gap-1.5 h-24">
              {[40, 60, 45, 90, 55, 70, 40, 31, 25, 45, 65, 85].map((h, i) => (
                <div key={i} className={cn(
                  "flex-1 rounded-t-sm transition-all duration-1000",
                  h > 80 ? "bg-rose-500 shadow-[0_0_10px_rose]" : "bg-indigo-500/20 group-hover:bg-indigo-500/60"
                )} style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
          <div className="bg-slate-900/40 border border-slate-800/80 p-6 rounded-2xl group">
            <div className="flex justify-between items-center mb-6">
              <h6 className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Memory Saturation</h6>
              <span className="text-[8px] text-indigo-400 font-mono italic">Live Streams</span>
            </div>
            <div className="h-24 w-full">
              <svg viewBox="0 0 100 20" className="w-full h-full overflow-visible">
                <path
                  d="M0 15 Q 20 18, 40 10 T 80 5 T 100 15"
                  fill="none"
                  stroke="#818cf8"
                  strokeWidth="2"
                  className="animate-wave"
                />
              </svg>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function AnomalyRow({ item, onClick }) {
  return (
    <div
      onClick={onClick}
      className="group bg-slate-900/40 p-3 rounded-xl border border-slate-800/50 hover:border-slate-700 hover:bg-slate-800/40 transition-all cursor-pointer flex items-center justify-between"
    >
      <div className="flex items-center gap-4">
        <div className="w-2 h-8 rounded-full bg-rose-500/20 flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-rose-500 shadow-[0_0_8px_rose]" />
        </div>
        <div>
          <div className="text-sm font-bold text-slate-200">{item.service} <span className="text-slate-500 font-medium">→ {item.route}</span></div>
          <div className="text-[10px] text-slate-500 font-mono">#{item.trace_id.slice(0, 12)} • {new Date(item.timestamp).toLocaleTimeString()}</div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-black text-rose-500">{item.duration_ms.toFixed(0)}ms</div>
        <ChevronRight className="w-4 h-4 text-slate-600 group-hover:translate-x-1 transition-transform" />
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
          active ? "left-4.5" : "left-0.5"
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

function StatCard({ label, value, trend, icon, color }) {
  return (
    <div className="bg-slate-900/40 border border-slate-800/50 p-6 rounded-2xl relative overflow-hidden group hover:border-slate-700 transition-all">
      <div className="flex justify-between items-start mb-6">
        <div className="space-y-1">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{label}</div>
          <div className="text-2xl font-black text-white">{value}</div>
        </div>
        <div className={cn("text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded", `text-${color}-400 bg-${color}-400/10`)}>
          {trend}
        </div>
      </div>

      {/* Sparkline Wave */}
      <div className="h-12 w-full mt-4">
        <svg viewBox="0 0 100 20" className="w-full h-full overflow-visible">
          <path
            d="M0 15 Q 10 5, 20 15 T 40 15 T 60 5 T 80 15 T 100 10"
            fill="none"
            stroke={color === 'indigo' ? '#6366f1' : color === 'rose' ? '#f43f5e' : '#10b981'}
            strokeWidth="1.5"
            strokeLinecap="round"
            className="animate-wave"
          />
        </svg>
      </div>
    </div>
  );
}
