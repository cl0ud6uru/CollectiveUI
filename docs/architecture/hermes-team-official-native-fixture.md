# Synthetic official-plan native Responses fixture

Run the bounded fixture from the application checkout:

```sh
HERMES_SOURCE=/path/to/clean/pinned/hermes \
HERMES_TEAM_CANDIDATE_PYTHON=/path/to/disposable/venv/bin/python \
npx vitest run --project unit tests/unit/hermes-team-official-native.test.ts --maxWorkers=1
```

The source must match the revision and every production hash in `src/local-hermes/team-candidate-contract.json`. The disposable Python environment needs `tests/fixtures/hermes-team-candidate-requirements.txt`. Without `HERMES_SOURCE`, the tests explicitly skip; the pinned-native CI job supplies the source and executable and requires both cases.

Each case uses a different synthetic member account with its own subject, host, encrypted tokens and catalog. The fixture runs actual application startup, database claims, authenticated Unix-socket broker, pinned gateway bootstrap, session and conversational loop. Its model and learning requests enter the production HTTP handlers. A synthetic claims verifier and same-token catalog response seed the account; a fixed Responses SSE provider is the only inference substitute. Native tools, delegation, auxiliary title generation and background review run from the unmodified pin.

The actual native loop creates a procedure through `skill_manage`, records private native memory, and runs a `delegate_task` child. Native flat function definitions become the fixed `collective_native` namespace upstream. The streamed function calls become native calls again, and subsequent native tool results retain their call IDs and namespace when sent upstream. Primary, delegate and learning requests use the pin's `codex_responses` codec. Auxiliary title requests enter the Chat API and are converted to the official Responses contract and back. Selecting that native codec does not use native Codex login or change the distinct official-plan authentication contract.

The parent performs three reply requests, including the native delegate closeout, and one subagent request. Title generation performs one or two utility requests: the pin schedules it asynchronously, so closeout may start a second title before the first is saved. Confirmed parent shutdown and terminal settlement create a fresh queued learning child. Its production worker performs two learning requests, creates the learned skill, and stops the native writer before recording success. Every request uses the current member's synthetic account, has its purpose recorded, and produces a personal usage event with no company app or inferred monetary cost. The two members share the transport contract hash while retaining distinct account binding hashes.

The fixture scans stopped native profile files for both accounts' synthetic access and refresh tokens, all issued model/tool/learning grants, and the attached company's synthetic credential. Retained parent grants cannot dispatch any model purpose after retirement. A company model is deliberately attached to the bot and remains unused. Private history and skills remain in the owning profile.

This proves the supported request and response shapes against actual pinned native execution. It does not establish live OAuth validity, account entitlement, model availability, remote plan billing or deployment networking. Its source driver permits only the fixture's single loopback port. Production verification inventories remain empty. The separate hosted official-image job tests container execution with synthetic HTTPS; a real account/model capability check and pilot require separately bounded authorization.
