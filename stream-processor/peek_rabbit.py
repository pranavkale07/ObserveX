import pika
import sys

def main(queue_name):
    credentials = pika.PlainCredentials('telemetry', 'telemetry_password')
    parameters = pika.ConnectionParameters('localhost', 5672, '/', credentials)
    connection = pika.BlockingConnection(parameters)
    channel = connection.channel()
    
    channel.basic_qos(prefetch_count=1)
    
    print(f"Peeking at {queue_name}...")
    
    def callback(ch, method, properties, body):
        print(f" [x] Received {method.routing_key}")
        print(f"     Body Snippet: {body[:100]!r}")
        ch.basic_ack(delivery_tag=method.delivery_tag)
        # sys.exit(0) # Stop after one

    channel.basic_consume(
        queue=queue_name, 
        on_message_callback=callback, 
        auto_ack=False,
        arguments={"x-stream-offset": "first"}
    )
    
    try:
        channel.start_consuming()
    except KeyboardInterrupt:
        channel.stop_consuming()
    connection.close()

if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "otlp_traces"
    main(q)
