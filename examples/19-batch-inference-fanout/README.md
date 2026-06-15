# 19 — Batch inference fan-out

Run sentiment classification over a batch of labeled movie reviews, sharded and
processed **in parallel across multiple FC sandboxes**. Each sandbox installs a
small CPU-only HuggingFace model, classifies its shard, and reports its own
inference timing. The host shards the batch, fans the work out concurrently,
then aggregates accuracy, throughput, and the concurrency speedup.

This is the example for concurrent multi-sandbox fan-out: one shard per
sandbox, all running at once, results gathered on the host.

## Run

```sh
cp .env.example .env  # the shared ../.env is already symlinked
bun index.ts
```

bun auto-loads `.env` from this dir. The only required var is `CREATEOS_SANDBOX_API_KEY`.
The model is public, so no model API key is needed. The base URL resolves from
`CREATEOS_SANDBOX_BASE_URL`, defaulting to the production control plane.

## What it does

1. Loads `reviews.json` (80 labeled reviews, balanced POSITIVE/NEGATIVE) and
   splits it round-robin into 4 even shards (20 each, label-balanced).
2. Creates 4 `s-2vcpu-2gb` sandboxes on `devbox:1` concurrently — one per
   shard, in a single wave that stays under the shared concurrency cap.
3. In parallel, each sandbox installs CPU-only `torch` + `transformers` via
   `pip3`, receives `infer.py` and its shard JSON, and pre-pulls the model.
4. Runs all 4 shards concurrently. `infer.py` classifies its shard with
   `distilbert-base-uncased-finetuned-sst-2-english` and prints one JSON
   object: the predictions plus `inference_ms` (the predict loop only) and
   `model_load_ms` (the one-time load + warm).
5. Aggregates on the host: overall accuracy against the bundled labels,
   throughput (items/sec), and the fan-out speedup.
6. Destroys every sandbox in a `finally`, then re-checks via `listSandboxes`
   that none of the created sandboxes is still running.

## Measuring the speedup honestly

Cold start (dependency install + first model load) is a one-time cost paid
once per sandbox regardless of how the batch is split — so it is reported
separately as an amortizable cost, not folded into the speedup.

The concurrency speedup is computed on the inference phase only, using the
`inference_ms` each sandbox reports for its own predict loop:

- serial estimate = sum of every shard's `inference_ms`
- parallel actual = the slowest shard's `inference_ms`
- speedup = serial estimate / parallel actual (≈ shard count for even shards)

That is exactly the win fan-out buys: the deps are prepared once per worker and
the workload runs N shards at the same wall-clock time as one.

## FC primitives exercised

| primitive                                   | SDK call                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Concurrent sandbox create                   | `Promise.all(shards.map(() => client.createSandbox(...)))`                |
| Env injection                               | `createSandbox({ shape, rootfs, envs })`                                  |
| File upload (script + shard → each sandbox) | `sandbox.files.upload(path, body)`                                        |
| Buffered command                            | `sandbox.runCommand("bash", ["-lc", …], { timeoutMs })`                   |
| Concurrent fan-out + gather                 | `Promise.all(sandboxes.map(runShard))`                                    |
| Cleanup (all sandboxes, no leaks)           | `Promise.allSettled(sandboxes.map(sb => sb.destroy()))` + `listSandboxes` |

## Notes

- `pip` defaults to CUDA torch wheels (~2 GB); the install pins
  `torch==2.9.1` from the CPU index (`https://download.pytorch.org/whl/cpu`),
  then installs `transformers` from PyPI.
- Multi-minute installs run detached with a polled completion marker so no
  single command call is held open long enough to trip a gateway timeout.
- `SHARD_COUNT` is 4 and `MAX_CONCURRENCY` is 4, so the whole batch runs in
  one wave under the shared cap. If you raise `SHARD_COUNT` above the cap,
  process shards in waves of `MAX_CONCURRENCY`.

## Versions captured at build time

See `versions.txt`.
