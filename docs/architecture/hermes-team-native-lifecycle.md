# Synthetic pinned native Team lifecycle

Run the bounded native regression from the application checkout:

```sh
HERMES_SOURCE=/path/to/clean/pinned/hermes \
HERMES_TEAM_CANDIDATE_PYTHON=/path/to/disposable/venv/bin/python \
npx vitest run --project unit tests/unit/hermes-team-native-lifecycle.test.ts --maxWorkers=1
```

The source must be the clean revision and file hashes in `src/local-hermes/team-candidate-contract.json`. The disposable Python environment needs the pinned Hermes dependencies and its MCP client. Without `HERMES_SOURCE`, the native test is explicitly skipped.

This fixture runs the production broker's protected Team provisioning, candidate startup, pairing and retirement, followed by the actual pinned gateway dispatcher, `session.create`, `prompt.submit`, native conversational loop and tool handlers. Provider responses are fixed synthetic HTTP data; the native loop itself is not replaced. Every socket connection in the native subprocess is restricted to the fixture's single loopback port, and ambient authentication environment variables are removed.

The test teaches a procedure with native `skill_manage` and `memory`, exercises native background skill creation and improvement, and verifies the native rule that autonomous review preserves a skill created in the foreground conversation. It publishes only the selected learned package through the production capture helper and immutable publication service. A separate member profile receives the release, keeps its native private skill and memory, preserves a private correction as a conflict during the next update, then explicitly chooses the reviewed team version. Duplicate start, publication and installation requests reuse their existing receipts.

The source driver uses temporary owned directories and actual native processes. It supplies only the image-marker filesystem metadata needed by the resource helper after verifying the real source; it does not prove Docker image identity, UID, mounts, s6 supervision or deployment networking. The separate official-image smoke covers those container boundaries. No route or tool adapter is added to the production verification inventories by this fixture. Real model capability, OAuth and a deployment-host pilot remain separate bounded verification steps.
