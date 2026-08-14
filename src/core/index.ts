export {
  constantBackoff,
  exponentialBackoff,
  linearBackoff
} from './backoff';
export type {
  BackoffStrategy,
  ExponentialBackoffOptions,
  JitterMode,
  LinearBackoffOptions
} from './backoff';

export {
  classifyCloseCode,
  isAuthFailure,
  isBackpressureClose,
  isRetryableClose
} from './close-codes';
export type { CloseCategory } from './close-codes';

export { createSocket } from './create-socket';

export { Emitter } from './emitter';
export type { Listener } from './emitter';

export {
  ConnectionClosedError,
  GaveUpError,
  KeeplineError,
  RequestTimeoutError,
  SendFailedError,
  SocketErrorEvent,
  ValidationError
} from './errors';

export { SendQueue } from './send-queue';
export type { OverflowPolicy, PushResult, QueueOptions } from './send-queue';

export {
  acquireSharedSocket,
  listSharedSockets,
  resetSharedSockets
} from './shared';
export type { AcquireOptions, SharedSocketLease } from './shared';

export { formatIssues } from './standard-schema';
export type { StandardSchemaV1 } from './standard-schema';

export type {
  AbortSignalLike,
  BinaryBlob,
  CloseContext,
  DropReason,
  ErrorPhase,
  HeartbeatOptions,
  KeeplineEvent,
  KeeplineEventPayload,
  OpenContext,
  PlatformAbortSignal,
  PlatformBlob,
  PlatformWebSocket,
  ProtocolsInput,
  ProtocolsResolver,
  RawData,
  ReconnectCause,
  ReconnectContext,
  ReconnectOptions,
  RequestOptions,
  SendableData,
  Socket,
  SocketFactory,
  SocketMetrics,
  SocketOptions,
  SocketStatus,
  SubscriptionSpec,
  Unsubscribe,
  UrlInput,
  UrlResolver,
  WebSocketBinaryType,
  WebSocketLike
} from './types';
