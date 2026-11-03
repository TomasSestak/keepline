import { KeeplineError } from '../core/errors';

/**
 * Socket.IO protocol v5 packet types, carried inside an Engine.IO v4 `4`
 * (message) packet. Only CONNECT, DISCONNECT, EVENT and CONNECT_ERROR are
 * supported; the other three are recognised so they can fail by name.
 */
export const PacketType = {
  CONNECT: 0,
  DISCONNECT: 1,
  EVENT: 2,
  ACK: 3,
  CONNECT_ERROR: 4,
  BINARY_EVENT: 5,
  BINARY_ACK: 6
} as const;

export interface SocketIoPacket {
  type: number;
  /** Namespace, `'/'` when the packet omits it. */
  nsp: string;
  /** Acknowledgement id, when the sender asked for one. */
  id?: number;
  /** Parsed JSON payload, `undefined` when the packet has none. */
  data?: unknown;
}

/**
 * A frame keepline could not map onto the supported Socket.IO subset: either
 * malformed, or a feature that is deliberately out of scope (binary
 * attachments, acknowledgements, long-polling). Surfaces as a `decode-error`.
 */
export class SocketIoProtocolError extends KeeplineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`socket.io: ${message}`, options);
    this.name = 'SocketIoProtocolError';
  }
}

const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/**
 * Parse the Socket.IO part of a frame — everything after Engine.IO's `4`.
 *
 * Format: `<type>[<attachments>-][<nsp>,][<id>][<json>]`.
 */
export const parsePacket = (body: string): SocketIoPacket => {
  const typeCode = body.charCodeAt(0);
  const type = typeCode - 48;
  if (!(type >= 0 && type <= 6)) {
    throw new SocketIoProtocolError(
      `unknown Socket.IO packet type ${JSON.stringify(body.charAt(0))}`
    );
  }

  let index = 1;
  if (type === PacketType.BINARY_EVENT || type === PacketType.BINARY_ACK) {
    const dash = body.indexOf('-', index);
    if (dash === -1) {
      throw new SocketIoProtocolError('binary packet without attachment count');
    }
    index = dash + 1;
  }

  let nsp = '/';
  if (body.charAt(index) === '/') {
    const comma = body.indexOf(',', index);
    const end = comma === -1 ? body.length : comma;
    nsp = body.slice(index, end);
    index = comma === -1 ? end : end + 1;
  }

  const packet: SocketIoPacket = { type, nsp };

  const idStart = index;
  while (index < body.length && isDigit(body.charCodeAt(index))) index += 1;
  if (index > idStart) packet.id = Number(body.slice(idStart, index));

  if (index < body.length) {
    try {
      packet.data = JSON.parse(body.slice(index));
    } catch (error) {
      throw new SocketIoProtocolError('malformed JSON payload', {
        cause: error
      });
    }
  }

  return packet;
};

/** `40`, `40/admin,`, `42/admin,[...]` — the namespace segment of a frame. */
export const namespacePrefix = (namespace: string): string =>
  namespace === '/' ? '' : `${namespace},`;

export const normalizeNamespace = (namespace = '/'): string => {
  const normalized = namespace.startsWith('/') ? namespace : `/${namespace}`;
  if (normalized.includes(',')) {
    throw new KeeplineError(
      `socket.io: invalid namespace ${JSON.stringify(namespace)}`
    );
  }
  return normalized;
};

const isBinary = (value: unknown): boolean =>
  (typeof ArrayBuffer !== 'undefined' &&
    (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) ||
  (typeof Blob !== 'undefined' && value instanceof Blob);

/**
 * Whether a payload contains binary anywhere. `JSON.stringify` would turn an
 * `ArrayBuffer` into `{}` without complaint, so an outbound binary payload has
 * to be refused explicitly rather than sent as garbage.
 */
export const containsBinary = (value: unknown, depth = 0): boolean => {
  if (value === null || typeof value !== 'object') return false;
  if (isBinary(value)) return true;
  if (depth > 32) return false;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function')
    return false;
  if (Array.isArray(value))
    return value.some((item) => containsBinary(item, depth + 1));
  for (const key in value) {
    if (
      Object.hasOwn(value, key) &&
      containsBinary((value as Record<string, unknown>)[key], depth + 1)
    )
      return true;
  }
  return false;
};
