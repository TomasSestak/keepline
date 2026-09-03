---
'keepline': minor
---

**Changed: `ErrorPhase` separates payload failures from transport failures.**

`onError` reported a malformed inbound frame, a schema rejection, and the
transport's own `error` event under one phase — `socket`. Those three are not
the same kind of news. A browser's `error` event is a bare `Event` with no
status and no reason, by design, and it fires on ordinary disconnects; there is
nothing in it to act on. A frame that failed to decode or validate is a real
defect on one side of the wire or the other.

Collapsing them meant the obvious wiring — hand `onError` to an error tracker,
name it after the payload failures it was added for — reported one exception per
user per session, labelled as something it was not. Found in a production error
tracker with 93k occurrences across 39k users, every one of them a routine
disconnect filed as a parse failure.

Decode failures now report `phase: 'decode'` and schema rejections report
`phase: 'validation'`. `socket` narrows to what it always should have meant: the
transport emitted `error`, or `send()` threw.

```ts
onError: (error, phase) => {
  if (phase === 'socket') return; // no detail, fires on every disconnect
  report(error);
};
```

Minor rather than patch because the phase a consumer receives for these two
cases changes. Code that switched on `'socket'` to catch decode failures needs
to add the new arms; code that ignored `'socket'` as noise now gets the payload
failures it was accidentally discarding. The event stream is untouched —
`decode-error` and `validation-error` were always distinct there, and
`keepline/sentry`'s default capture policy is unchanged.
