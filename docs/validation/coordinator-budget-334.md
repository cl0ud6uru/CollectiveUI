# Coordinator shared task budget guidance

The coordinator integration suite reproduced issue #334 against the reviewed chat batch: 19 cases passed, while shared-budget exhaustion returned a generic reference message. The admission limit itself remained enforced. Its plain HTTP error crossed the native error boundary without an application-owned error type.

Root task-count/active-task and per-user asynchronous-task limits now throw a dedicated `DelegationBudgetError` with fixed application text and HTTP 429. Only that concrete class passes the native error boundary. Arbitrary HTTP errors, objects claiming the class name or a `userFacing` flag, provider errors and tool errors retain the correlated private fallback. No cap, authority check, retry behavior or provider budget changed.

After repair, all 20 real PostgreSQL coordinator integration cases pass using the suite's loopback mock model. The budget assertion now checks the exact guidance and confirms there are still eight admitted tasks, preventing a presentation fix from concealing admission regression. Native error units cover both limit scopes, retry wrapping and spoofed guidance. Hosted CI now provisions a disposable pgvector database and requires this integration suite instead of skipping it for lack of `DATABASE_URL`.

Web, iOS and macOS receive the same server tool result and already render its error guidance. No client UI changes, installed service, real provider, credential or production configuration was used. Local PostgreSQL proof used version 16.14 with pgvector 0.8.1; the workflow uses PostgreSQL 17 and must pass on the published head.
