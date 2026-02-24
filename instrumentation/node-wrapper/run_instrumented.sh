#!/bin/bash

# Default Collector Endpoint (HTTP for Node.js auto-instrumentation is common)
COLLECTOR_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT:-"http://localhost:4318"}
SERVICE_NAME=${OTEL_SERVICE_NAME:-"node-service"}

echo "Starting Node.js Service with OTel Instrumentation..."
echo "Service Name: $SERVICE_NAME"
echo "Collector: $COLLECTOR_ENDPOINT"

# Export standard OTel vars
export OTEL_SERVICE_NAME=$SERVICE_NAME
export OTEL_EXPORTER_OTLP_ENDPOINT=$COLLECTOR_ENDPOINT

# Enable auto-instrumentation via register
export NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"

# Run the application
# Usage: ./run_instrumented.sh <your_app_start_command>
# Example: ./run_instrumented.sh node index.js
exec "$@"
