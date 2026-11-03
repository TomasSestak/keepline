---
"keepline": minor
---

**Added: `keepline/socket-io`, for Socket.IO v4 servers without `socket.io-client`.**

A codec that plugs into `createSocket` and `useSocket`: it answers the
Engine.IO handshake with a Socket.IO CONNECT (with an optional `auth` payload,
re-resolved on every connect), answers pings, and reports `open` only once the
server acknowledges the CONNECT.

```ts
import { socketIo, socketIoUrl } from "keepline/socket-io";

const io = socketIo<ServerEvents, ClientEvents>({ auth: () => ({ token }) });
const socket = createSocket({ url: socketIoUrl(base), ...io.options });
io.on(socket, "NEW", (notification) => show(notification));
```

A refused connection — a `44` CONNECT_ERROR, or the server closing the socket
right after the CONNECT — is reported as a `1008` policy close and is not
retried, so an expired token does not become a reconnect loop. Long-polling,
binary attachments and acknowledgements are out of scope and surface as
`decode-error` events.
