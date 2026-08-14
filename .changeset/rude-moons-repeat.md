---
'keepline': minor
---

**Changed: `shouldReconnect` now narrows the close-code policy.**

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
