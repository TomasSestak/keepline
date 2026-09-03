---
'keepline': patch
---

**Fixed: `useSocket` relabelled payload failures as `socket`, undoing the 0.5.0
phase split for every React consumer.**

0.5.0 gave decode failures `phase: 'decode'` and schema rejections
`phase: 'validation'`. The React binding never got the memo. `useSocket` maps
the event stream to `onError` itself, and that mapping hardcoded `'socket'` for
both:

```ts
case 'decode-error':
  notifyError(event.error, 'socket');
case 'validation-error':
  notifyError(new ValidationError(...), 'socket');
```

So the documented filter — `if (phase === 'socket') return` — silently
discarded the malformed frames it was written to catch, and `phase` stayed
useless in exactly the binding most consumers use. Only the core honoured the
new contract.

Both cases now forward the phase the core assigned. `'error'` events already
passed `event.phase` through and are unchanged, as is `keepline/compat`.
