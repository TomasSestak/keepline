---
'keepline': patch
---

**Fix: `shouldReconnect` could silently disable the close-code policy.**

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

`shouldReconnect` is now what its name suggests: an extra veto that narrows the
built-in policy and cannot widen it. It sits alongside the retry budget,
`reconnect: false`, and `retryOnError: false` as a hard bound, and is not
consulted once one of those has already refused. `onClose.willReconnect` keeps
reporting the settled decision accurately.

To retry a non-retryable close deliberately — after refreshing a token, say —
call `socket.reconnect()` from `onClose`.
