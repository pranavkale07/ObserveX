#!/bin/bash

# ObserverAI Status Script
# Quick health check of all components

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

check_process() {
    if pgrep -f "$1" > /dev/null 2>&1; then
        echo -e "  ${GREEN}RUNNING${NC}  $2"
    else
        echo -e "  ${RED}DOWN${NC}     $2"
    fi
}

check_http() {
    if curl -s --max-time 2 "$1" > /dev/null 2>&1; then
        echo -e "  ${GREEN}HEALTHY${NC}  $2 ($1)"
    else
        echo -e "  ${RED}UNREACHABLE${NC} $2 ($1)"
    fi
}

echo "=========================================="
echo "  ObserverAI Stack Status"
echo "=========================================="

echo ""
echo "PROCESSES:"
check_process "api-gateway/index.js" "API Gateway"
check_process "quote-service/main.py" "Quote Service"
check_process "bytewax.run dataflow:flow" "Bytewax Stream Processor"
check_process "dashboard/backend/main.py" "Dashboard Backend"

echo ""
echo "DOCKER:"
if docker ps --filter name=otel-collector --format '{{.Status}}' 2>/dev/null | grep -q "Up"; then
    echo -e "  ${GREEN}RUNNING${NC}  OTel Collector"
else
    echo -e "  ${RED}DOWN${NC}     OTel Collector"
fi

echo ""
echo "ENDPOINTS:"
check_http "http://localhost:3001/api/health" "API Gateway"
check_http "http://localhost:5000/api/health" "Quote Service"
check_http "http://localhost:8000/docs" "Dashboard Backend"
check_http "http://localhost:5173" "Frontend"

echo ""
echo "RABBITMQ:"
if curl -s --max-time 2 -u guest:guest "http://localhost:15672/api/overview" > /dev/null 2>&1; then
    echo -e "  ${GREEN}RUNNING${NC}  RabbitMQ Management (http://localhost:15672)"
    QUEUE_INFO=$(curl -s -u guest:guest "http://localhost:15672/api/queues/%2F/otel-telemetry" 2>/dev/null)
    if echo "$QUEUE_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Messages: {d[\"messages\"]}, Consumers: {d[\"consumers\"]}')" 2>/dev/null; then
        true
    else
        echo -e "  ${YELLOW}WARN${NC}     otel-telemetry queue not found"
    fi
else
    echo -e "  ${RED}DOWN${NC}     RabbitMQ Management"
fi

echo ""
echo "=========================================="
