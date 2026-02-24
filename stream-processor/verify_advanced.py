import httpx
import time
import asyncio

GATEWAY_URL = "http://localhost:3001"

async def test_bimodal():
    print("--- [SRE] Testing Bimodal Latency ---")
    async with httpx.AsyncClient() as client:
        # Alternating fast and slow
        for i in range(10):
            if i % 2 == 0:
                print(f"[{i}] Sending FAST request")
                await client.get(f"{GATEWAY_URL}/api/proxy-quote")
            else:
                print(f"[{i}] Sending SLOW request")
                await client.get(f"{GATEWAY_URL}/api/proxy-slow-quote")
            await asyncio.sleep(0.5)

async def test_n_plus_1():
    print("--- [Developer] Testing N+1 Detection ---")
    async with httpx.AsyncClient() as client:
        # This endpoint internally blocks 25 times
        # If the tracing instrumentation is working, it should generate 25+ spans for one trace
        print("Triggering /api/proxy-n-plus-1 (expecting 25+ spans in logs)")
        await client.get(f"{GATEWAY_URL}/api/proxy-n-plus-1")

async def test_redaction():
    print("--- [Behavioral] Testing Mass Redaction ---")
    async with httpx.AsyncClient() as client:
        # Trigger 20 logs with sensitive data (needs redaction)
        for i in range(20):
            email = f"user_{i}@danger.com"
            print(f"[{i}] Sending PII request for {email}")
            await client.get(f"{GATEWAY_URL}/api/proxy-pii", params={"email": email})
            await asyncio.sleep(0.2)

async def main():
    print("Starting Advanced Anomaly Verification...")
    await test_bimodal()
    time.sleep(2)
    await test_n_plus_1()
    time.sleep(2)
    await test_redaction()
    print("Advanced Anomaly Verification Triggered. Observing Bytewax logs...")

if __name__ == "__main__":
    asyncio.run(main())
