---
'keepline': minor
---

**Added: a `send` phase, so `socket` finally means only the unactionable event.**

0.5.0 split payload failures out of `phase: 'socket'` and told consumers that
`socket` is the phase with nothing to act on — drop it, keep the rest. That was
half true. `socket` still covered two unrelated things: the transport's bare
`error` event, and a `send()` that threw.

Those are opposites. The browser's `error` event is a bare `Event` with no
status and no reason, by design, and it fires on every ordinary disconnect. A
refused write is a real error with a message and a stack. Filing them under one
phase meant the documented filter silently discarded write failures — and the
type's own doc comment said `socket` "carries no detail" one line after naming
the `send()` case, which should have given it away.

A refused write now reports `phase: 'send'`. `socket` means the transport
emitted `error`, nothing else, so `phase === 'socket'` is an exact noise
predicate rather than an approximate one.

```ts
onError: (error, phase) => {
  if (phase === 'socket') return; // exact now, not approximate
  report(error);
};
```

**Also changed: `keepline/sentry` captures what the docs claim it does.**

`defaultShouldCapture` captured only `listener` and `encode`, so a malformed
frame from your own backend was a breadcrumb and never an exception — while
0.5.0's README told hand-rolled reporters that decode and validation failures
are real defects worth capturing. The shipped reporter contradicted the advice
next to it. It now captures every failure that carries a real error —
`decode-error`, `validation-error`, and every `error` phase except `socket` —
and still leaves ordinary disconnects and reconnects as breadcrumbs.

**Documented: `keepline/compat` cannot express any of this.** Its `onError`
takes a DOM `Event` because that is what `react-use-websocket` passed, and
preserving that signature is the module's whole purpose — so a decode failure
arrives there as a synthetic `error` event indistinguishable from a disconnect.
That is now stated on the option and in MIGRATION.md, pointing anyone wiring an
error tracker at the core API instead. Behaviour is unchanged.

Minor because `ErrorPhase` gains a member and two failure paths change the phase
they report. A consumer filtering `phase === 'socket'` needs no change and gets
strictly more signal; one that switched on `'socket'` to catch write failures
needs a `'send'` arm.
