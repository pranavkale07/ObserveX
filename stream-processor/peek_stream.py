import pika
import json

try:
    credentials = pika.PlainCredentials('telemetry', 'telemetry_password')
    parameters = pika.ConnectionParameters('localhost', credentials=credentials)
    connection = pika.BlockingConnection(parameters)
    channel = connection.channel()
    
    # Peek at the stream
    method_frame, header_frame, body = channel.basic_get(queue='otel-telemetry', auto_ack=False)
    if method_frame:
        print(f"Message found: {body[:100]}")
    else:
        print("No messages in queue.")
        
    connection.close()
except Exception as e:
    print(f"Error: {e}")
