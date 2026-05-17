const STORAGE_KEYS = {
  wsUrl: "wsUrl",
  token: "authToken",
  running: "running",
};

const LOG_LIMIT = 500;
// Use <all_urls> for debugging and filter in-code.
// If you want to restrict permissions later, narrow manifest host_permissions and this filter together.
const CAPTURE_URLS = ["<all_urls>"];

/** @type {string[]} */
let logs = [];

function isoNow() {
  return new Date().toISOString();
}

// Debug console logs (Service Worker Inspect). Keep this false for normal use.
const DEBUG = false;
function dbg(...args) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log("[followme:bg]", ...args);
}

function maskValue(value) {
  if (typeof value !== "string") return value;
  const v = value.trim();
  if (v.length <= 8) return "***";
  return `${v.slice(0, 4)}***${v.slice(-4)}`;
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("token")) {
      u.searchParams.set("token", maskValue(u.searchParams.get("token")));
    }
    return u.toString();
  } catch {
    return url;
  }
}

function pushLog(line) {
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs = logs.slice(-LOG_LIMIT);
  chrome.runtime.sendMessage({ type: "LOG", line }).catch(() => {});
  dbg("LOG", line);
}

async function getSettings() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.wsUrl,
    STORAGE_KEYS.token,
    STORAGE_KEYS.running,
  ]);
  const settings = {
    wsUrl: stored[STORAGE_KEYS.wsUrl] ?? "",
    token: stored[STORAGE_KEYS.token] ?? "",
    running: Boolean(stored[STORAGE_KEYS.running]),
  };
  dbg("settings", { ...settings, token: settings.token ? "***" : "" });
  return settings;
}

async function setRunning(running) {
  await chrome.storage.local.set({ [STORAGE_KEYS.running]: Boolean(running) });
  chrome.runtime.sendMessage({ type: "STATE", running: Boolean(running) }).catch(() => {});
  dbg("setRunning", Boolean(running));
}

async function ensureOffscreen() {
  const has = await chrome.offscreen?.hasDocument?.();
  dbg("ensureOffscreen hasDocument", has);
  if (has) return;
  dbg("ensureOffscreen createDocument start");
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Maintain a long-lived Socket.IO client connection in MV3.",
  });
  dbg("ensureOffscreen createDocument done");
}

function parseQuery(url) {
  const query = {};
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams.entries()) {
      if (Object.prototype.hasOwnProperty.call(query, k)) {
        const existing = query[k];
        if (Array.isArray(existing)) existing.push(v);
        else query[k] = [existing, v];
      } else {
        query[k] = v;
      }
    }
  } catch {
    // ignore
  }
  return query;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function maybeDecodeJsonFromBytes(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const trimmed = text.trim();
    if (!trimmed) return null;
    const obj = JSON.parse(trimmed);
    return obj;
  } catch {
    return null;
  }
}

function buildPayload(details) {
  const url = details.url;
  const method = details.method;
  const query = parseQuery(url);

  let bodyEncoding = null;
  let body = null;

  const rb = details.requestBody;
  if (rb?.formData) {
    bodyEncoding = "form";
    /** @type {Record<string, any>} */
    const obj = {};
    for (const [k, v] of Object.entries(rb.formData)) {
      obj[k] = Array.isArray(v) && v.length === 1 ? v[0] : v;
    }
    body = obj;
  } else if (Array.isArray(rb?.raw) && rb.raw.length > 0 && rb.raw[0]?.bytes) {
    const bytes = new Uint8Array(rb.raw[0].bytes);
    const maybeJson = maybeDecodeJsonFromBytes(bytes);
    if (maybeJson !== null) {
      bodyEncoding = "json";
      body = maybeJson;
    } else {
      bodyEncoding = "base64";
      body = bytesToBase64(bytes);
    }
  }

  const payload = {
    url,
    method,
    query,
    bodyEncoding,
    body,
    capturedAt: isoNow(),
    tabId: typeof details.tabId === "number" ? details.tabId : null,
  };

  dbg("buildPayload", {
    method,
    url: maskUrl(url),
    bodyEncoding,
    hasBody: body !== null,
    tabId: payload.tabId,
  });
  return payload;
}

/**
 * @returns {{ bookmaker: string; payloadKind: string } | null}
 */
function matchCaptureTarget(url) {
  if (typeof url !== "string") return null;
  const u = url.toLowerCase();
  if (u.includes("auth-241o-sp.sbx.bet")) {
    if (u.includes("/to_bet_slip")) return { bookmaker: "westace", payloadKind: "to_bet_slip" };
    if (u.includes("/place_bet")) return { bookmaker: "westace", payloadKind: "place_bet" };
    return null;
  }
  // Gambana sportsbook → Betby CDN (see mainbot `GAMBANA_BETBY_PLACE_URL`)
  if (u.includes("sptpub.com") && u.includes("/bet/place")) {
    return { bookmaker: "gambana", payloadKind: "place_bet" };
  }
  // Mystake sportsbook → messagetosport (createticketnew filtered in forwardCaptured)
  if (u.includes("mystake.com") && u.includes("/api/game/p/messagetosport")) {
    return { bookmaker: "mystake", payloadKind: "createticketnew" };
  }
  return null;
}

async function forwardCaptured(details) {
  try {
    const target = matchCaptureTarget(details.url);
    if (!target) return;
    dbg("onBeforeRequest", {
      url: maskUrl(details.url),
      method: details.method,
      tabId: details.tabId,
      hasRequestBody: Boolean(details.requestBody),
    });
    const settings = await getSettings();
    if (!settings.running) {
      dbg("skip capture: not running");
      return;
    }

    const payload = { ...buildPayload(details), kind: target.payloadKind };

    if (target.bookmaker === "mystake") {
      const body = payload.body;
      if (body?.name !== "createticketnew") {
        dbg("skip capture: mystake messagetosport without createticketnew", {
          name: body?.name,
        });
        return;
      }
    }

    const msg = {
      type: "NEWTIP",
      token: settings.token,
      data: {
        bookmaker: target.bookmaker,
        kind: 0,
        opbookmaker: "copybot",
        payload,
      },
    };

    const safeUrl = maskUrl(details.url);
    pushLog(
      `${isoNow()} [capture] bookmaker=${target.bookmaker} kind=${target.payloadKind} url=${safeUrl}`,
    );

    try {
      await ensureOffscreen();
      dbg("send CAPTURED to offscreen", {
        bookmaker: target.bookmaker,
        kind: target.payloadKind,
      });
      const res = await chrome.runtime.sendMessage({ type: "CAPTURED", msg });
      dbg("CAPTURED response", res);
    } catch (e) {
      pushLog(`${isoNow()} [capture] forward failed: ${String(e)}`);
      dbg("CAPTURED failed", String(e));
    }
  } catch (e) {
    pushLog(`${isoNow()} [capture] forwardCaptured error: ${String(e)}`);
    dbg("forwardCaptured error", String(e));
  }
}

dbg("service worker loaded", { captureUrls: CAPTURE_URLS });
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    void forwardCaptured(details);
  },
  { urls: CAPTURE_URLS },
  ["requestBody"]
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message !== "object") {
      sendResponse({ ok: false, error: "invalid_message" });
      return;
    }

    dbg("runtime.onMessage", message.type);
    if (message.type === "GET_STATE") {
      const settings = await getSettings();
      let offscreenState = null;
      try {
        await ensureOffscreen();
        dbg("GET_STATE -> ask offscreen");
        offscreenState = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      } catch {
        // ignore
      }
      sendResponse({
        ok: true,
        running: settings.running,
        connState: offscreenState?.connState ?? "disconnected",
        logs: [...logs, ...(Array.isArray(offscreenState?.logs) ? offscreenState.logs : [])].slice(
          -LOG_LIMIT
        ),
      });
      return;
    }

    if (message.type === "CLEAR_LOGS") {
      logs = [];
      try {
        await ensureOffscreen();
        await chrome.runtime.sendMessage({ type: "CLEAR_LOGS" });
      } catch {
        // ignore
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "START") {
      const wsUrl = String(message.wsUrl ?? "").trim();
      const token = String(message.token ?? "").trim();
      if (!wsUrl || !token) {
        sendResponse({ ok: false, error: "wsUrl_or_token_required" });
        return;
      }

      await chrome.storage.local.set({
        [STORAGE_KEYS.wsUrl]: wsUrl,
        [STORAGE_KEYS.token]: token,
      });
      await setRunning(true);
      pushLog(`${isoNow()} [state] start requested ws=${wsUrl}`);
      dbg("START", { wsUrl, token: "***" });

      try {
        await ensureOffscreen();
        dbg("send START to offscreen");
        await chrome.runtime.sendMessage({ type: "START", wsUrl, token });
      } catch (e) {
        pushLog(`${isoNow()} [sio] offscreen start failed: ${String(e)}`);
        dbg("START->offscreen failed", String(e));
      }

      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STOP") {
      await setRunning(false);
      pushLog(`${isoNow()} [state] stop requested`);
      dbg("STOP");
      try {
        await chrome.runtime.sendMessage({ type: "STOP" });
      } catch {
        // ignore
      }
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown_type" });
  })();
  return true;
});

