# Pinned Hermes Team Bot contracts

Team Bot runtime work targets Hermes revision [`f97608f178d1ffeca59860195ab7da295f7c8e5f`](https://github.com/NousResearch/hermes-agent/tree/f97608f178d1ffeca59860195ab7da295f7c8e5f) and the existing official image `nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283`. The production bridge checks the baked `.hermes_build_sha` before dispatch. The source contract fixture checks both Git HEAD and hashes of the native files it exercises; advancing the image/source requires reviewing and updating those contracts together.

## Profiles and native learning

`create_profile(name, no_alias=True, no_skills=True)` creates a new profile without copying root skills, memories or authentication files. It writes a private placeholder `.env` and the `.no-bundled-skills` marker. It still seeds the active model block and its selected provider definition, including any inline credentials or endpoint settings in those blocks. Team provisioning must explicitly write its validated model/tool configuration before making the profile available. Never use `clone_config` for team distribution: native config cloning also copies skills and personal memory. Full profile cloning/export is not a publishable-resource boundary.

The bridge identifies a native directory using its device/inode pair. Editing skills, role instructions and memory leaves that identity intact. Reopening a bot or starting a new conversation must reuse the persisted user × bot binding and native home; an inode-changing replacement requires reconciliation rather than adoption. Native paths/profile selectors must stay server-derived. The bridge rejects arbitrary paths and symlinked homes.

Native `skill_manage` creates and edits complete packages in the active profile, including `scripts/` and `assets/`. Native `memory` writes to the active profile's `memories/`. The fixtures execute those real tools separately in an admin working profile and a member profile, with no model or network. Learned disk resources persist immediately. Native memory's system-prompt snapshot is intentionally frozen for the current session and refreshed when the next session loads it. Preserve this native behavior; Team Bots must not also schedule CollectiveUI's memory extraction or embeddings through an application utility model.

Profiles organize agents within one person's container. They do not provide a security boundary from that person's native terminal/tools. Cross-user isolation remains the separate owner container plus server-side authorization.

## Model access

The pinned native `openai-codex` provider uses the Codex Responses route at `https://chatgpt.com/backend-api/codex` with external OAuth. This contract does not verify the newer official ChatGPT plan-usage integration. The source manifest deliberately records no enabled Team Bot inference routes. A synthetic grant or a successful login cannot establish model entitlement.

An empty profile `.env` or empty credential-pool slice does not suppress root authentication: native `read_credential_pool` intentionally borrows root entries whenever that profile has no entries for the provider. The existing bridge's separate-grant/disconnect handling has synthetic native tests, but this is not proof of a policy covering every model call.

The pinned auxiliary router uses a selected main provider first and refuses to discover another logged-in account when that main provider is unavailable. Explicit task `fallback_chain` and top-level `fallback_providers` can still select other providers. Native delegated children inherit the parent's fallback chain unless it is explicitly cleared; child route overrides and their own fallback configuration must also be checked. Required-personal policy therefore needs enforcement across main replies, compression, title/memory helpers, review/background tasks and subagents, including expired grants and capacity failures. Disabling UI provider selection alone is insufficient.

Native background learning has its own runtime resolver. It follows the parent's live route by default, can use a concrete `auxiliary.background_review` provider/model override, and falls back to the parent when that override cannot resolve. A personal review override over a company-paid main model therefore does not establish required-personal behavior. The native regression demonstrates this fallback with synthetic routes.

Before enabling a real route, a separately authorized bounded staging verification must use a disposable admin and member, one allowed model, explicit request/token limits, and provider-call attribution. It must test a reply, native learning/utility work and a native child, then expired/missing access and provider failure, confirming zero company-provider calls in required-personal mode. The official plan-usage route and a server-side admin inference gateway each need their own verified contract. No live grants, credentials, paid inference or production changes were used for these fixtures.

## Stop and updates

`DockerDriver.transport().stop` currently stops the whole owner container to clean up native descendants. A profile's cancellation/error can consequently interrupt another profile's chat or approval wait. Regression tests exercise two active profiles, preserve both native session files and bindings, invalidate the sibling's approval, and show another owner's runtime stays active. This is synthetic native protocol plus the real controller/broker behavior; it is not an actual Docker lifecycle result.

Existing profile settings changes fence every controller in the owner runtime. An idle profile update is refused if a sibling has unfinished work. Team Bot admission and publication/install operations must honor that runtime-wide idle boundary until profile-scoped descendant cancellation is implemented and independently verified. Offboarding and Stop must retain native data and report runtime-wide interruptions explicitly.

## Reproducing the checks

Use a clean checkout at the pinned revision and install `tests/fixtures/hermes-native-requirements.txt` in a disposable Python environment. These commands use temporary native homes, synthetic credentials and mocked provider transports:

```sh
HERMES_SOURCE=/path/to/pinned/hermes HERMES_PYTHON=/path/to/venv/bin/python \
  npx vitest run --project unit tests/unit/hermes-team-contracts.test.ts tests/unit/docker-hermes.test.ts
HERMES_SOURCE=/path/to/pinned/hermes /path/to/venv/bin/python tests/fixtures/docker-hermes-codex.py
HERMES_SOURCE=/path/to/pinned/hermes /path/to/venv/bin/python tests/fixtures/hermes-team-pinned-bridge.py
```

The new native fixture actively rejects socket connections. Its model-route tests replace provider construction and execute the unmodified native routing decisions. Without `HERMES_SOURCE`, Vitest explicitly skips the native-source test; the broker/profile regressions still run. The existing opt-in sandbox suite remains the separate evidence for an official-image Docker lifecycle on a disposable host.

CI's `native-hermes` job runs both Team fixtures directly against a clean checkout of the pinned source, so their checks do not silently skip in that job. `hermes-team-pinned-bridge.py` exercises the production blank-profile bridge with the real native profile enumeration, parked-profile selection and filesystem skill/memory tools. It verifies no root-state seeding, stable identities on retry, crash-safe staging, inference denial and the separate root-auth inheritance limitation. Its synthetic build metadata exercises the bridge's revision check; the native source identity is established independently by Git revision, clean-tree validation and the source hashes. It performs no model generation and does not establish model entitlement or official-image Docker lifecycle support.

Native multiplexed gateways exclude parked Team profiles. Native single-profile selection still names a parked profile; therefore the bridge independently rejects Team inference before launching a gateway. Both checks are required while model routes remain unverified. The source fixture includes that regression and blocks socket `connect`, `connect_ex` and `create_connection` during its checks.
