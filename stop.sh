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

echo "[6/6] Cleaning up stale log files, telemetry DB & RabbitMQ stream..."
# Delete & re-declare the stream queue to drop buffered messages.
"$PROJECT_DIR/venv/bin/python" -c "
import pika
try:
    conn = pika.BlockingConnection(pika.ConnectionParameters(
        host='localhost',
        credentials=pika.PlainCredentials('telemetry','telemetry_password')))
    ch = conn.channel()
    ch.queue_delete(queue='otel-telemetry')
    print('  otel-telemetry stream purged.')
    conn.close()
except Exception as e:
    print(f'  stream purge skipped ({e})')
" 2>/dev/null
rm -f "$PROJECT_DIR/dashboard/backend/backend_p5.log"
rm -f "$PROJECT_DIR/stream-processor/bytewax_p5.log"
rm -f "$PROJECT_DIR/microservices/api-gateway/gateway.log"
rm -f "$PROJECT_DIR/microservices/quote-service/quote_service.log"
rm -f "$PROJECT_DIR/dashboard/frontend/frontend.log"
rm -f "$PROJECT_DIR/dashboard/backend/telemetry.db"
echo "  telemetry.db cleared."

echo "--------------------------------------------------"
echo "All services stopped."
echo "--------------------------------------------------"
