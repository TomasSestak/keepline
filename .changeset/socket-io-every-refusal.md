---
"keepline": patch
---

`keepline/socket-io`: `onConnectError` now fires for every refused CONNECT, not only for a `44` CONNECT_ERROR or a failed `auth()`. It is also called when the server ends the session (`1`/`41`) instead of acknowledging the CONNECT, and when the connection closes before the acknowledgement — how many servers, gateways and proxies reject auth. It is called exactly once per refusal, just before the `1008` close, which is unchanged.

`SocketIoConnectError` gains a `reason` field (`'connect-error' | 'auth-failed' | 'session-ended' | 'closed-before-ack'`, exported as `SocketIoConnectErrorReason`) to tell refusals apart, and a `closeCode` field carrying the transport's close code for `'closed-before-ack'`. `data` is still the CONNECT_ERROR payload and `undefined` otherwise. Closes that are retried (1001/1012/1013/1014 before the acknowledgement, drops before the CONNECT is sent) and client-initiated closes do not call it.
