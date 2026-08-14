---
'keepline': minor
---

Cancel queued request payloads when their promises reject, and scope URL
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
