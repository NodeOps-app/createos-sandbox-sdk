#!/usr/bin/env python3
import sys, time
for i in range(1, 6):
    print(f"line {i}/5  t={time.strftime('%H:%M:%S')}", flush=True)
    time.sleep(1)
print("done", file=sys.stderr, flush=True)
