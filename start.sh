#!/bin/bash

# ObserverAI Master Startup Script
# This script starts the entire forensics-ready telemetry stack.

echo "🚀 [1/6] Starting Infrastructure (OTel Collector)..."
cd /home/deadiu/BE_Project/infra/otel-collector
docker compose down
docker compose up -d

echo "🐇 [2/6] Configuring Local RabbitMQ..."
# Ensure stream plugin is enabled on the host
sudo rabbitmq-plugins enable rabbitmq_stream rabbitmq_management || echo "⚠️  Could not enable plugins via sudo. Please ensure rabbitmq_stream is enabled manually."

# Declare the telemetry stream queue via Python AMQP
/home/deadiu/BE_Project/stream-processor/venv/bin/python -c "
import pika
try:
    connection = pika.BlockingConnection(pika.ConnectionParameters(
        host='172.17.0.1',
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
cd /home/deadiu/BE_Project/dashboard/backend
# Kill old instances (specific to this directory)
pkill -9 -f "/home/deadiu/BE_Project/dashboard/backend/main.py" || true
nohup /home/deadiu/BE_Project/stream-processor/venv/bin/python /home/deadiu/BE_Project/dashboard/backend/main.py > backend_p5.log 2>&1 &
echo "✅ Dashboard Backend started on port 8000."

echo "🌊 [4/6] Starting Bytewax Stream Processor..."
cd /home/deadiu/BE_Project/stream-processor
# Kill old instances
pkill -9 -f "bytewax.run dataflow:flow" || true
nohup ./venv/bin/python -m bytewax.run dataflow:flow > bytewax_p5.log 2>&1 &
echo "✅ Bytewax Stream Processor active."

echo "🏭 [5/6] Starting Instrumented Microservices..."
# API Gateway
cd /home/deadiu/BE_Project/microservices/api-gateway
pkill -9 -f "/home/deadiu/BE_Project/microservices/api-gateway/index.js" || true
OTEL_SERVICE_NAME=api-gateway /home/deadiu/BE_Project/instrumentation/node-wrapper/run_instrumented.sh node /home/deadiu/BE_Project/microservices/api-gateway/index.js > gateway.log 2>&1 &

# Quote Service
cd /home/deadiu/BE_Project/microservices/quote-service
pkill -9 -f "/home/deadiu/BE_Project/microservices/quote-service/main.py" || true
OTEL_SERVICE_NAME=python-service /home/deadiu/BE_Project/instrumentation/python-wrapper/run_instrumented.sh /home/deadiu/BE_Project/venv/bin/python /home/deadiu/BE_Project/microservices/quote-service/main.py > quote_service.log 2>&1 &
echo "✅ Microservices started with Auto-Instrumentation."

echo "🚦 [6/6] Triggering Baseline Traffic..."
for i in {1..20}; do
  curl -s http://localhost:3001/api/proxy-slow-quote > /dev/null
  curl -s http://localhost:3001/api/proxy-n-plus-1 > /dev/null
  sleep 0.1
done
echo "✅ Baseline traffic triggered."

echo "--------------------------------------------------"
echo "✨ ObserverAI Premium Stack is LIVE!"
echo "Dashboard: http://localhost:5173"
echo "Backend API: http://localhost:8000/docs"
echo "RabbitMQ Mgmt: http://localhost:15672 (guest/guest)"
echo "--------------------------------------------------"
