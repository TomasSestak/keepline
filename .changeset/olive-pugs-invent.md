---
'keepline': minor
---

**Added: `ReconnectContext.wasOpen`, and the failure context is now passed to
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
    context?.wasOpen ? postOpen(attempt) : preOpen(attempt)
}
```

Existing one-argument strategies stay assignable and keep working. Two notes on
the signature: `wasOpen` is a required field on `ReconnectContext`, so code
that constructs one by hand (test doubles, mostly) must add it; and passing a
strategy directly to `Array.prototype.map` no longer typechecks, because the
new second parameter collides with `map`'s `index`. Wrap it —
`attempts.map((n) => backoff(n))`. Both are type-level only; runtime behaviour
of an existing strategy is unchanged.
