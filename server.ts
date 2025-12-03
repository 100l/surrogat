// server.ts — полностью рабочий WebSocket сервер для SURROGAT
interface Client {
  id: string;
  name: string;
  role: "streamer" | "viewer" | "unknown";
  lastSeen: number;
}

const clients = new Map<WebSocket, Client>();
const CLEANUP_INTERVAL = 15_000;
const TIMEOUT = 45_000;

function getStreamers() {
  return Array.from(clients.values())
    .filter(c => c.role === "streamer")
    .map(c => ({ id: c.id, name: c.name }));
}

function broadcastUsers() {
  const users = getStreamers();
  const payload = JSON.stringify({ type: "users", users });
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch {}
    }
  }
}

function removeClient(ws: WebSocket) {
  const info = clients.get(ws);
  if (!info) return;
  clients.delete(ws);
  if (info.role === "streamer") broadcastUsers();
}

function parseSafe(msg: string) {
  try { return JSON.parse(msg); } catch { return null; }
}

// Heartbeat & cleanup
setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [ws, c] of clients.entries()) {
    if (now - c.lastSeen > TIMEOUT) {
      try { ws.close(); } catch {}
      clients.delete(ws);
      removed = true;
    }
  }
  if (removed) broadcastUsers();
}, CLEANUP_INTERVAL);

// HTTP + WebSocket
addEventListener("fetch", (evt: FetchEvent) => {
  const req = evt.request;
  const url = new URL(req.url);

  if (url.pathname === "/ws") {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      evt.respondWith(new Response("expected websocket", { status: 400 }));
      return;
    }

    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.onopen = () => {
      const tempId = "c_" + Math.random().toString(36).slice(2, 9);
      clients.set(socket, { id: tempId, name: "Аноним", role: "unknown", lastSeen: Date.now() });
      try { socket.send(JSON.stringify({ type: "welcome", msg: "ws ok" })); } catch {}
    };

    socket.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? parseSafe(ev.data) : null;
      if (!data) return;
      const client = clients.get(socket);
      if (!client) return;
      client.lastSeen = Date.now();

      switch (data.type) {
        case "join": {
          client.id = String(data.roomId || client.id);
          client.name = String(data.name || "Аноним");
          client.role = "streamer";
          try { socket.send(JSON.stringify({ type: "joined", roomId: client.id, name: client.name })); } catch {}
          broadcastUsers();
          break;
        }
        case "leave": {
          removeClient(socket);
          try { socket.close(); } catch {}
          break;
        }
        case "viewer_join": {
          client.role = "viewer";
          client.name = String(data.name || "Зритель");
          try { socket.send(JSON.stringify({ type: "viewer_ack", name: client.name })); } catch {}
          socket.send(JSON.stringify({ type: "users", users: getStreamers() }));
          break;
        }
        case "viewer_leave": {
          removeClient(socket);
          try { socket.close(); } catch {}
          break;
        }
        case "list": {
          try { socket.send(JSON.stringify({ type: "users", users: getStreamers() })); } catch {}
          break;
        }
        case "ping": {
          try { socket.send(JSON.stringify({ type: "pong", t: Date.now() })); } catch {}
          break;
        }
      }
    };

    socket.onclose = () => removeClient(socket);
    socket.onerror = () => removeClient(socket);

    evt.respondWith(response);
    return;
  }

  if (url.pathname === "/health") {
    evt.respondWith(new Response("OK"));
    return;
  }

  if (url.pathname === "/list") {
    evt.respondWith(new Response(JSON.stringify({ type: "users", users: getStreamers() }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    return;
  }

  evt.respondWith(new Response("SURROGAT WebSocket server", { status: 200 }));
});
