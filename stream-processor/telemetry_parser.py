from datetime import datetime, timezone

def extract_resource_attr(resource, key):
    for attr in resource.get("attributes", []):
        if attr.get("key") == key:
            return attr.get("value", {}).get("stringValue")
    return None

def extract_span_attr(span, key):
    for attr in span.get("attributes", []):
        if attr.get("key") == key:
            return attr.get("value", {}).get("stringValue")
    return None

def parse_trace(trace_payload):
    results = []
    for rs in trace_payload.get("resourceSpans", []):
        service_name = extract_resource_attr(rs.get("resource", {}), "service.name")
        for ss in rs.get("scopeSpans", []):
            for span in ss.get("spans", []):
                start_time = int(span.get("startTimeUnixNano", 0))
                end_time = int(span.get("endTimeUnixNano", 0))
                duration_ms = (end_time - start_time) / 1_000_000 if start_time and end_time else 0
                
                results.append({
                    "trace_id": span.get("traceId"),
                    "span_id": span.get("spanId"),
                    "parent_span_id": span.get("parentSpanId"),
                    "service_name": service_name,
                    "span_name": span.get("name"),
                    "route": extract_span_attr(span, "http.route") or span.get("name"),
                    "duration_ms": duration_ms,
                    "start_time": datetime.fromtimestamp(start_time / 1_000_000_000, tz=timezone.utc).isoformat(),
                    "status_code": span.get("status", {}).get("code", 0)
                })
    return results

def parse_log(log_payload):
    results = []
    for rl in log_payload.get("resourceLogs", []):
        service_name = extract_resource_attr(rl.get("resource", {}), "service.name")
        for sl in rl.get("scopeLogs", []):
            for log in sl.get("logRecords", []):
                time_nano = int(log.get("timeUnixNano", 0))
                timestamp = datetime.fromtimestamp(
                    time_nano / 1_000_000_000, tz=timezone.utc
                ).isoformat() if time_nano else datetime.now(timezone.utc).isoformat()

                results.append({
                    "trace_id": log.get("traceId", ""),
                    "span_id": log.get("spanId", ""),
                    "service_name": service_name,
                    "body": log.get("body", {}).get("stringValue", ""),
                    "severity": log.get("severityText", "INFO"),
                    "timestamp": timestamp
                })
    return results
