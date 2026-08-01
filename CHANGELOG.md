# keepline

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
