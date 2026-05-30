"""Run SST-2 sentiment classification over one shard of reviews.

Reads a shard JSON file (list of {id, text, label}) passed as argv[1], runs a
small CPU HuggingFace model over the texts, and prints exactly one JSON object
to stdout:

    {"shard": <int>, "model": "<id>", "model_load_ms": <int>,
     "inference_ms": <int>, "predictions": [{"id", "label", "score"}, ...]}

`inference_ms` times the predict loop ONLY (model load and any first-call
download are reported separately as `model_load_ms`). The host aggregates
these to compute a fan-out speedup that is not dominated by one-time cold
start. Inference runs single-threaded per shard so the timing reflects the
shard's own work, not contention across vCPUs.
"""

import json
import os
import sys
import time

# Quiet logging keeps stdout to a single JSON line for the host to parse.
# These must be set before transformers is imported to take effect.
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch  # noqa: E402
from transformers import pipeline  # noqa: E402

MODEL = "distilbert-base-uncased-finetuned-sst-2-english"


def main() -> int:
    shard_path = sys.argv[1]
    shard_index = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    with open(shard_path) as f:
        rows = json.load(f)

    torch.set_num_threads(1)

    t0 = time.perf_counter()
    clf = pipeline("sentiment-analysis", model=MODEL, device=-1)
    # Warm a single forward pass so the first timed inference doesn't pay
    # lazy graph/kernel init — that cost belongs to load, not throughput.
    clf("warmup")
    model_load_ms = int((time.perf_counter() - t0) * 1000)

    texts = [r["text"] for r in rows]
    t1 = time.perf_counter()
    outputs = clf(texts, batch_size=8, truncation=True)
    inference_ms = int((time.perf_counter() - t1) * 1000)

    # The text-classification pipeline normally returns one dict per input, but
    # some configurations return a list of candidate dicts per input — take the
    # top-scoring one so the parsing is robust either way.
    def top(out):
        if isinstance(out, list):
            return max(out, key=lambda o: o["score"])
        return out

    predictions = [
        {"id": r["id"], "label": top(out)["label"], "score": round(float(top(out)["score"]), 4)}
        for r, out in zip(rows, outputs)
    ]

    print(
        json.dumps(
            {
                "shard": shard_index,
                "model": MODEL,
                "model_load_ms": model_load_ms,
                "inference_ms": inference_ms,
                "count": len(predictions),
                "predictions": predictions,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
