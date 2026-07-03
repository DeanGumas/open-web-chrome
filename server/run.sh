#!/usr/bin/env bash
# Launch the local Open WebUI stack:
#   1. dummy-echo model server on :11435 (works with no API key)
#   2. Open WebUI on :8080, pre-wired to Anthropic's OpenAI-compatible
#      endpoint + the local dummy model.
#
# To use real Claude models, either set ANTHROPIC_API_KEY before running this,
# or paste your key later in Open WebUI: Admin Panel > Settings > Connections.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"

DATA_DIR="${DATA_DIR:-$PWD/data}"
mkdir -p "$DATA_DIR"
export DATA_DIR

# Connections (persisted into Open WebUI's DB on first launch; edit later in Admin Settings)
export ENABLE_OPENAI_API=true
export OPENAI_API_BASE_URLS="https://api.anthropic.com/v1;http://localhost:11435/v1"
export OPENAI_API_KEYS="${ANTHROPIC_API_KEY:-sk-ant-REPLACE_ME};dummy-key"
export ENABLE_OLLAMA_API=false

# Allow the Chrome extension (and anything else) to call the API
export CORS_ALLOW_ORIGIN="*"

# Keep the local instance lightweight / offline-friendly
export WEBUI_AUTH=true
export ENABLE_VERSION_UPDATE_CHECK=false
export RAG_EMBEDDING_ENGINE=openai   # avoids downloading a local sentence-transformers model

echo "[stack] starting dummy model on :11435"
python3 dummy_model.py 11435 &
DUMMY_PID=$!
trap 'kill $DUMMY_PID 2>/dev/null || true' EXIT

echo "[stack] starting Open WebUI on http://localhost:8080"
exec open-webui serve --host 127.0.0.1 --port 8080
