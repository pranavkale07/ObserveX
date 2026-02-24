import pika
import json
import logging
import traceback
from bytewax.inputs import DynamicSource, StatelessSourcePartition

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

import time

class RabbitPartition(StatelessSourcePartition):
    def __init__(self, queue_name, host, user, password):
        self._queue_name = queue_name
        self._host = host
        self._credentials = pika.PlainCredentials(user, password)
        self._connection = None
        self._channel = None
        self._iterator = None
        self._last_setup_attempt = 0
        self._backoff = 1.0
        logger.info(f"Initialized RabbitPartition for {queue_name}")

    def _setup(self):
        if self._connection is None or self._connection.is_closed:
            now = time.time()
            if now - self._last_setup_attempt < self._backoff:
                return

            self._last_setup_attempt = now
            logger.info(f"Connecting to RabbitMQ at {self._host} for {self._queue_name} (Backoff: {self._backoff}s)")
            try:
                self._connection = pika.BlockingConnection(
                    pika.ConnectionParameters(host=self._host, credentials=self._credentials)
                )
                self._channel = self._connection.channel()
                
                # Attempt to declare the queue as a stream queue if it doesn't exist
                # This ensures we don't get NOT_FOUND errors
                self._channel.queue_declare(
                    queue=self._queue_name,
                    durable=True,
                    arguments={"x-queue-type": "stream"}
                )
                
                self._channel.basic_qos(prefetch_count=1)
                
                # Stream queues in RabbitMQ do NOT support:
                # 1. auto_ack=True (This leads to the NOT_IMPLEMENTED error)
                # 2. basic.nack or basic.reject
                # We MUST use auto_ack=False and manual basic.ack.
                self._iterator = self._channel.consume(
                    queue=self._queue_name, 
                    auto_ack=False,
                    arguments={"x-stream-offset": "first"},
                    inactivity_timeout=0.5 # Increased timeout slightly for stability
                )
                print(f"DEBUG [RabbitSource] setup complete for {self._queue_name}"); logger.info(f"Setup complete for {self._queue_name}")
                self._backoff = 1.0 # Reset backoff on success
            except Exception as e:
                logger.error(f"Failed to setup RabbitMQ connection for {self._queue_name}: {e}")
                self._connection = None
                self._iterator = None
                self._backoff = min(30, self._backoff * 2)

    def next_batch(self):
        self._setup()
        if not self._iterator:
            return []
            
        try:
            # next() returns (None, None, None) if inactivity_timeout is reached
            result = next(self._iterator)
            method_frame, header_frame, body = result
            
            if method_frame: print(f"DEBUG [RabbitSource] GOT MESSAGE: {len(body)} bytes");
                # Acknowledge immediately - Stream queues ignore nack/reject
                self._channel.basic_ack(method_frame.delivery_tag)
                try:
                    decoded_body = body.decode('utf-8', errors='ignore')
                    data = json.loads(decoded_body)
                    return [data]
                except json.JSONDecodeError:
                    logger.warning(f"Discarding non-JSON from {self._queue_name}.")
                    return []
            else:
                return [] # Timeout reached, no message
                
        except pika.exceptions.AMQPConnectionError:
            logger.warning(f"Connection lost for {self._queue_name}, resetting.")
            self._connection = None
            self._iterator = None
            return []
        except Exception as e:
            logger.error(f"Error in next_batch for {self._queue_name}: {e}")
            self._connection = None
            self._iterator = None
            return []

    def close(self):
        if self._connection and self._connection.is_open:
            logger.info(f"Closing RabbitMQ connection for {self._queue_name}")
            try:
                self._connection.close()
            except:
                pass

class RabbitSource(DynamicSource):
    def __init__(self, queue_name, host="localhost", user="telemetry", password="telemetry_password"):
        self._queue_name = queue_name
        self._host = host
        self._user = user
        self._password = password

    def build(self, step_id, worker_index, worker_count):
        logger.info(f"Building RabbitSource for {self._queue_name} (worker {worker_index}/{worker_count})")
        return RabbitPartition(self._queue_name, self._host, self._user, self._password)
