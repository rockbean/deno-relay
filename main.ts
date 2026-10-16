import { serveFile } from "@std/http/file-server";

/** Path that answers a plain health check. */
const HEALTH_PATH = "/healthz";

const HEALTH_BODY = "pi-med E2E Relay Server is running.";

/**
 * Blind-relays one WebSocket client through its room's BroadcastChannel.
 *
 * Anything that arrives on the socket is published to the room channel
 * untouched, and anything the channel delivers is pushed back out to the socket
 * untouched. The relay never parses, rewrites or inspects the payload.
 */
function relay(req: Request): Response {
  const url = new URL(req.url);
  const roomId = url.searchParams.get("roomId");

  if (!roomId) {
    return new Response("Missing roomId parameter", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  // Binary frames have to land as ArrayBuffer. The default binaryType is
  // "blob", which would round-trip every payload through a Blob on its way to
  // postMessage instead of moving the bytes.
  socket.binaryType = "arraybuffer";

  // Room bus. Every connection to the same roomId opens a channel under the
  // same name, which is what pairs the clients up. A BroadcastChannel never
  // receives the messages it posts itself, which is what keeps a sender from
  // being echoed back.
  const channel = new BroadcastChannel(`room_${roomId}`);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    channel.close(); // free the memory
  };

  socket.onopen = () => {
    console.log(`[Room: ${roomId}] Client connected.`);
  };

  // Client -> room: forward the frame as it came in.
  socket.onmessage = (event) => {
    channel.postMessage(event.data);
  };

  // Room -> client: forward whatever the other clients published.
  channel.onmessage = (event) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(event.data);
    }
  };

  socket.onclose = () => {
    console.log(`[Room: ${roomId}] Client disconnected.`);
    release();
  };

  socket.onerror = (e) => {
    console.error(`[Room: ${roomId}] WebSocket Error:`, e);
    release();
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  };

  return response;
}

export function handler(req: Request): Response | Promise<Response> {
  // 1. WebSocket upgrade -> blind relay. Checked first so the relay answers on
  //    any path, e.g. ws://host/relay?roomId=alpha.
  if (req.headers.get("upgrade") === "websocket") {
    return relay(req);
  }

  // 2. Plain health check, no relay involved.
  if (new URL(req.url).pathname === HEALTH_PATH) {
    return new Response(HEALTH_BODY, { status: 200 });
  }

  // 3. Everything else is the test client.
  return serveFile(req, "./index.html");
}

if (import.meta.main) {
  Deno.serve(handler);
}
