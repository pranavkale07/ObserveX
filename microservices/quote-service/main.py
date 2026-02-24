import asyncio
import logging
from fastapi import FastAPI
import httpx
import random

app = FastAPI()
logger = logging.getLogger(__name__)

QUOTES = [
    {"text": "The only way to do great work is to love what you do.", "author": "Steve Jobs"},
    {"text": "Innovation distinguishes between a leader and a follower.", "author": "Steve Jobs"},
    {"text": "Your time is limited, so don't waste it living someone else's life.", "author": "Steve Jobs"},
    {"text": "Stay hungry, stay foolish.", "author": "Steve Jobs"}
]

@app.get("/api/health")
async def health():
    return {"status": "healthy", "service": "quote-service"}

@app.get("/api/quote")
async def get_quote():
    await asyncio.sleep(0.1)
    quote = random.choice(QUOTES)
    logger.info(f"Quote requested: {quote['text'][:20]}...")
    return quote

@app.get("/api/slow-quote")
async def get_slow_quote():
    delay = 1.0 + random.random()
    logger.warning(f"Simulating SLOW response: {delay:.2f}s")
    await asyncio.sleep(delay)
    quote = random.choice(QUOTES)
    return quote

@app.get("/api/n-plus-1")
async def n_plus_1():
    # Simulate N+1 query pattern: multiple sub-spans
    # If using auto-instrumentation, we might need some async activity to generate spans
    # For testing Bytewax count, this is fine
    for i in range(25):
        await asyncio.sleep(0.01)
    return {"status": "N+1 triggered", "count": 25}

@app.get("/api/pii")
async def pii_log(email: str = "test@example.com"):
    # This will be logged and redacted by OTel Collector
    logger.info(f"User requested PII for email: {email}")
    return {"status": "Logged PII", "email": "[REDACTED]"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
