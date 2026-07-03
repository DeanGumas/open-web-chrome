# Google Chrome Extension for Open Web UI

A local Open WebUI stack plus a Chrome extension that hooks into it: chat with any
Open WebUI model about the web page(s) you're viewing, then jump into the full
Open WebUI interface to continue the conversation.

```
open-web-chrome/
├── server/
│   ├── run.sh          # starts the whole local stack (Open WebUI + dummy model)
│   ├── dummy_model.py  # keyless OpenAI-compatible stub model ("dummy-echo")
│   ├── .api-key        # generated Open WebUI API key (gitignored)
│   └── data/           # Open WebUI's database & uploads (gitignored)
└── extension/          # the Chrome extension (Manifest V3)
```

## 1. Run the local Open WebUI stack

Prereqs (already installed on this machine): `uv`
(`curl -LsSf https://astral.sh/uv/install.sh | sh`) and
`uv tool install --python 3.12 open-webui`.

```sh
./server/run.sh
```

This starts:
- **Open WebUI** at http://localhost:8080
- **dummy-echo** at http://localhost:11435 — a fake model so everything works with zero API keys

Local admin account (created during setup):
**dean.gumas25@gmail.com** / **open-web-chrome**

### Connecting real Claude models

A claude.ai **subscription can't be used here** — Open WebUI needs an API key from the
[Claude Console](https://platform.claude.com/). Two ways to wire it up:

- **Before first launch:** `ANTHROPIC_API_KEY=sk-ant-... ./server/run.sh`
- **Any time:** Open WebUI → **Admin Panel → Settings → Connections** → edit the
  `https://api.anthropic.com/v1` connection and paste your key.

That connection uses Anthropic's OpenAI-compatible endpoint, so Claude models
(`claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`, …) appear in the model
list automatically once a valid key is present.

## 2. Get an Open WebUI API key

The extension authenticates with an Open WebUI API key, so each user's chats land in
their own account. A key for the admin account is already in `server/.api-key`; for
any other user:

1. In Open WebUI, click your avatar → **Settings → Account**
2. Expand **API Keys** → **Create new secret key** and copy the `sk-...` key

(API keys were enabled via Admin Panel → Settings → General; they're off by default.)

## 3. Install the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder
4. Click the extension icon, enter `http://localhost:8080` and your API key

## What the extension does

- **Model picker** — lists every model your Open WebUI account can see
  (dummy-echo now, Claude models once a key is added, anything else you connect)
- **This page** — injects the current tab's text into the chat as context
- **All tabs** — reads *every* open tab (up to 12) so you can ask cross-tab questions
  like "compare the pricing pages I have open"
- **Streaming chat** — responses stream into the popup via Open WebUI's
  `/api/chat/completions` endpoint
- **Continue in Open WebUI ↗** — saves the conversation into your Open WebUI account
  (`/api/v1/chats/new`) and opens it in a full tab, with the page context preserved
  as the chat's system prompt
- Settings (server URL, API key, model) persist in `chrome.storage.sync`;
  the conversation survives popup close for the browser session

## Notes & limits

- Pages that block script injection (Chrome Web Store, `chrome://` pages, PDFs in the
  built-in viewer) are skipped silently.
- Page text is truncated (~24k chars for one tab, ~6k/tab for multi-tab) to stay well
  inside model context limits.
- The dummy model just echoes what it received — its reply lists which pages it saw,
  which is handy for verifying the context plumbing before spending real tokens.
- CORS is open (`CORS_ALLOW_ORIGIN=*`) for local dev; tighten it if you ever expose
  this instance beyond localhost.
