# Lifecycle

A sandbox moves through five states: `creating`, `running`, `paused`,
`destroying`, `destroyed`. Transitions are driven by control-plane
endpoints, and most are asynchronous on the server side — the SDK exposes
`waitUntilRunning`, `waitUntilPaused`, and `waitUntilDestroyed` helpers
that poll with adaptive backoff.

Pause freezes the entire VM, including its RAM contents, so that a later
resume picks up exactly where it left off. Fork takes a paused sandbox
and produces an independent clone that shares the same memory snapshot.
Both operations run as background jobs on the host.

Destroy is the only terminal state. Once a sandbox is destroyed its id is
gone forever — there is no recovery and no undelete.
