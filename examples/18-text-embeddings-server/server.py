"""Tiny CPU text-embeddings HTTP server.

Loads a small sentence-transformers model and exposes a single
`POST /embed` endpoint that turns a batch of texts into dense vectors.
Bound on 0.0.0.0 so the FC ingress can forward to it. Stdlib HTTP
server (http.server) keeps the surface tiny — the only third-party
dependency is sentence-transformers (+ its torch CPU wheel).

Request:  {"texts": ["...", "..."]}
Response: {"model": "...", "dim": 384, "count": 2, "embeddings": [[...], [...]]}
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sentence_transformers import SentenceTransformer

MODEL_ID = os.environ.get("EMBED_MODEL", "BAAI/bge-small-en-v1.5")
PORT = int(os.environ.get("EMBED_PORT", "8080"))

print(f"loading model {MODEL_ID}…", flush=True)
model = SentenceTransformer(MODEL_ID, device="cpu")
DIM = model.get_sentence_embedding_dimension()
print(f"model ready: {MODEL_ID} (dim={DIM})", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": MODEL_ID, "dim": DIM})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
            texts = req.get("texts")
            if not isinstance(texts, list) or not texts:
                self._json(400, {"error": "body must be {\"texts\": [str, ...]}"})
                return
            vectors = model.encode(texts, normalize_embeddings=True)
            self._json(
                200,
                {
                    "model": MODEL_ID,
                    "dim": DIM,
                    "count": len(texts),
                    "embeddings": [v.tolist() for v in vectors],
                },
            )
        except Exception as exc:  # noqa: BLE001 — surface any failure to the caller
            self._json(500, {"error": str(exc)})

    def log_message(self, *args):  # quiet the default access log
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"serving on 0.0.0.0:{PORT}", flush=True)
    server.serve_forever()
