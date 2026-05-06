## Local manual test (Socket.IO echo server)

### 1) Load the extension

- Chrome → `chrome://extensions`
- Turn **Developer mode** ON (top right)
- **Load unpacked** → select the `CopyExtension` folder from your clone (the directory that contains `manifest.json`)

### 2) Run the local Socket.IO echo server (Node)

If Node.js is installed, you can run:

**Windows (PowerShell)**

```powershell
cd path\to\CopyExtension\tools
npm init -y
npm i socket.io
node .\ws-echo-server.js
```

**macOS / Linux**

```bash
cd path/to/CopyExtension/tools
npm init -y
npm i socket.io
node ./ws-echo-server.js
```

Replace `path\to\CopyExtension` or `path/to/CopyExtension` with the absolute path to this project on your machine.

When the server is up, `http://127.0.0.1:9001` should respond in the browser.

### 3) Start from the popup

- Click the extension icon
- Socket.IO URL: `http://127.0.0.1:9001`
- Auth Token: any non-empty string
- Click **Start**

### 4) Trigger a capture

- On the real site, complete the betting flow so `to_bet_slip` / `place_bet` requests occur.
- Or, for debugging, issue test requests against the capture host so the log shows capture / queue / send activity.

### 5) Expected results

- Popup log:
  - `[sio] connected ...`
  - `[capture] kind=...`
  - `[queue] +1 kind=...`
- Echo server console:
  - Payload printed for inbound **`NEWTIP`** events
