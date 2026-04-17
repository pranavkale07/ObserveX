#!/bin/bash

# ObserverAI Master Startup Script
# This script starts the entire forensics-ready telemetry stack.

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$PROJECT_DIR/venv/bin"

echo "🚀 [1/6] Starting Infrastructure (OTel Collector)..."
cd "$PROJECT_DIR/infra/otel-collector"
docker compose down
docker compose up -d

echo "🐇 [2/6] Configuring Local RabbitMQ..."
# Ensure stream plugin is enabled on the host
sudo rabbitmq-plugins enable rabbitmq_stream rabbitmq_management || echo "⚠️  Could not enable plugins via sudo. Please ensure rabbitmq_stream is enabled manually."

# Declare the telemetry stream queue via Python AMQP
"$VENV/python" -c "
import pika
try:
    connection = pika.BlockingConnection(pika.ConnectionParameters(
        host='localhost',
        credentials=pika.PlainCredentials('telemetry', 'telemetry_password')
    ))
    channel = connection.channel()
    channel.queue_declare(queue='otel-telemetry', durable=True, arguments={'x-queue-type': 'stream'})
    print('✅ Queue otel-telemetry declared successfully.')
    connection.close()
except Exception as e:
    print(f'❌ Failed to declare queue: {e}')
"

echo "🧠 [3/6] Starting Dashboard Backend..."
cd "$PROJECT_DIR/dashboard/backend"
pkill -9 -f "dashboard/backend/main.py" || true
nohup "$VENV/python" "$PROJECT_DIR/dashboard/backend/main.py" > backend_p5.log 2>&1 &
echo "✅ Dashboard Backend started on port 8000."

echo "🌊 [4/6] Starting Bytewax Stream Processor..."
cd "$PROJECT_DIR/stream-processor"
pkill -9 -f "bytewax.run dataflow:flow" || true
nohup "$VENV/python" -m bytewax.run dataflow:flow > bytewax_p5.log 2>&1 &
echo "✅ Bytewax Stream Processor active."

echo "🏭 [5/6] Starting Instrumented Microservices..."
# API Gateway
cd "$PROJECT_DIR/microservices/api-gateway"
pkill -9 -f "microservices/api-gateway/index.js" || true
OTEL_SERVICE_NAME=api-gateway "$PROJECT_DIR/instrumentation/node-wrapper/run_instrumented.sh" node "$PROJECT_DIR/microservices/api-gateway/index.js" > gateway.log 2>&1 &

# Quote Service
cd "$PROJECT_DIR/microservices/quote-service"
pkill -9 -f "microservices/quote-service/main.py" || true
OTEL_SERVICE_NAME=python-service "$PROJECT_DIR/instrumentation/python-wrapper/run_instrumented.sh" "$VENV/python" "$PROJECT_DIR/microservices/quote-service/main.py" > quote_service.log 2>&1 &
echo "✅ Microservices started with Auto-Instrumentation."

echo "🖥️  [6/6] Starting Dashboard Frontend..."
cd "$PROJECT_DIR/dashboard/frontend"
pkill -9 -f "vite.*dashboard/frontend" || true
if [ ! -d "node_modules" ]; then
  echo "📦 Installing frontend dependencies..."
  npm install
fi
nohup npm run dev > frontend.log 2>&1 &
echo "✅ Dashboard Frontend starting on port 5173."

echo "--------------------------------------------------"
echo "✨ ObserverAI Premium Stack is LIVE!"
echo "Dashboard: http://localhost:5173"
echo "Backend API: http://localhost:8000/docs"
echo "RabbitMQ Mgmt: http://localhost:15672 (guest/guest)"
echo ""
echo "Generate traffic with: ./traffic.sh [duration] [mode] [rps]"
echo "  e.g., ./traffic.sh 60 mixed 3"
echo "--------------------------------------------------"
