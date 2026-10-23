# 0001: Token-file lock is an exclusive flock on `<token file>.lock`

Date: 2026-10-23. Status: accepted (v0.3.1).

## Context
Withings rotates the refresh token on every refresh. When two processes share one token file and refresh at the same
time, the slower one sends an already-replaced refresh token and the grant can be lost. Up to v0.3.0 this server locked
with `open(lock, "wx")` and deleted the lock afterwards (or after 60 s as "stale"). A Python script sharing the file
locked with `fcntl.flock` on the same path. The two schemes do not see each other: flock ignores file existence, the
create-exclusive lock ignores flock, and deleting a flock file lets the next opener lock a new inode.

## Decision
One scheme for every process that shares the file:
1. Open (create, mode 600) `<token file>.lock` and take an exclusive `flock(2)`. Never delete the lock file.
2. Re-read the token file inside the lock; refresh only if the token is still near expiry (or a forced refresh).
3. Save by writing a temp file in the same folder (mode 600, fsync) and `rename` over the token file, inside the lock.

Node has no flock binding, so the server spawns a helper (`flock`, then `perl`, then `python3`) that holds the lock while
its stdin is open. If the server dies, the helper sees EOF and the kernel releases the lock. No helper (Windows): only
in-process serialisation.

## Consequences
Compatible with any script that uses `fcntl.flock(open(f + ".lock", "a"), LOCK_EX)`. One short-lived child process per
refresh (about every 3 hours). Does not work across machines or on network/synced folders.
