'use client';

export {
  SocketProvider,
  useRequiredSocketContext,
  useSocketContext
} from './socket-provider';
export type { SocketProviderProps } from './socket-provider';

export {
  useLastMessage,
  useSocketEvent,
  useSocketMessage
} from './use-socket-message';
export type { UseLastMessageOptions } from './use-socket-message';

export { useSocket } from './use-socket';
export type { UseSocketOptions, UseSocketResult } from './use-socket';

export { useSocketMetrics, useSocketStatus } from './use-socket-status';
export type { UseSocketMetricsOptions } from './use-socket-status';

export { useSocketSubscription } from './use-socket-subscription';

// Re-exported so the common case needs one import.
export {
  constantBackoff,
  exponentialBackoff,
  linearBackoff
} from '../core/backoff';
export {
  classifyCloseCode,
  isAuthFailure,
  isRetryableClose
} from '../core/close-codes';
export { createSocket } from '../core/create-socket';
export {
  ConnectionClosedError,
  GaveUpError,
  KeeplineError,
  RequestTimeoutError,
  SendFailedError,
  ValidationError
} from '../core/errors';
export type {
  CloseContext,
  KeeplineEvent,
  OpenContext,
  ReconnectContext,
  RequestOptions,
  Socket,
  SocketMetrics,
  SocketOptions,
  SocketStatus,
  SubscriptionSpec
} from '../core/types';
