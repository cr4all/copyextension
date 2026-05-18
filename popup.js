const STORAGE_KEYS = {
  wsUrl: "wsUrl",
  token: "authToken",
  running: "running",
};

const MAX_LOG_LINES = 500;

function nowTime() {
  const d = new Date();
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function appendLog(line) {
  const logBox = document.getElementById("logBox");
  const existing = logBox.textContent ? logBox.textContent.split("\n") : [];
  existing.push(line);
  const trimmed = existing.slice(-MAX_LOG_LINES);
  logBox.textContent = trimmed.join("\n");
  logBox.scrollTop = logBox.scrollHeight;
}

function setRunningUI(running) {
  const badge = document.getElementById("statusBadge");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  badge.textContent = running ? "running" : "stopped";
  badge.classList.toggle("badge--running", running);
  badge.classList.toggle("badge--stopped", !running);
  startBtn.disabled = running;
  stopBtn.disabled = !running;
}

function setConnState(text) {
  document.getElementById("connState").textContent = text ?? "—";
}

function updateWarmupButton(running, connState) {
  const warmupBtn = document.getElementById("warmupBtn");
  if (!warmupBtn) return;
  const connected = String(connState ?? "").toLowerCase() === "connected";
  warmupBtn.disabled = !running || !connected;
}

async function getStoredSettings() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.wsUrl,
    STORAGE_KEYS.token,
    STORAGE_KEYS.running,
  ]);
  return {
    wsUrl: stored[STORAGE_KEYS.wsUrl] ?? "",
    token: stored[STORAGE_KEYS.token] ?? "",
    running: Boolean(stored[STORAGE_KEYS.running]),
  };
}

async function setStoredSettings({ wsUrl, token, running }) {
  const patch = {};
  if (typeof wsUrl === "string") patch[STORAGE_KEYS.wsUrl] = wsUrl;
  if (typeof token === "string") patch[STORAGE_KEYS.token] = token;
  if (typeof running === "boolean") patch[STORAGE_KEYS.running] = running;
  await chrome.storage.local.set(patch);
}

async function sendMessage(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    appendLog(`${nowTime()} [popup] message failed: ${String(e)}`);
    return null;
  }
}

async function init() {
  const wsUrlEl = document.getElementById("wsUrl");
  const tokenEl = document.getElementById("authToken");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const clearBtn = document.getElementById("clearLogBtn");
  const warmupBtn = document.getElementById("warmupBtn");

  const settings = await getStoredSettings();
  wsUrlEl.value = settings.wsUrl;
  tokenEl.value = settings.token;
  setRunningUI(settings.running);

  const state = await sendMessage({ type: "GET_STATE" });
  if (state?.running !== undefined) setRunningUI(Boolean(state.running));
  if (state?.connState) setConnState(state.connState);
  updateWarmupButton(
    state?.running !== undefined ? Boolean(state.running) : settings.running,
    state?.connState ?? "disconnected",
  );
  if (Array.isArray(state?.logs)) {
    for (const line of state.logs) appendLog(line);
  }

  startBtn.addEventListener("click", async () => {
    const wsUrl = wsUrlEl.value.trim();
    const token = tokenEl.value.trim();
    if (!wsUrl || !token) {
      appendLog(`${nowTime()} [ui] Socket.IO URL/token required`);
      return;
    }
    await setStoredSettings({ wsUrl, token, running: true });
    const res = await sendMessage({ type: "START", wsUrl, token });
    if (res?.ok) {
      appendLog(`${nowTime()} [ui] started`);
      setRunningUI(true);
      updateWarmupButton(true, (await sendMessage({ type: "GET_STATE" }))?.connState);
    } else {
      appendLog(`${nowTime()} [ui] start failed: ${res?.error ?? "unknown"}`);
      setRunningUI(false);
      await setStoredSettings({ running: false });
    }
  });

  stopBtn.addEventListener("click", async () => {
    await setStoredSettings({ running: false });
    const res = await sendMessage({ type: "STOP" });
    if (res?.ok) {
      appendLog(`${nowTime()} [ui] stopped`);
    } else {
      appendLog(`${nowTime()} [ui] stop failed: ${res?.error ?? "unknown"}`);
    }
    setRunningUI(false);
    setConnState("disconnected");
    updateWarmupButton(false, "disconnected");
  });

  clearBtn.addEventListener("click", async () => {
    document.getElementById("logBox").textContent = "";
    await sendMessage({ type: "CLEAR_LOGS" });
  });

  warmupBtn.addEventListener("click", async () => {
    warmupBtn.disabled = true;
    appendLog(`${nowTime()} [ui] warmup requested`);
    const res = await sendMessage({ type: "WARMUP" });
    if (res?.ok) {
      const results = Array.isArray(res.results) ? res.results : [];
      const readyCount = results.filter((r) => r?.ready).length;
      appendLog(
        `${nowTime()} [ui] warmup done: ${readyCount}/${results.length} ready`,
      );
      for (const r of results) {
        const bal =
          r?.balance != null && Number.isFinite(Number(r.balance))
            ? ` balance=${r.balance}`
            : "";
        appendLog(
          `${nowTime()} [warmup] ${r?.bookmaker ?? "?"} ${r?.botInstanceId ?? "?"} ready=${Boolean(r?.ready)}${bal}${r?.error ? ` err=${r.error}` : ""}`,
        );
      }
    } else {
      appendLog(`${nowTime()} [ui] warmup failed: ${res?.error ?? "unknown"}`);
    }
    const state = await sendMessage({ type: "GET_STATE" });
    updateWarmupButton(Boolean(state?.running), state?.connState ?? "disconnected");
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "LOG") {
      appendLog(msg.line);
      return;
    }
    if (msg.type === "STATE") {
      if (typeof msg.running === "boolean") setRunningUI(msg.running);
      if (typeof msg.connState === "string") {
        setConnState(msg.connState);
        const badge = document.getElementById("statusBadge");
        const running = badge?.textContent === "running";
        updateWarmupButton(running, msg.connState);
      }
    }
    if (msg.type === "WARMUP_ACK") {
      const results = Array.isArray(msg.results) ? msg.results : [];
      appendLog(
        `${nowTime()} [sio] warmup_ack: ${results.filter((r) => r?.ready).length}/${results.length} ready`,
      );
    }
  });
}

init();

