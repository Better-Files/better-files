# @better-files/plugin-nda

Per-room NDA gating for Better Files: versioned agreements, hash-bound acceptances, and content withheld until accepted.

Until a participant accepts the room's current NDA they see the index only (every capability but `LIST` is removed),
and other plugins' room features (Q&A, room-wide annotations, tasks, AI questions) refuse them with `FORBIDDEN`. Core
room operations (the room, its index, membership) and `nda.get` / `nda.accept` stay open. Room owners and
administrators are exempt.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.
