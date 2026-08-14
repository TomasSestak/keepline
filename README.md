<p align="center">
  <img src="https://raw.githubusercontent.com/TomasSestak/keepline/main/assets/keepline-mark.svg" width="160" height="96" alt="" />
</p>

<h1 align="center">keepline</h1>

<p align="center">
  <strong>The line stays up.</strong>
</p>

<p align="center">
  A typed WebSocket client for automatic reconnection, half-open detection, outbound queuing,<br />
  reconnect-safe subscriptions, schema validation, and observability — with first-class React bindings.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/keepline"><img src="https://img.shields.io/npm/v/keepline?style=flat-square&amp;color=CB3837" alt="npm version" /></a>
  <a href="https://github.com/TomasSestak/keepline/actions/workflows/ci.yml"><img src="https://github.com/TomasSestak/keepline/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="#what-you-get"><img src="https://img.shields.io/badge/core-%E2%89%A46_kB_brotli-0f766e?style=flat-square" alt="Core bundle at most 6 kB brotli" /></a>
  <a href="https://github.com/TomasSestak/keepline/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/keepline?style=flat-square&amp;color=0f766e" alt="MIT license" /></a>
</p>

<p align="center">
  <sub>Dependency-free core · ESM + CJS · React 18+ · Node.js 18+</sub>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#what-you-get">Features</a>
  ·
  <a href="#entry-points">Entry points</a>
  ·
  <a href="./MIGRATION.md">Migrate from react-use-websocket</a>
</p>

```bash
npm install keepline
```

## Why

A `WebSocket` is a socket, not a connection. Everything that makes it usable in production — noticing it died, coming back, not hammering the server on the way back, remembering what you were subscribed to, telling you *why* it dropped — is left to you. So every app writes it, and every app writes a slightly broken version.

The specific failures this exists to fix:

- **A socket that is `OPEN` and dead.** A NAT entry expires, a proxy goes away, and `readyState` stays `1` forever while nothing arrives. Only a heartbeat notices.
- **`readyState` cannot express "down but coming back."** Nor "down for good." Both read as `CLOSED`, so a UI built on it cannot tell a blip from an outage.
- **Reconnecting without jitter.** A server restart drops every client at the same instant; an un-jittered fleet then retries at the same instant, repeatedly, turning a 2-second restart into a 5-minute outage.
- **Reconnecting after a close-coded auth failure.** Retrying rejected credentials forever is how a client earns a rate limit.
- **A reconnect that comes back subscribed to nothing.** The socket is open, the server has forgotten your subscriptions, and the effect that sent them does not re-run.
- **Silent close codes.** The single most useful fact about a failure — 1006 network vs 1008 auth vs 4001 application — is the one thing most wrappers throw away.
- **`JSON.parse` in an event handler.** A throw inside a WebSocket callback reaches no error boundary and no `try`/`catch`; it becomes an unhandled window error.
- **Message history in React state.** One re-render per message, in every consumer. On a tick feed that is the entire frame budget.

## Quick start

### React

```tsx
import { useSocket, useSocketSubscription } from 'keepline/react';

const Feed = ({ symbols, enabled }) => {
  const { socket, status, isReconnecting } = useSocket<ServerMessage>({
    // `null` means "not yet" — no conditional hooks, no placeholder connection.
    url: enabled ? 'wss://api.example.com/feed' : null,
    heartbeat: { message: { type: 'ping' }, isPong: (m) => m.type === 'pong' },
    onMessage: (message) => applyToChart(message)
  });

  // Re-sent automatically on every reconnect.
  useSocketSubscription(socket, symbols.length ? {
    subscribe: { type: 'add', symbols },
    unsubscribe: { type: 'remove', symbols }
  } : null);

  return <Badge status={status} reconnecting={isReconnecting} />;
};
```

Callbacks are read from a ref, so **inline arrow functions never cause a reconnect**. Only the connection *identity* does: `key`, a string `url`, `protocols`, and `resetKeys`.

### Anything else

```ts
import { createSocket } from 'keepline';

const socket = createSocket({
  url: () => `wss://api.example.com/feed?token=${getToken()}`, // re-resolved per attempt
  schema: serverMessage,      // any Standard Schema validator
  staleAfterMs: 30_000,
  onMessage: (message) => handle(message)
});
```

## What you get

| | |
| --- | --- |
| **Reconnection** | Truncated exponential backoff with **jitter on by default**; `linearBackoff`/`constantBackoff` provided; per-attempt `shouldReconnect` veto; retry budget; hard-stops delivered auth and protocol close codes; honours a server's 1013 "try again later" with a longer delay |
| **Liveness** | `heartbeat` ping/pong with RTT measurement and half-open detection; `staleAfterMs` silence watchdog; `connectTimeoutMs` for handshakes that hang against a black-holed host |
| **Status** | 8 real states, including `reconnecting`, `paused` and `gave-up` |
| **Outbound** | Bounded queue while connecting, flushed in order on open; `drop-oldest` / `drop-newest` / `reject` overflow policies |
| **Subscriptions** | `socket.subscription({ subscribe, unsubscribe })` — replayed on every reconnect, released on unsubscribe |
| **Request/response** | `socket.request(payload, { match, timeoutMs, signal })` returns a promise |
| **Validation** | `schema` accepts anything implementing [Standard Schema](https://standardschema.dev) — zod ≥ 3.24, valibot, arktype — with **no dependency on any of them** |
| **Errors** | Decode and validation failures become events, never throws inside a socket handler |
| **Browser awareness** | `pauseWhenHidden` to stop burning battery and server capacity in a background tab; instant reconnect on `online` instead of waiting out the backoff |
| **Auth rotation** | `url`/`protocols` resolvers are re-invoked per attempt, so tokens are fresh at connect time — not at render time |
| **Observability** | One `onEvent` stream of 20 typed events, with `keepline/sentry` and `keepline/logger` adapters built on it |
| **Testing** | `keepline/testing` ships a scriptable `MockWebSocket` — the real state machine runs, only the wire is fake |
| **Sharing** | `share: true` or `<SocketProvider>`; reference-counted with a grace period so StrictMode and route transitions don't churn the connection |
| **SSR** | No-ops without a `WebSocket` global. No guards, no dynamic imports |

Core stays under **6 kB** brotli and React bindings under **8 kB**, with both budgets enforced in CI.

## Entry points

| Import | Contents |
| --- | --- |
| `keepline` | `createSocket`, backoff strategies, close-code helpers, errors. No React. |
| `keepline/react` | `useSocket`, `useSocketStatus`, `useSocketMessage`, `useLastMessage`, `useSocketSubscription`, `useSocketMetrics`, `SocketProvider` |
| `keepline/compat` | Migration-focused `useWebSocket` shaped like `react-use-websocket` — see [MIGRATION.md](./MIGRATION.md) |
| `keepline/testing` | `MockWebSocket`, `installMockWebSocket`, `mockSocketFactory` |
| `keepline/sentry` | `createSentryReporter` — breadcrumbs and exceptions, no `@sentry/*` dependency |
| `keepline/logger` | `createConsoleLogger` |

## Recipes

### Auth with short-lived tokens

A resolver runs on *every* attempt, so the token is fresh at connect time — including the reconnect three minutes after the tab was opened. When the browser delivers an auth close code (1008, 4001, 4401, ...), it is a hard stop; `shouldReconnect` can narrow that policy but cannot widen it.

A rejected WebSocket upgrade may instead emit only `error`, or deliver `close` after Keepline's 50ms grace period. Browser error events expose neither the HTTP status nor a close code, so that path is governed by `retryOnError` (default `true`). For a protected endpoint, set it to `false`; the errored transport then settles `closed`, and your application can call `socket.reconnect()` after refreshing credentials.

```ts
const socket = createSocket({
  url: async () => {
    const token = await auth.getFreshToken();   // may refresh
    return `wss://api.example.com/feed?token=${token}`;
  },
  reconnect: { retryOnError: false },
  onClose: ({ category, willReconnect }) => {
    if (category === 'policy' && !willReconnect) redirectToLogin();
  }
});
```

In React, when the token lives in `protocols` instead of the URL, tell the hook it is part of the connection's identity:

```tsx
useSocket({
  url: 'wss://api.example.com/feed',
  protocols: ['app-proto', `bearer.${token}`],
  resetKeys: [token]   // new token -> new connection
});
```

### A gateway that refuses the upgrade

Not every rejection arrives as a close code. When a gateway refuses the WebSocket upgrade outright, the browser reports `error` and `close: 1006` in the same millisecond — no status, no reason, and the same code an ordinary network drop produces. Neither `retryOnError` nor the close-code table can classify it, so a socket that retries drops aggressively retries a rejected token just as aggressively, for as long as the tab stays open.

`wasOpen` is the distinction the close event does not carry: whether the attempt that just failed had reached `open`.

```ts
const dropped = linearBackoff({ stepMs: 200, maxDelayMs: 5_000 });
const refused = exponentialBackoff({ initialDelayMs: 200, maxDelayMs: 60_000 });

const socket = createSocket({
  url: 'wss://api.example.com/feed',
  reconnect: {
    // A dropped session recovers immediately. A handshake that never opened
    // backs off to roughly one attempt a minute instead of one every 5s.
    backoff: (attempt, context) =>
      context?.wasOpen ? dropped(attempt) : refused(attempt)
  }
});
```

Prefer this to capping `attempts`: a budget spent on a refused handshake is also spent by a long outage, and strands a socket that would otherwise have come back on its own. `attempt` resets on every successful open, so a healthy connection never accumulates delay.

### Request/response over the socket

```ts
const socket = createSocket<ServerMessage, ClientMessage>({
  url,
  // Default matcher: correlate by id once, instead of per call.
  matchResponse: (message, sent) => message.replyTo === sent.id
});

const reply = await socket.request(
  { id: nextId(), type: 'get-portfolio' },
  { timeoutMs: 5_000, signal: controller.signal }
);
```

Sent while down? The payload queues, flushes on open, and the promise still resolves when the reply arrives — or rejects with `RequestTimeoutError`, `ConnectionClosedError`, or `GaveUpError`, so the failure mode is always a typed error, never a hang.

If it rejects before opening, its queued payload is removed too — a timed-out or aborted request is never sent later as a stale side effect.

### A status badge users can believe

`status` distinguishes a blip from an outage, which `readyState` cannot:

```tsx
const { status, isReconnecting, isFailed, reconnect } = useSocket({ url });

if (isFailed) return <button onClick={reconnect}>Connection lost — retry</button>;
if (isReconnecting) return <Spinner label="Reconnecting…" />;
return <Dot color={status === 'open' ? 'green' : 'grey'} />;
```

### Binary protocols and custom codecs

`decode`/`encode` replace the default JSON pipeline; a throw in either becomes a `decode-error`/`error` event instead of an unhandled exception:

```ts
import { decode, encode } from '@msgpack/msgpack';

const socket = createSocket<ServerMessage, ClientMessage>({
  url,
  binaryType: 'arraybuffer',
  decode: (data) => decode(data as ArrayBuffer),
  encode: (payload) => encode(payload)
});
```

### In a Node service

Node 22+ has a global `WebSocket`, so nothing changes. On older Node, hand in [`ws`](https://github.com/websockets/ws):

```ts
import WebSocket from 'ws';
import type { WebSocketLike } from 'keepline';

const socket = createSocket({
  url: 'wss://api.example.com/feed',
  socketFactory: (url, protocols) =>
    new WebSocket(url, protocols) as unknown as WebSocketLike
});

await socket.waitForOpen();
```

### One connection for the whole app

```tsx
<SocketProvider options={{ url, heartbeat: { message: { type: 'ping' } } }}>
  <App />
</SocketProvider>

// anywhere below:
const socket = useSocketContext<ServerMessage>();
useSocketMessage(socket, (m) => store.apply(m));
```

Or keep components independent and let them share by identity: `useSocket({ url, share: true })` reference-counts one connection across every hook with the same `key`/`url`.

## Rendering, deliberately

Three ways to consume messages, in order of cost:

```tsx
useSocketMessage(socket, (m) => ref.current?.update(m)); // no re-render (default)
const last = useLastMessage(socket, { filter });          // one re-render per match
const metrics = useSocketMetrics(socket);                 // sampled once a second
```

`useLastMessage` is opt-in on purpose. A library that stores every message in state by default makes the fast path the one you have to disable — which is why so much `react-use-websocket` code carries `filter: () => false`.

## Observability

```ts
import * as Sentry from '@sentry/react';
import { createSentryReporter } from 'keepline/sentry';

createSocket({ url, onEvent: createSentryReporter({ sentry: Sentry }) });
```

Breadcrumbs for connects, close codes, retries and validation failures; captured exceptions only for exhausted retries and errors thrown by your own code. URLs are stripped of query strings by default, and payloads are never recorded unless you ask — tokens live in query strings and breadcrumbs are forever.

When an unrelated exception is reported ten seconds after the feed quietly dropped and retried four times, that trail is the difference between a five-minute diagnosis and an unreproducible ticket.

## Testing

```ts
import { createSocket } from 'keepline';
import { MockWebSocket, mockSocketFactory } from 'keepline/testing';

const socket = createSocket({ url: 'wss://x', socketFactory: mockSocketFactory });
const ws = MockWebSocket.last();

ws.acceptConnection();
ws.serverSend({ type: 'tick' });
ws.serverClose({ code: 1006 });     // a real retry, with real backoff
expect(socket.status).toBe('reconnecting');
```

The usual approach — `vi.mock('the-websocket-library')` — stubs out the transport *and* the reconnection logic, which means the reconnection logic is the one part never tested. Here it runs.

## Design notes

**Why `useSyncExternalStore`.** The socket is an external store, so React reads its status at render time instead of mirroring it into state via an effect. That removes the window in which a component renders a status that is already stale, and makes the bindings correct under concurrent rendering and StrictMode double-mounting.

**Why a core/bindings split.** Non-React consumers — a Node service, a chart controller, a Vue app — are a first-class audience, and `keepline` pulls in no React for them. It also keeps the React layer thin enough to audit: it holds no connection logic of its own.

**Why no `any`.** Enforced by lint. `unknown` plus a narrowing point, or a real type.

## Contributing

```bash
bun install
bun run test      # vitest
bun run verify    # lint + typecheck + test + build
```

Changes are released with [changesets](https://github.com/changesets/changesets) — run `bun run changeset` and describe the change.

## License

MIT
