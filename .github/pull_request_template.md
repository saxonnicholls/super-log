<!--
  Squash merging is the default here, so this description becomes the commit
  message. It is worth a few sentences: this repo's history is meant to
  explain WHY, not just what.
-->

## What this changes

<!-- One or two sentences. What was wrong, or missing, before? -->

## What you observed

<!--
  The habit that makes this repo trustworthy: say what you actually RAN and
  what you SAW, and label anything you could not check.

  "Ran superlog-foo against a live hub on macOS; 14 events arrived on
   foo.<host>, levels mapped as expected. Not verified: the Windows path -
   no Windows machine here."

  "Written, not verified" is a perfectly good answer. Quietly implying it
  works is not.
-->

## Checklist

- [ ] Ran it against a real hub, not only the tests
- [ ] `npm test` passes
- [ ] Events validate against [docs/PROTOCOL.md](../docs/PROTOCOL.md) — one
      compact JSON object per line, the six level names, `origin` saying who
      is speaking

If this adds a **producer** (an SDK, a tailer, anything that emits events),
it also keeps the contract that makes producers safe to leave running:

- [ ] Bounded queue — it cannot grow without limit
- [ ] Drops **oldest** when full, because the newest events describe whatever
      is going wrong right now
- [ ] Counts what it dropped, and can report it
- [ ] Never blocks the program it is observing, and never takes it down —
      not on a full queue, not when the hub is unreachable

<!--
  New streams are especially welcome. If something on your desk emits logs
  and this cannot read it yet, that is the gap worth filling.
-->
