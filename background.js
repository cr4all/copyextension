const STORAGE_KEYS = {
  wsUrl: "wsUrl",
  token: "authToken",
  running: "running",
};

const LOG_LIMIT = 500;
// Use <all_urls> for debugging and filter in-code.
// If you want to restrict permissions later, narrow manifest host_permissions and this filter together.
const CAPTURE_URLS = ["<all_urls>"];

/** Gambana betslip slug poll interval (ms). Betslip DOM clears after place; cache last scrape per tab. */
const GAMBANA_SLUG_POLL_MS = 3000;

/** @type {Map<number, { slugs: string[]; updatedAt: string }>} */
const gambanaSlugCacheByTab = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let gambanaSlugPollTimer = null;

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
  return null;
}

/**
 * DOM scrape only (no logging). Used by poller and by verbose extract wrapper.
 * @param {number} tabId
 * @returns {Promise<string[]>}
 */
async function scrapeGambanaBetslipSlugsFromTab(tabId) {
  if (typeof tabId !== "number" || tabId < 0) {
    return [];
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const diag = {
          frameUrl: (() => {
            try {
              return String(window.location?.href ?? "").slice(0, 200);
            } catch {
              return "";
            }
          })(),
          selectorMatchCount: 0,
          anchorHrefSamples: /** @type {string[]} */ ([]),
          parseErrors: /** @type {string[]} */ ([]),
          skippedEmptyLast: 0,
          skippedDuplicate: 0,
          slugs: /** @type {string[]} */ ([]),
        };

        const nodes = document.querySelectorAll('[data-editor-id="betslipSelection"] a[href]');
        diag.selectorMatchCount = nodes.length;

        let sample = 0;
        const seen = new Set();
        for (const a of nodes) {
          const rawHref = a.getAttribute("href") || a.href || "";
          if (sample < 5 && rawHref) {
            diag.anchorHrefSamples.push(String(rawHref).slice(0, 240));
            sample += 1;
          }
          try {
            const u = new URL(rawHref, document.baseURI);
            const segments = u.pathname.split("/").filter(Boolean);
            const last = segments[segments.length - 1];
            if (!last) {
              diag.skippedEmptyLast += 1;
              continue;
            }
            const slug = last.replace(/-\d{10,}$/, "") || last;
            if (!slug) {
              diag.skippedEmptyLast += 1;
              continue;
            }
            if (seen.has(slug)) {
              diag.skippedDuplicate += 1;
              continue;
            }
            seen.add(slug);
            diag.slugs.push(slug);
          } catch (err) {
            if (diag.parseErrors.length < 5) {
              diag.parseErrors.push(String(err?.message || err).slice(0, 120));
            }
          }
        }
        return diag;
      },
    });

    if (!Array.isArray(results) || results.length === 0) {
      return [];
    }

    /** @type {string[]} */
    const mergedSlugs = [];
    const seenMerged = new Set();
    for (let fi = 0; fi < results.length; fi += 1) {
      const inj = results[fi];
      const r = inj?.result;
      if (inj?.error || !r || typeof r !== "object") continue;

      const frameSlugs = Array.isArray(r.slugs) ? r.slugs : [];
      for (const s of frameSlugs) {
        if (typeof s !== "string" || !s) continue;
        if (seenMerged.has(s)) continue;
        seenMerged.add(s);
        mergedSlugs.push(s);
      }
    }
    return mergedSlugs;
  } catch {
    return [];
  }
}

function tabUrlLooksLikeGambanaBook(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.includes("gambana");
  } catch {
    return false;
  }
}

/**
 * Poll open tabs; refresh per-tab cache only when scrape finds slugs (slip cleared after place keeps last slugs).
 */
async function pollGambanaSlugCachesOnce() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    const id = tab.id;
    if (typeof id !== "number" || id < 0) continue;
    if (!tabUrlLooksLikeGambanaBook(tab.url ?? "")) continue;
    const slugs = await scrapeGambanaBetslipSlugsFromTab(id);
    if (slugs.length > 0) {
      gambanaSlugCacheByTab.set(id, { slugs, updatedAt: isoNow() });
      dbg("gambanaSlugPoll", { tabId: id, count: slugs.length });
    }
  }
}

function startGambanaSlugPoller() {
  if (gambanaSlugPollTimer != null) return;
  void pollGambanaSlugCachesOnce();
  gambanaSlugPollTimer = setInterval(() => {
    void pollGambanaSlugCachesOnce();
  }, GAMBANA_SLUG_POLL_MS);
  dbg("gambanaSlugPoller started", GAMBANA_SLUG_POLL_MS);
}

function stopGambanaSlugPoller() {
  if (gambanaSlugPollTimer != null) {
    clearInterval(gambanaSlugPollTimer);
    gambanaSlugPollTimer = null;
  }
  gambanaSlugCacheByTab.clear();
  dbg("gambanaSlugPoller stopped");
}

/**
 * Read Gambana betslip selection links from the tab (DOM scrape). Uses same scrape as poller.
 * @param {number | undefined} tabId
 * @param {{ verbose?: boolean }} [opts]
 * @returns {Promise<{ slugs: string[] }>}
 */
async function extractGambanaBetslipSlugs(tabId, opts = {}) {
  const verbose = Boolean(opts.verbose);
  const tag = "[gambana-slug]";
  if (verbose) {
    pushLog(`${isoNow()} ${tag} step=start tabId=${String(tabId)} typeof=${typeof tabId}`);
  }

  if (typeof tabId !== "number" || tabId < 0) {
    if (verbose) {
      pushLog(
        `${isoNow()} ${tag} step=skip_invalid_tab reason=not_a_number_or_negative tabId=${String(tabId)}`,
      );
    }
    return { slugs: [] };
  }

  if (verbose) {
    pushLog(`${isoNow()} ${tag} step=before_scrape tabId=${tabId}`);
  }

  try {
    const slugs = await scrapeGambanaBetslipSlugsFromTab(tabId);
    if (verbose) {
      if (slugs.length > 0) {
        pushLog(`${isoNow()} ${tag} step=done_ok count=${slugs.length} slugs=${JSON.stringify(slugs)}`);
      } else {
        pushLog(`${isoNow()} ${tag} step=done_empty slugs=[]`);
      }
    }
    return { slugs };
  } catch (e) {
    if (verbose) {
      pushLog(`${isoNow()} ${tag} step=scrape_throw err=${String(e)}`);
    }
    dbg("extractGambanaBetslipSlugs", String(e));
    return { slugs: [] };
  }
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
    if (target.bookmaker === "gambana" && target.payloadKind === "place_bet") {
      const tid = details.tabId;
      /** @type {string[]} */
      let slugs = [];
      let source = "none";

      if (typeof tid === "number" && tid >= 0) {
        const cached = gambanaSlugCacheByTab.get(tid);
        if (cached?.slugs?.length) {
          slugs = [...cached.slugs];
          source = "cache";
          pushLog(
            `${isoNow()} [gambana-slug] step=forward_payload source=cache tabId=${tid} count=${slugs.length} updatedAt=${cached.updatedAt}`,
          );
        }
      }

      if (slugs.length === 0) {
        const { slugs: live } = await extractGambanaBetslipSlugs(tid, { verbose: false });
        if (live.length > 0) {
          slugs = live;
          source = "live";
          pushLog(
            `${isoNow()} [gambana-slug] step=forward_payload source=live tabId=${String(tid)} count=${slugs.length}`,
          );
        }
      }

      if (slugs.length > 0) {
        payload.eventSlugs = slugs;
      } else {
        pushLog(
          `${isoNow()} [gambana-slug] step=forward_payload no_eventSlugs source=${source} tabId=${String(tid)}`,
        );
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

chrome.tabs.onRemoved.addListener((tabId) => {
  gambanaSlugCacheByTab.delete(tabId);
});

void (async () => {
  try {
    const settings = await getSettings();
    if (settings.running) {
      startGambanaSlugPoller();
    }
  } catch {
    // ignore
  }
})();

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
      startGambanaSlugPoller();

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
      stopGambanaSlugPoller();
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

