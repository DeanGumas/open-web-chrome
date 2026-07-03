#!/usr/bin/env python3
"""
A tiny OpenAI-compatible model server, stdlib only.

Serves one fake model ("dummy-echo") so Open WebUI has something to talk to
without any real API key. Supports GET /v1/models and POST /v1/chat/completions
(both streaming and non-streaming).

Run: python3 dummy_model.py [port]   (default 11435)
"""
import json
import re
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "dummy-echo"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 11435


def build_reply(messages):
    """Produce a canned-but-context-aware reply so page-content plumbing is visible."""
    system_text = " ".join(m.get("content", "") for m in messages if m.get("role") == "system"
                           if isinstance(m.get("content"), str))
    last_user = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, list):  # multimodal content blocks
                c = " ".join(p.get("text", "") for p in c if p.get("type") == "text")
            last_user = c or ""
            break

    parts = [f"**dummy-echo** here — I'm a local stand-in model, no real AI involved.\n"]
    parts.append(f"You said: “{last_user[:300]}{'…' if len(last_user) > 300 else ''}”\n")

    pages = re.findall(r"<page[^>]*title=\"([^\"]*)\"[^>]*url=\"([^\"]*)\"", system_text)
    if pages:
        parts.append(f"I can see content from {len(pages)} page(s) in my context:\n")
        for title, url in pages[:10]:
            parts.append(f"- **{title or '(untitled)'}** — {url}")
        parts.append(f"\nTotal context received: ~{len(system_text)} characters. "
                     "Swap me for a real Claude model to get actual answers about it!")
    elif system_text:
        parts.append(f"I received ~{len(system_text)} characters of system context.")
    else:
        parts.append("No page context was attached to this message.")

    return "\n".join(parts)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[dummy-model] %s\n" % (fmt % args))

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            self._json({"object": "list", "data": [
                {"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "local-dummy"}
            ]})
        elif self.path in ("/", "/health"):
            self._json({"status": "ok", "model": MODEL_ID})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            self._json({"error": "not found"}, 404)
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json({"error": "bad json"}, 400)
            return

        reply = build_reply(req.get("messages", []))
        completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        created = int(time.time())

        if req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            def chunk(payload):
                data = f"data: {json.dumps(payload)}\n\n".encode()
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")

            # stream the reply in word-ish chunks to mimic a real model
            words = reply.split(" ")
            for i in range(0, len(words), 6):
                piece = " ".join(words[i:i + 6]) + (" " if i + 6 < len(words) else "")
                chunk({"id": completion_id, "object": "chat.completion.chunk",
                       "created": created, "model": MODEL_ID,
                       "choices": [{"index": 0, "delta": {"content": piece},
                                    "finish_reason": None}]})
                time.sleep(0.02)
            chunk({"id": completion_id, "object": "chat.completion.chunk",
                   "created": created, "model": MODEL_ID,
                   "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            done = b"data: [DONE]\n\n"
            self.wfile.write(f"{len(done):x}\r\n".encode() + done + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
        else:
            self._json({
                "id": completion_id, "object": "chat.completion",
                "created": created, "model": MODEL_ID,
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": reply}}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            })


if __name__ == "__main__":
    print(f"[dummy-model] serving '{MODEL_ID}' on http://localhost:{PORT}/v1")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
