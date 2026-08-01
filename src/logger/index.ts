import type { KeeplineEvent } from '../core/types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const LEVEL_OF: Partial<
  Record<KeeplineEvent['type'], Exclude<LogLevel, 'silent'>>
> = {
  status: 'debug',
  opening: 'debug',
  open: 'info',
  message: 'debug',
  sent: 'debug',
  queued: 'debug',
  dropped: 'warn',
  close: 'info',
  error: 'error',
  'decode-error': 'warn',
  'validation-error': 'warn',
  'reconnect-scheduled': 'info',
  'gave-up': 'error',
  stale: 'warn',
  heartbeat: 'debug',
  'heartbeat-timeout': 'warn',
  'connect-timeout': 'warn',
  paused: 'debug',
  resumed: 'info',
  destroyed: 'debug'
};

export interface ConsoleLoggerOptions {
  /** Minimum level to print. Default `'info'`. */
  level?: LogLevel;
  /** Prefix for every line. Default `'keepline'`. */
  prefix?: string;
  /** Console-like sink. Default `console`. */
  sink?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  /** Include the event object as a second argument. Default true. */
  includeEvent?: boolean;
}

/**
 * Print the event stream to the console.
 *
 * Development ergonomics that a plain socket cannot give you: the reason a feed
 * went quiet is usually a close code or a validation failure, and both are
 * invisible until something prints them.
 *
 * ```ts
 * createSocket({
 *   url,
 *   onEvent: import.meta.env.DEV ? createConsoleLogger({ level: 'debug' }) : undefined
 * });
 * ```
 */
export const createConsoleLogger = ({
  level = 'info',
  prefix = 'keepline',
  sink = console,
  includeEvent = true
}: ConsoleLoggerOptions = {}): ((event: KeeplineEvent) => void) => {
  if (level === 'silent') return () => {};
  const threshold = RANK[level];

  return (event) => {
    const eventLevel = LEVEL_OF[event.type] ?? 'debug';
    if (RANK[eventLevel] < threshold) return;

    const summary = summarise(event);
    const method = eventLevel === 'warn' ? 'warn' : eventLevel;

    if (includeEvent) sink[method](`[${prefix}] ${summary}`, event);
    else sink[method](`[${prefix}] ${summary}`);
  };
};

const summarise = (event: KeeplineEvent): string => {
  switch (event.type) {
    case 'status':
      return `${event.previous} -> ${event.status}`;
    case 'opening':
      return `connecting to ${event.url} (attempt ${event.attempt})`;
    case 'open':
      return event.reconnected
        ? `reconnected after ${event.downtimeMs}ms down`
        : `connected to ${event.url}`;
    case 'close':
      return `closed ${event.code} ${event.category}${
        event.reason ? ` "${event.reason}"` : ''
      }`;
    case 'reconnect-scheduled':
      return `retry ${event.attempt} in ${event.delayMs}ms (${event.cause})`;
    case 'gave-up':
      return `gave up after ${event.attempts} attempts`;
    case 'stale':
      return `no traffic for ${event.sinceMs}ms`;
    case 'heartbeat':
      return `pong in ${event.rttMs}ms`;
    case 'heartbeat-timeout':
      return `no pong within ${event.timeoutMs}ms`;
    case 'connect-timeout':
      return `handshake timed out after ${event.timeoutMs}ms`;
    case 'dropped':
      return `dropped outbound message (${event.reason})`;
    case 'queued':
      return `queued outbound message (${event.queueSize} waiting)`;
    case 'decode-error':
      return 'failed to decode an inbound frame';
    case 'validation-error':
      return `inbound message failed validation (${event.issues.length} issue(s))`;
    case 'error':
      return `error during ${event.phase}`;
    case 'paused':
      return `paused (${event.reason})`;
    case 'resumed':
      return `resumed (${event.reason})`;
    default:
      return event.type;
  }
};
