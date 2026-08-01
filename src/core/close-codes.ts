/**
 * WebSocket close-code classification.
 *
 * The single most useful piece of information a WebSocket gives you on failure
 * is the close code, and it is the piece almost every wrapper throws away. A
 * 1006 (browser never saw a close frame) means "network"; a 1008 means "the
 * server rejected you and retrying will not help".
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
 */
export type CloseCategory =
  /** 1000 — clean, intentional close by either peer. */
  | 'normal'
  /** 1001 — peer is going away (tab closing, server shutting down). */
  | 'going-away'
  /** 1002, 1003, 1007, 1010 — the exchange was malformed. A bug, not a blip. */
  | 'protocol'
  /** 1005 — no status code was present in the close frame. */
  | 'no-status'
  /** 1006 — closed without a close frame. The classic "network died". */
  | 'abnormal'
  /** 1008 — closed due to a policy violation. Usually auth. */
  | 'policy'
  /** 1009 — message too large. */
  | 'too-large'
  /** 1011, 1012, 1013, 1014 — the server failed or asked you to come back. */
  | 'server-error'
  /** 1015 — TLS handshake failure. */
  | 'tls'
  /** 3000-3999 (IANA registered) and 4000-4999 (application defined). */
  | 'application'
  | 'unknown';

export const classifyCloseCode = (code: number): CloseCategory => {
  if (code === 1000) return 'normal';
  if (code === 1001) return 'going-away';
  if (code === 1002 || code === 1003 || code === 1007 || code === 1010)
    return 'protocol';
  if (code === 1005) return 'no-status';
  if (code === 1006) return 'abnormal';
  if (code === 1008) return 'policy';
  if (code === 1009) return 'too-large';
  if (code >= 1011 && code <= 1014) return 'server-error';
  if (code === 1015) return 'tls';
  if (code >= 3000 && code <= 4999) return 'application';
  return 'unknown';
};

/**
 * Codes that conventionally signal "your credentials were rejected".
 *
 * 1008 is the standard policy-violation code. The 4xxx range is application
 * defined, but 4001/4401/4403 are near-universal conventions for
 * unauthenticated / unauthorized, and 3000 is the IANA-registered
 * "Unauthorized" code.
 *
 * Reconnecting after an auth failure is how you get rate-limited, so
 * {@link defaultShouldReconnect} refuses to.
 */
export const isAuthFailure = (code: number): boolean =>
  code === 1008 ||
  code === 3000 ||
  code === 4001 ||
  code === 4401 ||
  code === 4403;

/**
 * Whether reconnecting after this close code has any chance of working.
 *
 * Deliberately conservative: protocol errors and auth failures are treated as
 * permanent, because retrying them is an infinite loop that also looks like an
 * attack from the server's side.
 */
export const isRetryableClose = (code: number): boolean => {
  if (isAuthFailure(code)) return false;

  switch (classifyCloseCode(code)) {
    case 'protocol':
    case 'too-large':
    case 'tls':
      return false;
    default:
      return true;
  }
};

/**
 * 1013 "Try Again Later" and 1014 are explicit backpressure signals. When a
 * server sends one, honour it with a longer delay than normal backoff.
 */
export const isBackpressureClose = (code: number): boolean =>
  code === 1013 || code === 1014;
