import pika
import time

credentials = pika.PlainCredentials('telemetry', 'telemetry_password')
parameters = pika.ConnectionParameters('localhost', credentials=credentials)
connection = pika.BlockingConnection(parameters)
channel = connection.channel()

def callback(ch, method, properties, body):
    print(f"Message received: {body[:100]}")
    ch.stop_consuming()

channel.basic_qos(prefetch_count=1)
# Stream queues MUST use manual ack and offset
channel.basic_consume(
    queue='otel-telemetry', 
    on_message_callback=callback,
    auto_ack=False,
    arguments={'x-stream-offset': 'first'}
)

print("Waiting for message...")
try:
    connection.process_data_events(time_limit=5)
except Exception as e:
    print(f"Time limit reached or error: {e}")
finally:
    connection.close()
