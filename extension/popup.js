/* Open WebUI Companion — popup logic */

const $ = (id) => document.getElementById(id);

const els = {
  setupView: $("setup-view"),
  chatView: $("chat-view"),
  serverUrl: $("server-url"),
  apiKey: $("api-key"),
  connectBtn: $("connect-btn"),
  setupError: $("setup-error"),
  modelSelect: $("model-select"),
  openWebuiBtn: $("open-webui-btn"),
  settingsBtn: $("settings-btn"),
  ctxThisTab: $("ctx-this-tab"),
  ctxAllTabs: $("ctx-all-tabs"),
  ctxInfo: $("ctx-info"),
  messages: $("messages"),
  input: $("input"),
  sendBtn: $("send-btn"),
  newChatBtn: $("new-chat-btn"),
  continueBtn: $("continue-btn"),
};

const state = {
  serverUrl: "",
  apiKey: "",
  model: "",
  history: [],          // [{role: "user"|"assistant", content}]
  lastContext: "",      // system-prompt page context from the last send
  streaming: false,
};

/* ---------------- storage ---------------- */

async function loadSettings() {
  const s = await chrome.storage.sync.get(["serverUrl", "apiKey", "model"]);
  state.serverUrl = s.serverUrl || "";
  state.apiKey = s.apiKey || "";
  state.model = s.model || "";
}

async function saveSettings() {
  await chrome.storage.sync.set({
    serverUrl: state.serverUrl,
    apiKey: state.apiKey,
    model: state.model,
  });
}

async function loadSession() {
  const s = await chrome.storage.session.get(["history", "lastContext"]);
  state.history = s.history || [];
  state.lastContext = s.lastContext || "";
}

async function saveSession() {
  await chrome.storage.session.set({
    history: state.history,
    lastContext: state.lastContext,
  });
}

/* ---------------- api helpers ---------------- */

function api(path, options = {}) {
  return fetch(state.serverUrl + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function fetchModels() {
  const res = await api("/api/models");
  if (!res.ok) throw new Error(`Server returned ${res.status} for /api/models`);
  const body = await res.json();
  return (body.data || []).filter((m) => m.id && !m.id.startsWith("arena"));
}

/* ---------------- page context ---------------- */

function extractPageText() {
  // Runs inside the page. Keep it self-contained.
  const text = (document.body ? document.body.innerText : "")
    .replace(/\s+/g, " ")
    .trim();
  return { title: document.title, url: location.href, text };
}

const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source|moz-extension):/;

async function collectContext() {
  let tabs = [];
  if (els.ctxAllTabs.checked) {
    tabs = await chrome.tabs.query({});
  } else if (els.ctxThisTab.checked) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } else {
    return { systemText: "", pageCount: 0 };
  }

  tabs = tabs.filter((t) => t.url && !RESTRICTED.test(t.url)).slice(0, 12);
  const perTabLimit = tabs.length > 1 ? 6000 : 24000;

  const pages = [];
  for (const tab of tabs) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageText,
      });
      if (result && result.result) {
        const p = result.result;
        pages.push({ title: p.title, url: p.url, text: p.text.slice(0, perTabLimit) });
      }
    } catch {
      // page blocked script injection (e.g. web store) — skip it
    }
  }

  if (!pages.length) return { systemText: "", pageCount: 0 };

  const blocks = pages.map((p) => {
    const title = (p.title || "").replace(/"/g, "'");
    const url = (p.url || "").replace(/"/g, "'");
    return `<page title="${title}" url="${url}">\n${p.text}\n</page>`;
  });

  const systemText =
    "You are a helpful assistant living in a browser extension. " +
    "The user is currently viewing the following web page(s). " +
    "Use their content to answer questions; cite which page you drew from when several are attached.\n\n" +
    blocks.join("\n\n");

  return { systemText, pageCount: pages.length };
}

async function refreshCtxInfo() {
  try {
    if (els.ctxAllTabs.checked) {
      const tabs = await chrome.tabs.query({});
      const usable = tabs.filter((t) => t.url && !RESTRICTED.test(t.url)).length;
      els.ctxInfo.textContent = `${Math.min(usable, 12)} tab(s) attached`;
    } else if (els.ctxThisTab.checked) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      els.ctxInfo.textContent = tab && !RESTRICTED.test(tab.url || "")
        ? (tab.title || "").slice(0, 30)
        : "page not readable";
    } else {
      els.ctxInfo.textContent = "no page context";
    }
  } catch {
    els.ctxInfo.textContent = "";
  }
}

/* ---------------- rendering ---------------- */

function renderMarkdownLite(text) {
  // minimal, safe rendering: escape HTML, then bold + inline code
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(/\*\*([^*]+)\*\*/g, '<span class="b">$1</span>')
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function addMessage(role, content, pending = false) {
  const div = document.createElement("div");
  div.className = `msg ${role}${pending ? " pending" : ""}`;
  div.innerHTML = renderMarkdownLite(content);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function renderHistory() {
  els.messages.innerHTML = "";
  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent =
      "Pick a model, keep “This page” checked, and ask anything about the page you're on. " +
      "Check “All tabs” to reason across everything you have open.";
    els.messages.appendChild(empty);
    return;
  }
  for (const m of state.history) addMessage(m.role, m.content);
}

/* ---------------- chat ---------------- */

async function send() {
  const text = els.input.value.trim();
  if (!text || state.streaming || !state.model) return;

  els.input.value = "";
  state.streaming = true;
  els.sendBtn.disabled = true;

  if (!state.history.length) els.messages.innerHTML = "";
  state.history.push({ role: "user", content: text });
  addMessage("user", text);

  const { systemText, pageCount } = await collectContext();
  state.lastContext = systemText;

  const messages = [];
  if (systemText) messages.push({ role: "system", content: systemText });
  messages.push(...state.history.map(({ role, content }) => ({ role, content })));

  const bubble = addMessage("assistant", "", true);
  let answer = "";

  try {
    const res = await api("/api/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: state.model, messages, stream: true }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${errText ? ` — ${errText.slice(0, 200)}` : ""}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in the buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            answer += delta;
            bubble.innerHTML = renderMarkdownLite(answer);
            els.messages.scrollTop = els.messages.scrollHeight;
          }
        } catch {
          /* partial/keepalive line — ignore */
        }
      }
    }

    bubble.classList.remove("pending");
    if (!answer) {
      bubble.remove();
      addMessage("error", "The model returned an empty response.");
    } else {
      state.history.push({ role: "assistant", content: answer });
    }
    if (pageCount) els.ctxInfo.textContent = `${pageCount} page(s) sent`;
  } catch (err) {
    bubble.remove();
    addMessage("error", `Request failed: ${err.message}`);
    // roll back the user turn so a retry is clean
    if (state.history.at(-1)?.role === "user") state.history.pop();
  } finally {
    state.streaming = false;
    els.sendBtn.disabled = false;
    await saveSession();
  }
}

/* ---------------- continue in Open WebUI ---------------- */

function uuid() {
  return crypto.randomUUID();
}

async function continueInWebUI() {
  if (!state.history.length) {
    chrome.tabs.create({ url: state.serverUrl });
    return;
  }
  els.continueBtn.disabled = true;
  els.continueBtn.textContent = "Saving…";

  try {
    // Build Open WebUI's chat format: a linked list of messages + history map.
    const messagesById = {};
    const ordered = [];
    let parentId = null;

    for (const m of state.history) {
      const id = uuid();
      const base = {
        id,
        parentId,
        childrenIds: [],
        role: m.role,
        content: m.content,
        timestamp: Math.floor(Date.now() / 1000),
        models: [state.model],
      };
      if (m.role === "assistant") {
        Object.assign(base, {
          model: state.model,
          modelName: state.model,
          modelIdx: 0,
          done: true,
        });
      }
      if (parentId) messagesById[parentId].childrenIds.push(id);
      messagesById[id] = base;
      ordered.push(base);
      parentId = id;
    }

    const title =
      state.history[0].content.slice(0, 50) +
      (state.history[0].content.length > 50 ? "…" : "");

    const chatBody = {
      chat: {
        title,
        models: [state.model],
        messages: ordered,
        history: { messages: messagesById, currentId: parentId },
        params: state.lastContext ? { system: state.lastContext } : {},
        tags: [],
      },
    };

    const res = await api("/api/v1/chats/new", {
      method: "POST",
      body: JSON.stringify(chatBody),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saved = await res.json();
    chrome.tabs.create({ url: `${state.serverUrl}/c/${saved.id}` });
  } catch (err) {
    addMessage("error", `Couldn't save the chat to Open WebUI (${err.message}). Opening it anyway.`);
    chrome.tabs.create({ url: state.serverUrl });
  } finally {
    els.continueBtn.disabled = false;
    els.continueBtn.textContent = "Continue in Open WebUI ↗";
  }
}

/* ---------------- views ---------------- */

function showSetup(prefill = true) {
  if (prefill) {
    els.serverUrl.value = state.serverUrl || "http://localhost:8080";
    els.apiKey.value = state.apiKey || "";
  }
  els.setupError.classList.add("hidden");
  els.setupView.classList.remove("hidden");
  els.chatView.classList.add("hidden");
}

async function showChat() {
  els.setupView.classList.add("hidden");
  els.chatView.classList.remove("hidden");

  try {
    const models = await fetchModels();
    els.modelSelect.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      els.modelSelect.appendChild(opt);
    }
    if (models.length === 0) {
      addMessage("error", "No models available. Check your connections in Open WebUI (Admin Panel → Settings → Connections).");
    }
    if (state.model && models.some((m) => m.id === state.model)) {
      els.modelSelect.value = state.model;
    } else if (models.length) {
      state.model = models[0].id;
      els.modelSelect.value = state.model;
      await saveSettings();
    }
  } catch (err) {
    addMessage("error", `Couldn't load models: ${err.message}`);
  }

  renderHistory();
  refreshCtxInfo();
  els.input.focus();
}

async function connect() {
  const url = els.serverUrl.value.trim().replace(/\/+$/, "");
  const key = els.apiKey.value.trim();
  if (!url || !key) {
    els.setupError.textContent = "Both fields are required.";
    els.setupError.classList.remove("hidden");
    return;
  }
  els.connectBtn.disabled = true;
  els.connectBtn.textContent = "Connecting…";

  const prev = { serverUrl: state.serverUrl, apiKey: state.apiKey };
  state.serverUrl = url;
  state.apiKey = key;

  try {
    await fetchModels(); // validates URL + key
    await saveSettings();
    await showChat();
  } catch (err) {
    Object.assign(state, prev);
    els.setupError.textContent =
      `Couldn't connect: ${err.message}. Is Open WebUI running at ${url}?`;
    els.setupError.classList.remove("hidden");
  } finally {
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = "Connect";
  }
}

/* ---------------- wire-up ---------------- */

els.connectBtn.addEventListener("click", connect);
els.apiKey.addEventListener("keydown", (e) => e.key === "Enter" && connect());

els.sendBtn.addEventListener("click", send);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

els.modelSelect.addEventListener("change", async () => {
  state.model = els.modelSelect.value;
  await saveSettings();
});

els.settingsBtn.addEventListener("click", () => showSetup());
els.openWebuiBtn.addEventListener("click", () =>
  chrome.tabs.create({ url: state.serverUrl })
);
els.continueBtn.addEventListener("click", continueInWebUI);

els.newChatBtn.addEventListener("click", async () => {
  state.history = [];
  state.lastContext = "";
  await saveSession();
  renderHistory();
});

els.ctxThisTab.addEventListener("change", refreshCtxInfo);
els.ctxAllTabs.addEventListener("change", () => {
  if (els.ctxAllTabs.checked) els.ctxThisTab.checked = false;
  refreshCtxInfo();
});
els.ctxThisTab.addEventListener("change", () => {
  if (els.ctxThisTab.checked) els.ctxAllTabs.checked = false;
  refreshCtxInfo();
});

/* ---------------- init ---------------- */

(async function init() {
  await loadSettings();
  await loadSession();
  if (state.serverUrl && state.apiKey) {
    await showChat();
  } else {
    showSetup();
  }
})();
