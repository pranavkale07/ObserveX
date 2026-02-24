import pika
import json
import sys

def callback(ch, method, properties, body):
    print("\n" + "="*50)
    print(f"📥 RECEIVED MESSAGE on: {method.routing_key}")
    print("="*50)
    
    # Try to decode and parse as JSON
    try:
        decoded_body = body.decode('utf-8', errors='ignore')
        data = json.loads(decoded_body)
        
        print("\n✨ PRETTY-PRINTED JSON:")
        print(json.dumps(data, indent=2))
        
        if "[REDACTED_EMAIL]" in decoded_body:
            print("\n✅ REDACTION CHECK: Email masked successfully.")
        if "[REDACTED_AUTHOR]" in decoded_body:
            print("✅ REDACTION CHECK: Author masked successfully.")
            
    except json.JSONDecodeError:
        print("\n📄 RAW DATA (Non-JSON or Partial):")
        print(body.decode('utf-8', errors='ignore'))
    except Exception as e:
        print(f"\n❌ Error processing message: {e}")
    
    # Streams require manual ACKs
    ch.basic_ack(delivery_tag=method.delivery_tag)

def main(queue_name):
    try:
        connection = pika.BlockingConnection(
            pika.ConnectionParameters(
                host='localhost',
                port=5672,
                credentials=pika.PlainCredentials('telemetry', 'telemetry_password')
            )
        )
        channel = connection.channel()

        # RabbitMQ Streams REQUIRE a prefetch count to be set for consumers
        channel.basic_qos(prefetch_count=100)

        print(f"🚀 Active Listener on: {queue_name}")
        print("Waiting for telemetry... Press CTRL+C to stop.")
        
        channel.basic_consume(queue=queue_name, on_message_callback=callback, auto_ack=False)
        channel.start_consuming()
    except KeyboardInterrupt:
        print("\nStopping listener...")
        sys.exit(0)
    except Exception as e:
        print(f"Failed to connect or consume: {e}")

if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "otlp_logs"
    main(q)
