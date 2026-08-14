# Migrating from `react-use-websocket`

## Step 1 — swap the import

```diff
- import useWebSocket, { ReadyState } from 'react-use-websocket';
+ import { useWebSocket, ReadyState } from 'keepline/compat';
```

`keepline/compat` keeps the same call signature — `useWebSocket(url, options, connect)` — and returns the same shape: `sendMessage`, `sendJsonMessage`, `lastMessage`, `lastJsonMessage`, `readyState`, `getWebSocket`. A default export is provided too, so `import useWebSocket from 'keepline/compat'` also works.

Callback values are native `Event`, `MessageEvent`, and `CloseEvent` objects in browsers, but they are created for the callback rather than dispatched through an `EventTarget`; their `target` and `currentTarget` therefore remain `null`, and `isTrusted` is `false`.

Supported options: `onOpen`, `onClose`, `onError`, `onMessage`, `onReconnectStop`, `shouldReconnect`, `reconnectInterval`, `reconnectAttempts`, `filter`, `retryOnError`, `protocols`, `share`, `heartbeat`, `queryParams`, and an explicit `key` for shared URL resolvers.

## Behavioural differences to know about

These are deliberate. Each one is a bug in the old default rather than a missing feature.

| | `react-use-websocket` | `keepline/compat` |
| --- | --- | --- |
| **Reconnect delay** | `reconnectInterval` exactly, no jitter | Your `reconnectInterval` is honoured exactly (number or function). Direct `keepline/react` use defaults to jittered exponential backoff. |
| **Auth failures** | Retried when your reconnect policy allows | A delivered auth close code (1008, 3000, 4001, 4401, 4403) is a hard stop; `shouldReconnect` is not called and cannot override it. After refreshing credentials, change the connection identity (URL, `queryParams`, or `protocols`) or toggle the third `connect` argument off and on. Move that call site to `keepline/react` if you need an explicit `reconnect()` function. |
| **Protocol errors** | Retried when your reconnect policy allows | Delivered codes 1002, 1003, 1007, 1009, 1010, and 1015 are hard stops; `shouldReconnect` cannot override them. Recover by replacing the connection identity or toggling `connect`. |
| **`error` without a timely `close`** | `retryOnError` controls whether to retry | Keepline waits 50ms for `close` to own recovery. After that, the browser exposes no usable code or HTTP status: `retryOnError: true` retries, while `false` or omission in `keepline/compat` settles `closed`. |
| **Handshake that hangs** | Waits for the browser | Abandoned after 10s; retried only when reconnection is enabled. |
| **`heartbeat.timeout`** | Closes the socket after N ms of silence | Forces a reconnect after N ms without a pong. Same intent, and it also detects a half-open socket. |
| **Sends before open** | Dropped unless `keep` was used | Queued (bounded, 64 items) and flushed in order on open. `keep: false` keeps its meaning: the message is dropped instead of queued. |
| **Malformed JSON** | `lastJsonMessage` becomes `null` | Same; the compatibility hook keeps the raw `MessageEvent` available as `lastMessage`. |

## Step 2 — move call sites to `keepline/react`

Do this one file at a time; the two can coexist.

### Messages

`filter: () => false` exists to stop `lastJsonMessage` re-rendering on every message. In `keepline/react` that is simply the default:

```diff
- const { lastJsonMessage } = useWebSocket(url, {
-   filter: () => false,
-   onMessage: (event) => handle(JSON.parse(event.data))
- });
+ const { socket } = useSocket<ServerMessage>({ url });
+ useSocketMessage(socket, handle);   // decoded, validated, no re-render
```

Note that `onMessage` now receives a **decoded value**, not a `MessageEvent`. Drop the `JSON.parse` and the `try`/`catch` around it — decoding is the socket's job, and a throw in that callback no longer escapes into the WebSocket's own event handler where nothing can catch it.

### Subscriptions

The hand-rolled "unsubscribe the previous value, subscribe the new one, remember it in a ref" effect becomes:

```diff
- const previous = useRef(symbols);
- useEffect(() => {
-   if (previous.current.length) sendJsonMessage({ type: 'remove', symbols: previous.current });
-   previous.current = symbols;
-   sendJsonMessage({ type: 'add', symbols });
- }, [symbols, sendJsonMessage]);
+ useSocketSubscription(socket, {
+   subscribe: { type: 'add', symbols },
+   unsubscribe: { type: 'remove', symbols }
+ });
```

This also fixes the bug the original always has: after a reconnect the server has forgotten the subscription, but the effect's dependencies did not change, so it never re-runs. The socket looks `OPEN` and the feed is silent.

### Liveness

A hand-rolled "no message in 60s, re-send the subscribe messages" timer is worse than it looks: if the socket is half-open, sending into it changes nothing. Replace it with a real reconnect:

```diff
- useEffect(() => { /* setTimeout(resubscribe, 60_000) on every message */ }, []);
+ staleAfterMs: 60_000     // forces a reconnect, and replays subscriptions on open
```

### Status

```diff
- const isDown = readyState !== ReadyState.OPEN;
+ const { status, isOpen, isReconnecting, isFailed } = useSocket({ url });
```

`readyState` cannot distinguish "reconnecting" from "gave up" — both are `CLOSED`. If you were debouncing a disconnected banner to avoid flashing it during a blip, `isFailed` may let you drop the debounce entirely.

### Auth tokens outside the URL

A token in `protocols` is invisible to change detection, so a refresh keeps serving the old connection until the server drops it. Declare it:

```diff
  useSocket({
    url,
    protocols: ['MyProtocol', `Bearer.${accessToken}`],
+   resetKeys: [accessToken]
  });
```

### Tests

Module mocks stub out the reconnection logic along with the transport. Replace them:

```diff
- vi.mock('react-use-websocket', () => ({ default: vi.fn() }));
+ import { MockWebSocket, installMockWebSocket } from 'keepline/testing';
```

You no longer need to reach into `react-use-websocket/dist/lib/types` for a return type — `keepline` publishes real type entry points for every export path.

## Step 3 — drop the dependency

```bash
npm uninstall react-use-websocket   # or: bun remove / yarn remove / pnpm remove
```

If you carried a bundler workaround for the CJS-only package — a Vite `optimizeDeps.include` entry, a webpack alias, a `transpilePackages` entry — remove it too. `keepline` ships ESM with a proper `exports` map.
