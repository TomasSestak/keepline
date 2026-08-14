---
'keepline': minor
---

**Added: `ReconnectContext.wasOpen`, and the failure context is now passed to
`backoff`.**

A gateway that refuses the WebSocket upgrade does not produce an auth close
code. The browser reports `error` and `close: 1006` in the same millisecond —
no status, no reason, and the same code an ordinary network drop produces. So
neither `retryOnError` nor the close-code table can refuse it, and a socket
tuned to recover quickly from drops retries a rejected token at exactly the
same rate, indefinitely.

Nothing in `ReconnectContext` carried the one fact that separates the two
cases, even though the core already tracked it. `wasOpen` reports whether the
attempt that just failed had reached `open`. It is scoped to that attempt
rather than the socket's lifetime, so a token that expires mid-session reads
`false` on the attempts that follow it.

`BackoffStrategy` now receives the context as an optional second argument,
which is what makes the distinction actionable — `shouldReconnect` can only
refuse, and refusing is the wrong answer here: a retry budget spent on a
refused handshake is also spent by a long outage, stranding a socket that would
otherwise have recovered. Charging the two cases different delays keeps
recovery fast and bounds the cost of a rejection.

```ts
reconnect: {
  backoff: (attempt, context) =>
    context?.wasOpen ? dropped(attempt) : refused(attempt)
}
```

Existing one-argument strategies stay assignable and keep working. Two notes on
the signature: `wasOpen` is a required field on `ReconnectContext`, so code
that constructs one by hand (test doubles, mostly) must add it; and passing a
strategy directly to `Array.prototype.map` no longer typechecks, because the
new second parameter collides with `map`'s `index`. Wrap it —
`attempts.map((n) => backoff(n))`. Both are type-level only; runtime behaviour
of an existing strategy is unchanged.
