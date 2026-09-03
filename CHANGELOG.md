# keepline

## 0.6.0

### Minor Changes

- bf9688d: **Added: a `send` phase, so `socket` finally means only the unactionable event.**

  0.5.0 split payload failures out of `phase: 'socket'` and told consumers that
  `socket` is the phase with nothing to act on — drop it, keep the rest. That was
  half true. `socket` still covered two unrelated things: the transport's bare
  `error` event, and a `send()` that threw.

  Those are opposites. The browser's `error` event is a bare `Event` with no
  status and no reason, by design, and it fires on every ordinary disconnect. A
  refused write is a real error with a message and a stack. Filing them under one
  phase meant the documented filter silently discarded write failures — and the
  type's own doc comment said `socket` "carries no detail" one line after naming
  the `send()` case, which should have given it away.

  A refused write now reports `phase: 'send'`. `socket` means the transport
  emitted `error`, nothing else, so `phase === 'socket'` is an exact noise
  predicate rather than an approximate one.

  ```ts
  onError: (error, phase) => {
    if (phase === "socket") return; // exact now, not approximate
    report(error);
  };
  ```

  **Also changed: `keepline/sentry` captures what the docs claim it does.**

  `defaultShouldCapture` captured only `listener` and `encode`, so a malformed
  frame from your own backend was a breadcrumb and never an exception — while
  0.5.0's README told hand-rolled reporters that decode and validation failures
  are real defects worth capturing. The shipped reporter contradicted the advice
  next to it. It now captures every failure that carries a real error —
  `decode-error`, `validation-error`, and every `error` phase except `socket` —
  and still leaves ordinary disconnects and reconnects as breadcrumbs.

  **Documented: `keepline/compat` cannot express any of this.** Its `onError`
  takes a DOM `Event` because that is what `react-use-websocket` passed, and
  preserving that signature is the module's whole purpose — so a decode failure
  arrives there as a synthetic `error` event indistinguishable from a disconnect.
  That is now stated on the option and in MIGRATION.md, pointing anyone wiring an
  error tracker at the core API instead. Behaviour is unchanged.

  Minor because `ErrorPhase` gains a member and two failure paths change the phase
  they report. A consumer filtering `phase === 'socket'` needs no change and gets
  strictly more signal; one that switched on `'socket'` to catch write failures
  needs a `'send'` arm.

## 0.5.1

### Patch Changes

- 50d51cb: **Fixed: `useSocket` relabelled payload failures as `socket`, undoing the 0.5.0
  phase split for every React consumer.**

  0.5.0 gave decode failures `phase: 'decode'` and schema rejections
  `phase: 'validation'`. The React binding never got the memo. `useSocket` maps
  the event stream to `onError` itself, and that mapping hardcoded `'socket'` for
  both:

  ```ts
  case 'decode-error':
    notifyError(event.error, 'socket');
  case 'validation-error':
    notifyError(new ValidationError(...), 'socket');
  ```

  So the documented filter — `if (phase === 'socket') return` — silently
  discarded the malformed frames it was written to catch, and `phase` stayed
  useless in exactly the binding most consumers use. Only the core honoured the
  new contract.

  Both cases now forward the phase the core assigned. `'error'` events already
  passed `event.phase` through and are unchanged, as is `keepline/compat`.

## 0.5.0

### Minor Changes

- 17eeff2: **Changed: `ErrorPhase` separates payload failures from transport failures.**

  `onError` reported a malformed inbound frame, a schema rejection, and the
  transport's own `error` event under one phase — `socket`. Those three are not
  the same kind of news. A browser's `error` event is a bare `Event` with no
  status and no reason, by design, and it fires on ordinary disconnects; there is
  nothing in it to act on. A frame that failed to decode or validate is a real
  defect on one side of the wire or the other.

  Collapsing them meant the obvious wiring — hand `onError` to an error tracker,
  name it after the payload failures it was added for — reported one exception per
  user per session, labelled as something it was not. Found in a production error
  tracker with 93k occurrences across 39k users, every one of them a routine
  disconnect filed as a parse failure.

  Decode failures now report `phase: 'decode'` and schema rejections report
  `phase: 'validation'`. `socket` narrows to what it always should have meant: the
  transport emitted `error`, or `send()` threw.

  ```ts
  onError: (error, phase) => {
    if (phase === "socket") return; // no detail, fires on every disconnect
    report(error);
  };
  ```

  Minor rather than patch because the phase a consumer receives for these two
  cases changes. Code that switched on `'socket'` to catch decode failures needs
  to add the new arms; code that ignored `'socket'` as noise now gets the payload
  failures it was accidentally discarding. The event stream is untouched —
  `decode-error` and `validation-error` were always distinct there, and
  `keepline/sentry`'s default capture policy is unchanged.

## 0.4.0

### Minor Changes

- dcaa930: **Added: `ReconnectContext.wasOpen`, and the failure context is now passed to
  `backoff`.**

  A gateway that refuses the WebSocket upgrade may not produce a useful auth
  close code. It can surface in the browser as `error` and `close: 1006`
  effectively together — no status, no reason, and the same code an ordinary
  network drop produces. In that event shape the close owns recovery, so neither
  `retryOnError` nor the close-code table can identify the rejection. A socket
  tuned to recover quickly from drops can therefore retry a rejected token at
  exactly the same rate, indefinitely.

  Nothing in `ReconnectContext` reported whether the attempt that just failed had
  reached `open`, even though the core already tracked it. `wasOpen` exposes that
  fact without claiming to classify the cause: `false` covers every pre-open
  failure, including rejected upgrades, network, DNS or TLS failures, connection
  timeouts, and errors while resolving the URL or creating the transport. It is
  scoped to the attempt rather than the socket's lifetime, so a token that expires
  mid-session reads `false` on the attempts that follow it.

  `BackoffStrategy` now receives the context as an optional second argument,
  which makes the distinction actionable — `shouldReconnect` can only refuse,
  while `backoff` can charge pre-open and post-open failures different delays.
  One hard retry budget is shared by pre-open failures and long outages, so it
  can strand a socket that would otherwise have recovered. Different delay
  curves keep post-open recovery fast while bounding the cost of repeated
  pre-open failures.

  ```ts
  reconnect: {
    backoff: (attempt, context) =>
      context?.wasOpen ? postOpen(attempt) : preOpen(attempt);
  }
  ```

  Existing one-argument strategies stay assignable and keep working. Two notes on
  the signature: `wasOpen` is a required field on `ReconnectContext`, so code
  that constructs one by hand (test doubles, mostly) must add it; and passing a
  strategy directly to `Array.prototype.map` no longer typechecks, because the
  new second parameter collides with `map`'s `index`. Wrap it —
  `attempts.map((n) => backoff(n))`. Both are type-level only; runtime behaviour
  of an existing strategy is unchanged.

## 0.3.0

### Minor Changes

- 815f80d: **Changed: `shouldReconnect` now narrows the close-code policy.**

  0.2.0 unified the reconnect paths so that `onClose.willReconnect` reports the
  settled decision instead of a prediction made before the policy ran — a real
  fix. In the process the close-code table was demoted from a hard gate to a soft
  default that any `shouldReconnect` callback replaced outright.

  That inverted a safety property for the most common way the callback is
  written. A policy that adds one extra stop condition and returns `true`
  otherwise — `shouldReconnect: () => !prevented`, the shape almost every consumer
  lands on — no longer refused auth failures or protocol errors. A server
  rejecting credentials with 1008 was reconnected against forever, which is both
  the loop the close-code table exists to prevent and, from the server's side,
  indistinguishable from an attack.

  `shouldReconnect` is now an extra veto that narrows the built-in policy and
  cannot widen it. This intentionally changes the documented 0.2.x override
  behaviour, so this release is a minor version. When a delivered `CloseEvent`
  contains a non-retryable auth or protocol code, the callback is not consulted.
  `onClose.willReconnect` keeps reporting the settled decision accurately.

  To retry a non-retryable close deliberately — after refreshing a token, say —
  call `socket.reconnect()` after fixing the cause.

  The error-only fallback is also bounded now. Keepline waits 50ms for a `close`
  event to own recovery, then abandons the errored transport and passes the
  failure through the central reconnect policy. `reconnect: false` and
  `retryOnError: false` therefore settle `closed`, clear the connect timeout, and
  never leak into a later retry. The core API default remains
  `retryOnError: true` for backward compatibility.

  Browsers expose neither an HTTP status nor a close code on `error`. A rejected
  upgrade that emits only `error`, or delivers `close` after the grace period,
  cannot be classified as authentication or protocol failure and is governed by
  `retryOnError`.

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
