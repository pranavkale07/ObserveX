#!/bin/bash

# ObserverAI Stop Script
# Cleanly shuts down all services

echo "Stopping ObserverAI Stack..."

echo "[1/6] Stopping Microservices..."
pkill -f "api-gateway/index.js" 2>/dev/null && echo "  API Gateway stopped." || echo "  API Gateway not running."
pkill -f "quote-service/main.py" 2>/dev/null && echo "  Quote Service stopped." || echo "  Quote Service not running."

echo "[2/6] Stopping Bytewax Stream Processor..."
pkill -f "bytewax.run dataflow:flow" 2>/dev/null && echo "  Bytewax stopped." || echo "  Bytewax not running."

echo "[3/6] Stopping Dashboard Backend..."
pkill -f "dashboard/backend/main.py" 2>/dev/null && echo "  Backend stopped." || echo "  Backend not running."

echo "[4/6] Stopping Dashboard Frontend..."
pkill -f "vite.*dashboard/frontend" 2>/dev/null && echo "  Frontend stopped." || echo "  Frontend not running."

echo "[5/6] Stopping OTel Collector..."
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR/infra/otel-collector"
docker compose down 2>/dev/null && echo "  OTel Collector stopped." || echo "  OTel Collector not running."

echo "[6/6] Cleaning up stale log files..."
rm -f "$PROJECT_DIR/dashboard/backend/backend_p5.log"
rm -f "$PROJECT_DIR/stream-processor/bytewax_p5.log"
rm -f "$PROJECT_DIR/microservices/api-gateway/gateway.log"
rm -f "$PROJECT_DIR/microservices/quote-service/quote_service.log"
rm -f "$PROJECT_DIR/dashboard/frontend/frontend.log"

echo "--------------------------------------------------"
echo "All services stopped."
echo "--------------------------------------------------"
