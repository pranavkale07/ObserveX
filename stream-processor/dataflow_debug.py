import os, logging, httpx, json
from datetime import datetime, timedelta, timezone
from bytewax import operators as op
from bytewax.dataflow import Dataflow
from bytewax.connectors.stdio import StdOutSink
from bytewax.operators import windowing as win
from bytewax.operators.windowing import SystemClock, TumblingWindower
from rabbit_source import RabbitSource
from telemetry_parser import parse_trace

flow = Dataflow("otel-debug")
stream = op.input("raw-input", flow, RabbitSource("otel-telemetry"))

def raw_inspect(item):
    print(f"DEBUG [raw]: {str(item)[:100]}")
    return item

op.map("raw-inspect", stream, raw_inspect)
op.output("stdout", stream, StdOutSink())
