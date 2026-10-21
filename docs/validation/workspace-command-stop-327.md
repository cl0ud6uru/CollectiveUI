# Workspace command Stop identity

Provider tool-call IDs identify UI parts but are only unique within an invocation.
Workspace commands now allocate a fresh random execution ID for the daemon and
carry it, together with the existing private instance ID, in running/done output.
The group stream can namespace its tool-call IDs without changing this metadata.
The Stop action validates both IDs and resolves the exact instance through the
authenticated caller's registry before sending a kill. It never scans other
instances. Legacy compatibility without metadata is limited to the caller's
legacy ref.

This prevents both a reused provider ID in a different template instance and a
delayed old Stop from matching a newer command in the same instance. The web Stop
button becomes available after the actual start preview carries both fields;
older retained output remains readable. Expected misses use the existing friendly
error result, so the button reports that the command ended or could not be found.

Focused tests exercise repeated provider IDs, unique per-execution metadata,
exact template targeting, delayed old execution IDs, foreign instances, expired
principals, malformed inputs and legacy compatibility. Static rendering checks
that Stop stays disabled before execution metadata arrives. These tests use
synthetic workspace clients and no Docker or model provider.

The equivalent iOS/macOS generic terminal cards have no individual workspace
command Stop action; their existing turn cancellation remains unchanged. They
continue to consume the same generic output and retain the additional fields in
raw action details. No native client source or UI was edited for this web command control.
