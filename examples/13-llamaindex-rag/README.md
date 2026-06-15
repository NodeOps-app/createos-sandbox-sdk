# 13 — LlamaIndex RAG

Build a LlamaIndex `VectorStoreIndex` inside a single FC sandbox, snapshot
the prepared state with `pause`/`resume`, and answer a question against the
persisted index. Embeddings run locally on CPU (sentence-transformers/
`all-MiniLM-L6-v2`); the chat model is reached over any OpenAI-compatible
endpoint.

## Run

```sh
cp .env.example .env  # fill in values (the shared ../.env is already symlinked)
bun index.ts
```

bun auto-loads `.env` from this dir. Required vars: `CREATEOS_SANDBOX_API_KEY`,
`OPENAI_API_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` — see `.env.example`.

## What it does

1. Spawns one `s-2vcpu-2gb` sandbox on `devbox:1`.
2. Installs CPU-only `torch`, `llama-index-core`, the HuggingFace embedding
   binding, and the OpenAI-like LLM binding via `pip3`.
3. Pre-pulls `all-MiniLM-L6-v2` so the first query doesn't pay the download.
4. Uploads `corpus/*.md` (4 short docs about createos-sandbox) and the Python
   indexer + query scripts via `sandbox.files.upload()`.
5. Runs `indexer.py` — chunks the corpus, embeds locally, and persists the
   index to `/root/storage/`.
6. Pauses the sandbox to demonstrate the snapshot primitive, then resumes
   it. The persisted index survives the pause/resume cycle.
7. Runs `query.py` with the question; the script loads the persisted
   `VectorStoreIndex`, retrieves the top-k chunks, and asks the LLM to
   compose an answer. Output is a JSON envelope with the answer and the
   retrieved chunks (file + score + excerpt) so grounding is visible.
8. Downloads the persisted index files (`docstore.json`,
   `index_store.json`, `default__vector_store.json`) to `./output/` and
   destroys the sandbox.

## FC primitives exercised

| primitive                                | SDK call                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Sandbox create with env injection        | `client.createSandbox({ shape, rootfs, envs })`                                 |
| File upload (corpus + scripts → sandbox) | `sandbox.files.upload(path, body)`                                              |
| Buffered command                         | `sandbox.runCommand("bash", ["-lc", …], { timeoutMs })`                         |
| Snapshot (pause + resume)                | `sandbox.pause()` / `sandbox.resume()` + `waitUntilPaused` / `waitUntilRunning` |
| File download (index artefacts → host)   | `sandbox.files.download(path)`                                                  |
| Cleanup                                  | `sandbox.destroy()`                                                             |

## Notes

- `pip` defaults to the CUDA torch wheels which are ~2 GB; the install
  step pins `torch==2.5.1` from the CPU index (`https://download.pytorch.org/whl/cpu`).
- The shared concurrency cap is handled with a single 30 s back-off retry
  around `createSandbox` so the example plays nice with sibling demos.
- The sandbox name budget is 22 chars; `llamaidx-${base36}` stays under.
- The OpenAI-like client receives `api_base`, `api_key`, and `model`
  through sandbox env vars — any OpenAI-compatible endpoint works.

## Versions captured at build time

See `versions.txt`.
