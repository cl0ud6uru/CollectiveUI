# Synthetic pinned native Team lifecycle

Run the bounded native regression from the application checkout:

```sh
HERMES_SOURCE=/path/to/clean/pinned/hermes \
HERMES_TEAM_CANDIDATE_PYTHON=/path/to/disposable/venv/bin/python \
npx vitest run --project unit tests/unit/hermes-team-native-lifecycle.test.ts --maxWorkers=1
```

The source must be the clean revision and file hashes in `src/local-hermes/team-candidate-contract.json`. The disposable Python environment needs the pinned Hermes dependencies and its MCP client. Without `HERMES_SOURCE`, the native test is explicitly skipped.

This fixture runs the production application's worker startup and model/MCP/learning HTTP handlers through the real authenticated Unix-socket broker, provisioning, pairing and retirement. It then runs the actual pinned gateway dispatcher, `session.create`, `prompt.submit`, conversational loop and native tool handlers. Provider responses are fixed synthetic HTTP data; the native loop itself is not replaced. Every socket connection in the native subprocess is restricted to the fixture's single loopback port, and ambient authentication environment variables are removed. The queue's delivery transport is synthetic; durable scheduling, queue rows, claims and the learning worker are production code.

The test teaches a procedure with native `skill_manage` and `memory` and holds a scoped native MCP write until the current actor approves. Native post-turn learning captures one bounded, encrypted snapshot while the parent is open. A terminal parent cannot make further model calls. Only confirmed writer shutdown permits a fresh queued child, fresh model grants and the dedicated learning RPC. The production learning worker runs native background skill creation and improvement, stops its native writer before terminal completion, and leaves the source conversation's messages unchanged. Autonomous review preserves the skill created in the foreground conversation. A stopped-profile file scan checks that opaque model, tool and learning grants and the synthetic provider credential were not persisted.

The publication service captures only the selected learned package. A separate member profile receives the immutable release, keeps its native private skill and memory, preserves a private correction as a conflict during the next update, then explicitly chooses the reviewed team version. Member corrections use the pin's native skill and memory functions in a separate subprocess; this part does not claim a second member conversation. Duplicate start, publication and installation requests reuse their existing receipts. Replaying the parent's completed retirement does not stop its newer child.

Additional actual-process cases reject a source-hash mismatch before model transport, refuse both Team and personal sibling gateways while the Team process holds the runtime lock, and verify that Stop releases that lock. Held native model cancellation disconnects the synthetic provider without an SDK retry. Audience removal during native human approval prevents continuation, retires the native process and retains private profile data. The fixtures report the current runtime-wide interruption; they do not imply profile-scoped concurrent execution.

The source driver uses temporary owned directories and actual native processes. It supplies only the image-marker filesystem metadata needed by the resource helper after verifying the real source; it does not prove Docker image identity, UID, mounts, s6 supervision or deployment networking. The separate official-image resource-helper smoke covers those container boundaries for resource maintenance; it does not yet prove active Team gateway networking. No route or tool adapter is added to the production verification inventories by this fixture. Real model capability, OAuth and a deployment-host pilot remain separate bounded verification steps.

The source fixture declares the broker's logical network mode as `internet` because it substitutes an allowed single-loopback transport for the production HTTPS gateway. Its Python socket guard still rejects every other connection. This is not an Internet-enabled Docker test: a production runtime configured as `none` correctly refuses active candidate startup, since it cannot reach the model and connector gateway.
