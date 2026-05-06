// Simple Socket.IO echo/log server for manual testing.
//
// Usage:
//   npm i socket.io
//   node ws-echo-server.js

const http = require("http");
const { Server } = require("socket.io");

const port = Number(process.env.PORT || 9001);
const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Socket.IO echo server is running.\n");
});

const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
});

io.on("connection", (socket) => {
  console.log(`[sio-echo] client connected id=${socket.id}`);

  socket.on("NEWTIP", (payload) => {
    console.log(`[sio-echo] NEWTIP from ${socket.id}`);
    try {
      console.log(JSON.stringify(payload));
    } catch {
      console.log(payload);
    }
    socket.emit("NEWTIP_ACK", { ok: true });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[sio-echo] client disconnected id=${socket.id} reason=${String(reason)}`);
  });
});

httpServer.listen(port, () => {
  console.log(`[sio-echo] listening on http://127.0.0.1:${port}`);
});
