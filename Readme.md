# deno-relay

A blind relay: every WebSocket client that joins a room has its frames handed to
the other clients in that room and nothing else. The relay never parses,
rewrites or inspects a payload, so it stays useful for traffic it must not
understand.

Rooms are backed by a `BroadcastChannel`, which does the pairing: each
connection opens `room_<roomId>`, posts whatever it receives from its socket,
and pushes whatever the channel delivers back out to its socket.

## Run it

```sh
deno task dev
```

Then open http://localhost:8000 in two tabs with the same room id and send a
message in one of them.

```sh
deno task test
```

## Endpoints

| Request                                         | Behaviour                                        |
| ----------------------------------------------- | ------------------------------------------------ |
| `GET /`                                         | Test client (`index.html`)                       |
| `GET /healthz`                                  | `200` with `pi-med E2E Relay Server is running.` |
| `GET /relay?roomId=alpha`                       | `400 Missing roomId parameter`                   |
| Any path, `upgrade: websocket`, `?roomId=alpha` | Blinded relay socket                             |

The upgrade check runs first, so a WebSocket relay works on any path:
`ws://localhost:8000/relay?roomId=alpha` and `ws://localhost:8000/?roomId=alpha`
behave the same.

## What a client gets

- Every frame another client in the same room sends, and no frame of its own.
- Nothing at all from a different room.
- Binary payloads as the same bytes that were sent, not a `Blob` wrapper.
- Nothing that was sent before it connected.

## Limits worth knowing

- **One process.** `BroadcastChannel` is in-memory, so only clients on the same
  server instance are paired. Behind Deno Deploy, two clients can land on
  different isolates and never meet; cross-instance delivery needs something
  shared such as Deno KV or Durable Objects.
- **Fire and forget.** A channel is per-message and unbuffered, and a socket
  that is not `OPEN` drops what the channel hands it. There is no history, no
  acking and no retry: send whatever is safe to lose, or put reliability in the
  payload.
- **No authorization.** Anyone who can reach the server and guess a room id can
  join it. A room id is a name, not a secret.

## How a connection is wired

```ts
const channel = new BroadcastChannel(`room_${roomId}`);

socket.onmessage = (event) => channel.postMessage(event.data);
channel.onmessage = (event) => socket.send(event.data);
```

The channel is closed when the socket closes or errors, so a disconnecting
client gives its channel back.
