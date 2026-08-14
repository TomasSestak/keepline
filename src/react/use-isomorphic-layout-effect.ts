import { useEffect, useInsertionEffect } from 'react';

/** Sync callback refs before descendant layout effects; inert during SSR. */
export const useIsomorphicInsertionEffect =
  typeof window === 'undefined' ? useEffect : useInsertionEffect;
