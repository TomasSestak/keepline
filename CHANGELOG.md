# keepline

## 0.2.0

### Minor Changes

- 011ee01: Cancel queued request payloads when their promises reject, and scope URL
  resolution, reconnect policy, decoding, validation, timers, and transport work
  to the lifecycle generation that started it. Error-only transports now retry
  without duplicating a later close retry; reconnect decisions and
  `onClose.willReconnect` report the settled policy accurately; heartbeat,
  downtime, subscription ownership, and lifecycle re-entrancy are hardened.
  `getWebSocket()` now exposes the supported `WebSocketLike` contract; consumers
  that need browser-only APIs must narrow the returned transport first.

  Shared React sockets now fan callbacks out per consumer and release stale
  actions correctly. Callback refs are current before descendant layout effects,
  arbitrary reset/subscription dependencies use `Object.is` identity, keyed null
  URLs really disable their connection, and owned providers expose only a real
  socket. Compatibility mode now reports disabled state faithfully, preserves
  query fragments, produces native browser event instances, supports URL
  resolvers, and matches the core reconnect defaults.

  Add race, provider, adapter, EventTarget transport, and package-consumer
  regressions; enforce coverage and Node 18/20/22 verification in CI; smoke-test
  installed ESM, CJS, and type entry points; and remove all high/critical
  development dependency advisories.

## 0.1.2

**Fix: `installMockWebSocket` could not install in jsdom or happy-dom.**

Both environments define `WebSocket` as a non-writable own property of the
global, so the plain assignment threw `Cannot assign to read only property
'WebSocket'` — in precisely the environments the helper exists for. It now
installs with `Object.defineProperty` and restores the original descriptor
verbatim, so a getter-backed or non-writable global goes back exactly as it
was.

Found by migrating a real application onto the package.

## 0.1.1

**React Compiler compatibility.** Every hook and component in the package now
compiles cleanly — 11 of 11, zero bail-outs, enforced in CI by
`bun run check:compiler`.

The cause was the "latest ref" pattern: assigning `ref.current` during render
breaks the Rules of React, and the compiler bails out of any hook that does it.
Refs are now synced in an effect instead. Behaviour is unchanged — every ref
here is only ever read from an asynchronous socket callback, never during
render, so a one-commit lag is not observable.

- `useSocket`, `useSocketMessage`, `useSocketEvent`, `useLastMessage`,
  `useSocketSubscription` and `keepline/compat`'s `useWebSocket`: refs synced in
  an effect rather than during render
- `useSocketMetrics` and `useLastMessage`: options destructured in the body,
  since a defaulted destructuring pattern in the parameter list defeats the
  compiler's lowering pass
- `keepline/compat`: the JSON branch in `lastJsonMessage` moved out of its
  `try` block, which the compiler cannot yet lower
- `SocketProvider`, `useSocketContext`, `useRequiredSocketContext`: declared as
  functions rather than generic arrows, so the `.tsx` module parses under
  Babel-based toolchains (in a `.tsx` file `<TIn = unknown>` is read as JSX)

First release published through npm trusted publishing, so it carries a signed
provenance attestation.

## 0.1.0

Initial release.

A typed, dependency-free WebSocket client with a framework-agnostic core and React bindings.

- **Reconnection** — truncated exponential backoff with jitter on by default, a retry budget, and a refusal to retry auth failures or protocol errors
- **Liveness** — heartbeats with RTT measurement and half-open detection, a `staleAfterMs` silence watchdog, and a handshake timeout
- **Outbound queue** — bounded, flushed in order on open, with configurable overflow behaviour
- **Subscriptions** — `subscribe`/`unsubscribe` pairs replayed on every reconnect
- **Request/response** — `socket.request()` with matching, timeout, and `AbortSignal` support
- **Validation** — inbound messages checked by any [Standard Schema](https://standardschema.dev) library, with decode and validation failures surfaced as events rather than thrown inside a socket handler
- **Status** — eight real states, including `reconnecting`, `paused` and `gave-up`
- **Environment awareness** — optional pause while the tab is hidden, and immediate reconnect on `online`
- **Observability** — one typed event stream, with `keepline/sentry` and `keepline/logger` adapters
- **Testing** — `keepline/testing` ships a scriptable `MockWebSocket`
- **Migration** — `keepline/compat` provides a drop-in `useWebSocket`
