# Native memory and workspace cancellation

Native `remember` and `forget` check Stop before dispatch. Remember also forwards the signal to embedding and checks it after embedding and the final consent read, immediately before inserting. An aborted embedding cannot fall back to inserting an unembedded memory. An insert already acknowledged remains successful if Stop follows it; cancellation is not a database undo operation.

Workspace write, edit and attachment-import tools check Stop inside the serialized queue before starting an effect. Edit checks again after reading its source. Attachment import checks after metadata and blob reads and again after reading the destination. Writes recheck after workspace reference resolution and forward the signal to the sandboxd HTTP request. Queued canceled work never starts a file write; a stopped request is never retried automatically.

These checks do not recall bytes already accepted by sandboxd or a memory mutation already sent to the database. An interrupted in-flight effect remains uncertain and must be inspected before retrying. The existing durable-run closing behavior retains that uncertainty. Acknowledged effects remain acknowledged even when Stop arrives immediately afterward. Ownership, original attachment binding, approval rules, workspace isolation and credential routes are unchanged.

Synthetic tests exercise pre-aborted operations, held embeddings/consent reads, queued writes/edits/imports, stopped file/blob/reference reads, acknowledgement races and a real loopback HTTP write canceled in flight. No actual sandbox daemon, account, uploaded document, inference call or deployment is needed.
