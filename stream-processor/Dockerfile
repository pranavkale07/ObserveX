FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Environment variables will be passed via docker-compose
ENV PYTHONUNBUFFERED=1

CMD ["python", "-m", "bytewax.run", "dataflow:flow"]
