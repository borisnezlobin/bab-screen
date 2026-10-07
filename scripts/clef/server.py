"""Cloudflare's Clef-flash decision model, served on this Mac for the news feed's labels (lib/feed-labels.ts).

Clef is not a chat model: given a state and typed questions it returns a probability for every allowed answer in
one forward pass. This loads the 4-bit MLX build once and answers POST /systemone with the model's own request
and response shapes. GET /health says whether it is ready. It listens on 127.0.0.1 only.

    python3 -m venv .clef-venv
    .clef-venv/bin/pip install -r scripts/clef/requirements.txt
    .clef-venv/bin/python scripts/clef/server.py
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from huggingface_hub import snapshot_download

MODEL_REPO = os.environ.get("CLEF_MODEL", "mlx-community/clef-flash-4bit")
PORT = int(os.environ.get("CLEF_PORT", "7710"))
MAX_BODY_BYTES = 256 * 1024

model_path = snapshot_download(MODEL_REPO)
sys.path.insert(0, model_path)
import clef_mlx  # noqa: E402  (ships with the model weights)

model = clef_mlx.load(model_path)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not_found"})
        self.reply(200, {"ok": True, "model": MODEL_REPO})

    def do_POST(self):
        if self.path != "/systemone":
            return self.reply(404, {"error": "not_found"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return self.reply(413, {"error": "bad_length"})
        try:
            request = json.loads(self.rfile.read(length))
            self.reply(200, model.systemone(request))
        except Exception as error:  # a bad request must not take the server down
            self.reply(400, {"error": type(error).__name__, "message": str(error)[:300]})

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    print(f"Clef ({MODEL_REPO}) listening on http://127.0.0.1:{PORT}", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
