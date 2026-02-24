import requests
import time
import random

GATEWAY_URL = "http://localhost:3001/api/proxy-quote"
SLOW_GATEWAY_URL = "http://localhost:3001/api/proxy-slow-quote"

def trigger():
    print("🚀 Starting traffic generation (Normal)...")
    for i in range(15):
        try:
            start = time.time()
            requests.get(GATEWAY_URL)
            print(f"[{i+1}] Normal took {time.time()-start:.2f}s")
        except Exception as e:
            print(f"Error: {e}")
        time.sleep(0.1)
    
    print("\n🚨 Triggering ANOMALIES (Slow requests)...")
    for i in range(10):
        try:
            start = time.time()
            requests.get(SLOW_GATEWAY_URL)
            print(f"[{i+1}] SLOW (Anomalous) took {time.time()-start:.2f}s")
        except Exception as e:
            print(f"Error: {e}")
        time.sleep(0.5)

    print("\n⏳ Observation period (waiting for windows to close)...")
    for i in range(15):
        print(f"Waiting... {15-i}s")
        time.sleep(1)

if __name__ == "__main__":
    trigger()
