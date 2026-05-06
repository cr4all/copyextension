# Follow me (westace)

Chrome extension (Manifest V3) that intercepts westace-related betting requests (`to_bet_slip`, `place_bet`) and forwards them to a Socket.IO server as **`NEWTIP`** events.

## Overview

- **Role**: Capture network request bodies for a specific host and send them to a remote bot/server.
- **Connection**: Enter the Socket.IO URL and auth token in the popup, then **Start** the session.
- **Delivery**: Keeps a Socket.IO client in an offscreen document for reconnect and queue handling.

## Capture rules

The background script (`background.js`) captures and forwards only when **all** of the following are true:

- The URL contains `auth-241o-sp.sbx.bet`
- The path contains `/to_bet_slip` or `/place_bet`
- The extension is **running** (after **Start** in the popup)

`manifest.json` uses `<all_urls>` under `host_permissions` for debugging; the real filter is the rules above and `isTargetUrl` in code.

## Project layout

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest, permissions, service worker |
| `background.js` | `webRequest` listener, settings, logs, offscreen control |
| `offscreen.html` / `offscreen.js` | Socket.IO connection and `NEWTIP` emits |
| `popup.html` / `popup.js` / `popup.css` | URL/token inputs, Start/Stop, log UI |
| `vendor/socket.io.min.js` | Socket.IO client library |
| `tools/ws-echo-server.js` | Local echo server for manual testing |
| `SPECIFICATION.txt` | Full requirements / technical spec (MV3) |

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this repository’s `CopyExtension` folder.

## Usage

1. Click the extension icon to open the popup.
2. Enter **Socket.IO URL** (e.g. `http://127.0.0.1:9001`) and **Auth Token**.
3. Click **Start**. If you see `[sio] connected` (or similar) in the log, the client is connected.
4. On the target site, run the betting flow so the API requests fire; the log should show `[capture]`, `[queue]`, etc., and the server receives payloads on **`NEWTIP`**.
5. Click **Stop** to stop capture and tear down the session.

## Server-side event

- The client sends messages on the Socket.IO event **`NEWTIP`** (constant `SOCKET_EVENT` in `offscreen.js`).
- Payload shape is built in `forwardCaptured` in `background.js` and includes `bookmaker`, `kind`, `opbookmaker`, and `payload` (URL, method, query, body, etc.).

## Local testing

See [TESTING.md](./TESTING.md) for running the echo server and expected logs.

## Permissions

- `webRequest` + `requestBody`: capture request URL and body.
- `storage`: persist URL, token, and running state.
- `alarms`: internal scheduling / worker wakeups.
- `offscreen`: long-lived Socket.IO connection under MV3.
- `host_permissions`: `<all_urls>` (for production, narrow `manifest` and `CAPTURE_URLS` together).

## Version

Per manifest: **0.1.0**
