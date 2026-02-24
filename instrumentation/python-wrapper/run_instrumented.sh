#!/bin/bash

# Default Collector Endpoint (Switch to HTTP for better reliability)
COLLECTOR_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT:-"http://localhost:4318"}
SERVICE_NAME=${OTEL_SERVICE_NAME:-"python-service"}

echo "Starting Python Service with OTel Instrumentation..."
echo "Service Name: $SERVICE_NAME"
echo "Collector: $COLLECTOR_ENDPOINT"

# Enable Log Auto-Instrumentation & Correlation
export OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED=true
export OTEL_PYTHON_LOG_CORRELATION=true

# Export standard OTel vars
export OTEL_SERVICE_NAME=$SERVICE_NAME
export OTEL_EXPORTER_OTLP_ENDPOINT=$COLLECTOR_ENDPOINT
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"

# Run the application with auto-instrumentation
/home/deadiu/BE_Project/venv/bin/opentelemetry-instrument \
    "$@"
