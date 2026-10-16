import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { handler } from "./main.ts";

/** Sentinel returned by `next()` when no frame showed up in time. */
const TIMEOUT = Symbol("timeout");

/**
 * Frames a socket, captured the moment they land so nothing can be missed
 * between sending and subscribing.
 */
function collect(ws: WebSocket) {
  const buffered: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];

  ws.addEventListener("message", (event) => {
    const value = (event as MessageEvent).data;
    const resume = waiting.shift();
    if (resume) resume(value);
    else buffered.push(value);
  });

  return {
    next(ms = 1_000): Promise<unknown | typeof TIMEOUT> {
      if (buffered.length > 0) return Promise.resolve(buffered.shift());
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(TIMEOUT), ms);
        waiting.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
  };
}

type Client = ReturnType<typeof collect> & { socket: WebSocket };

async function connect(url: string, roomId: string): Promise<Client> {
  const socket = new WebSocket(`${url}?roomId=${roomId}`);
  socket.binaryType = "arraybuffer";
  const messages = collect(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("connect failed")),
      {
        once: true,
      },
    );
  });
  return Object.assign(messages, { socket });
}

/** Waits for one frame and fails loudly if none arrives. */
async function frameOf(client: Client, ms = 1_000): Promise<unknown> {
  const value = await client.next(ms);
  assertNotEquals(value, TIMEOUT, `no frame arrived within ${ms}ms`);
  return value;
}

/** Fails if any frame arrives in the window. */
async function silence(client: Client, ms = 300): Promise<void> {
  assertEquals(
    await client.next(ms),
    TIMEOUT,
    "a frame should not have arrived",
  );
}

async function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const done = new Promise<void>((resolve) =>
    socket.addEventListener("close", () => resolve(), { once: true })
  );
  socket.close();
  await done;
}

function startServer() {
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const { port } = server.addr as Deno.NetAddr;
  return {
    server,
    wsUrl: `ws://localhost:${port}/relay`,
    httpUrl: `http://localhost:${port}`,
  };
}

Deno.test("a sender never hears its own message back", async () => {
  const { server, wsUrl } = startServer();
  const alice = await connect(wsUrl, "alpha");
  const bob = await connect(wsUrl, "alpha");
  try {
    alice.socket.send("ping");
    assertEquals(await frameOf(bob), "ping");
    await silence(alice);
  } finally {
    await close(alice.socket);
    await close(bob.socket);
    await server.shutdown();
  }
});

Deno.test("every other client in the room receives the message", async () => {
  const { server, wsUrl } = startServer();
  const alice = await connect(wsUrl, "alpha");
  const bob = await connect(wsUrl, "alpha");
  const carol = await connect(wsUrl, "alpha");
  try {
    alice.socket.send("broadcast");
    assertEquals(await frameOf(bob), "broadcast");
    assertEquals(await frameOf(carol), "broadcast");
    await silence(alice);
  } finally {
    await close(alice.socket);
    await close(bob.socket);
    await close(carol.socket);
    await server.shutdown();
  }
});

Deno.test("binary payloads arrive byte for byte", async () => {
  const { server, wsUrl } = startServer();
  const alice = await connect(wsUrl, "alpha");
  const bob = await connect(wsUrl, "alpha");
  try {
    const payload = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfd, 0xfe, 0xff]);
    alice.socket.send(payload);
    const received = await frameOf(bob);
    assertEquals(new Uint8Array(received as ArrayBuffer), payload);
  } finally {
    await close(alice.socket);
    await close(bob.socket);
    await server.shutdown();
  }
});

Deno.test("a message never leaves its room", async () => {
  const { server, wsUrl } = startServer();
  const alice = await connect(wsUrl, "alpha");
  const stranger = await connect(wsUrl, "beta");
  try {
    alice.socket.send("alpha only");
    await silence(stranger);
  } finally {
    await close(alice.socket);
    await close(stranger.socket);
    await server.shutdown();
  }
});

Deno.test("a client that joins late does not receive earlier messages", async () => {
  const { server, wsUrl } = startServer();
  const alice = await connect(wsUrl, "alpha");
  const bob = await connect(wsUrl, "alpha");
  let latecomer: Client | undefined;
  try {
    alice.socket.send("before");
    assertEquals(await frameOf(bob), "before");

    // Only now does the latecomer show up.
    latecomer = await connect(wsUrl, "alpha");

    alice.socket.send("after");
    assertEquals(await frameOf(latecomer), "after");
    await silence(latecomer);
  } finally {
    if (latecomer) await close(latecomer.socket);
    await close(alice.socket);
    await close(bob.socket);
    await server.shutdown();
  }
});

Deno.test("a relay upgrade without roomId is rejected", async () => {
  const res = await handler(
    new Request("http://localhost/relay", {
      headers: { upgrade: "websocket" },
    }),
  );
  assertEquals(res.status, 400);
  assertEquals(await res.text(), "Missing roomId parameter");
});

Deno.test("the root path serves the test client", async () => {
  const { server, httpUrl } = startServer();
  try {
    const res = await fetch(httpUrl);
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "Blind Relay Test Client");
  } finally {
    await server.shutdown();
  }
});

Deno.test("the health endpoint answers 200", async () => {
  const { server, httpUrl } = startServer();
  try {
    const res = await fetch(`${httpUrl}/healthz`);
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "pi-med E2E Relay Server is running.");
  } finally {
    await server.shutdown();
  }
});
