/* global io */

const LOG_LIMIT = 500;
const QUEUE_LIMIT = 200;

// Socket.IO emits the captured NEWTIP message using this event name.
// If your server expects a different event, change this constant.
const SOCKET_EVENT = "NEWTIP";

let socket = null;
let serverUrl = "";
let token = "";
let running = false;

let queue = [];
let logs = [];

let backoffMs = 1000;
let reconnectTimer = null;
let lastConnState = "disconnected";

function isoNow() {
  return new Date().toISOString();
}

function maskValue(value) {
  if (typeof value !== "string") return value;
  const v = value.trim();
  if (v.length <= 8) return "***";
  return `${v.slice(0, 4)}***${v.slice(-4)}`;
}

function safeForLog(obj) {
  try {
    const cloned = JSON.parse(JSON.stringify(obj));
    if (cloned?.token) cloned.token = maskValue(cloned.token);
    const url = cloned?.data?.payload?.url;
    if (typeof url === "string") {
      try {
        const u = new URL(url);
        if (u.searchParams.has("token")) {
          u.searchParams.set("token", maskValue(u.searchParams.get("token")));
        }
        cloned.data.payload.url = u.toString();
      } catch {
        // ignore
      }
    }
    return cloned;
  } catch {
    return {};
  }
}

function pushLog(line) {
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs = logs.slice(-LOG_LIMIT);
  chrome.runtime.sendMessage({ type: "LOG", line }).catch(() => {});
}

function setConnState(state) {
  lastConnState = state;
  chrome.runtime.sendMessage({ type: "STATE", connState: state, running }).catch(() => {});
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(reason) {
  if (!running) return;
  clearReconnectTimer();
  const wait = Math.min(backoffMs, 30000);
  pushLog(`${isoNow()} [sio] reconnect in ${wait}ms (${reason})`);
  setConnState(`backoff(${wait}ms)`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
  backoffMs = Math.min(backoffMs * 2, 30000);
}

function disconnectSocket() {
  clearReconnectTimer();
  if (!socket) return;
  try {
    socket.removeAllListeners();
    socket.disconnect();
  } catch {
    // ignore
  } finally {
    socket = null;
  }
}

function isSocketConnected() {
  return Boolean(socket && socket.connected);
}

function enqueue(msg) {
  queue.push(msg);
  if (queue.length > QUEUE_LIMIT) queue = queue.slice(-QUEUE_LIMIT);
}

function flushQueue() {
  if (!isSocketConnected()) return;
  if (!queue.length) return;

  const toSend = queue;
  queue = [];
  for (const msg of toSend) {
    try {
      socket.emit(SOCKET_EVENT, msg);
    } catch (e) {
      enqueue(msg);
      pushLog(`${isoNow()} [sio] emit failed, re-queued: ${String(e)}`);
      break;
    }
  }
}

function normalizeSocketIoUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  // Allow users to paste ws/wss URLs; map to http/https for Socket.IO.
  if (raw.startsWith("ws://")) return `http://${raw.slice("ws://".length)}`;
  if (raw.startsWith("wss://")) return `https://${raw.slice("wss://".length)}`;

  return raw;
}

function connect() {
  if (!running) return;
  if (!serverUrl || !token) {
    pushLog(`${isoNow()} [sio] missing serverUrl/token`);
    setConnState("disconnected");
    return;
  }

  if (typeof io !== "function") {
    pushLog(`${isoNow()} [sio] socket.io client not loaded (missing vendor/socket.io.min.js)`);
    setConnState("disconnected");
    return;
  }

  clearReconnectTimer();
  disconnectSocket();
  setConnState("connecting");

  try {
    socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      reconnection: false, // we manage backoff ourselves
      auth: { token },
      extraHeaders: {},
    });
  } catch (e) {
    pushLog(`${isoNow()} [sio] invalid url: ${String(e)}`);
    scheduleReconnect("invalid_url");
    return;
  }

  socket.on("connect", () => {
    backoffMs = 1000;
    pushLog(`${isoNow()} [sio] connected id=${socket.id ?? "?"}`);
    setConnState("connected");
    flushQueue();
  });

  socket.on("connect_error", (err) => {
    pushLog(`${isoNow()} [sio] connect_error: ${String(err?.message ?? err)}`);
    setConnState("disconnected");
    disconnectSocket();
    scheduleReconnect("connect_error");
  });

  socket.on("disconnect", (reason) => {
    pushLog(`${isoNow()} [sio] disconnect: ${String(reason ?? "—")}`);
    setConnState("disconnected");
    disconnectSocket();
    scheduleReconnect("disconnect");
  });
}

function start({ nextServerUrl, nextToken }) {
  serverUrl = normalizeSocketIoUrl(nextServerUrl);
  token = String(nextToken ?? "").trim();
  running = true;
  pushLog(`${isoNow()} [state] running=true url=${serverUrl}`);
  setConnState("connecting");
  connect();
}

function stop() {
  running = false;
  clearReconnectTimer();
  disconnectSocket();
  queue = [];
  pushLog(`${isoNow()} [state] running=false`);
  setConnState("disconnected");
}

function handleCaptured(msg) {
  if (!running) return;
  if (!msg || typeof msg !== "object") return;

  enqueue(msg);
  const safe = safeForLog(msg);
  pushLog(
    `${isoNow()} [queue] +1 kind=${safe?.data?.payload?.kind ?? "?"} tab=${safe?.data?.payload?.tabId ?? "?"}`
  );

  if (isSocketConnected()) {
    flushQueue();
  } else {
    connect();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message !== "object") {
      sendResponse({ ok: false, error: "invalid_message" });
      return;
    }

    if (message.type === "GET_STATE") {
      sendResponse({
        ok: true,
        running,
        connState: lastConnState,
        logs,
        queueSize: queue.length,
      });
      return;
    }

    if (message.type === "START") {
      start({ nextServerUrl: message.wsUrl, nextToken: message.token });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STOP") {
      stop();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CAPTURED") {
      handleCaptured(message.msg);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CLEAR_LOGS") {
      logs = [];
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown_type" });
  })();
  return true;
});

setConnState("disconnected");
