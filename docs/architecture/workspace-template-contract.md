# Workspace template and private instance contract

Status: proposed integration freeze for separate feature owners, 2026-10-12.
Base: main `7c56f8c3136d699c9961824aeb42dec122ddc8c5` (verified against origin/main).
Scope: reusable versioned recipes, admin catalog, private assignment/provisioning, starter images,
and a view-only feed of the agent's actual browser session. Interactive desktop, remote input,
and interactive LibreOffice document editing are deferred. No live deployment, credential or
security configuration changes, destructive migration, or public publication.

## Evidence and boundaries

- `src/db/schema.ts:1124`, `src/db/migrations/0006_sandbox.sql`, and
  `src/lib/sandbox/store.ts`: one row per user; all existing native bots share that person's ref.
- `src/lib/agent/toolset.ts:84`: lazy `getOrCreateRef(userId)`; existing file, upload, terminal,
  settings, disable/re-enable and cleanup paths also resolve by user.
- `src/sandboxd/config.ts`, `manager.ts`, `spec.ts`: one global image, one cached image ID;
  `portal-home-${ref}` mounted at `/home/agent`; image/spec drift recreates containers and preserves volumes.
- `src/sandboxd/templates.ts` contains validated command argv builders, NOT workspace recipes.
- `docker/sandbox/Dockerfile`: LibreOffice and Python Office packages, no desktop server,
  display session, browser capture or GUI entrypoint. Installed LibreOffice is not GUI proof.
- `src/app/api/workspace/browser/route.ts` and `docs/architecture/workspace-browser.md`:
  authenticated file/terminal browsing, not an agent browser session. Preserve its URLs and semantics.
- `src/lib/codex/runtime.ts`: server-installed, isolated per-caller runtime manifests;
  runtime/native conversation/tools/persistence and Connect ChatGPT belong exclusively to
  existing owner `01a12dcf-0d00-7390-bb3a-f13e44a24002`. Do not edit that surface without coordination.
  `feature/native-macos-app` is also a separate owner.

## Minimal common contract (freeze before integration)

Type-only definitions live in NEW `src/lib/workspaces/contracts.ts`. Do not place recipes in
`src/sandboxd/templates.ts`. New names use `workspaces` to distinguish templates/instances
from the existing sandbox transport and file-browser helpers.

```ts
type WorkspaceCapabilities = {
  shell: boolean; officeHeadless: boolean; dotnet: boolean; agentBrowserView: boolean;
};
type WorkspaceRecipe = {
  schemaVersion: 1;
  runtimeProfileKey: string; // server-installed allowlist key; never an image/endpoint from a client
  seedBundleKey: string | null; // immutable bundled files; no live user filesystem import
  networkPolicy: "none"; // initial contract; package restore handled at image build time
  capabilities: WorkspaceCapabilities;
};
type WorkspaceTemplateVersion = {
  id: string; templateId: string; version: number; recipe: WorkspaceRecipe;
  recipeHash: string; publishedAt: string | null; retiredAt: string | null;
};
type WorkspaceTemplateSummary = {
  id: string; slug: string; name: string; description: string;
  publishedVersionId: string | null; capabilities: WorkspaceCapabilities;
};
type WorkspaceInstanceView = {
  id: string; templateVersionId: string | null; templateName: string | null;
  origin: "legacy_personal" | "template";
  state: "missing" | "provisioning" | "ready" | "unavailable";
};
// Server-only; never serialized into public DTOs:
type ResolvedWorkspace = {
  instanceId: string; ownerUserId: string; botId: string | null;
  templateVersionId: string | null; sandboxRef: string;
  runtimeProfileKey: string; workspaceRoot: "/home/agent/workspace";
};
```

Tables (common foundation owner creates all schema/migration changes):

- `workspace_templates`: id, unique slug, name, description, created/updated timestamps.
- `workspace_template_versions`: id, template_id FK, positive version, recipe JSON,
  recipe_hash, published_at, retired_at; unique(template_id, version). Published recipes
  are immutable, revisions create a new row. Retirement blocks NEW assignment only.
- `workspace_instances`: id, owner_user_id FK, nullable template_version_id FK,
  origin, unique sandbox_ref, runtime_profile_key, provision_state, last_used_at,
  delete_after, created_at. Instance ownership is immutable. Template pin never silently advances.
- `workspace_bot_bindings`: user_id, bot_id, instance_id, created/updated timestamps;
  unique(user_id, bot_id). The acting user owns the instance even when the bot is shared.
  Enforce same-owner consistency with composite FK or transactional checked write plus
  tests; bot visibility is rechecked at assignment and use, not inferred from bot ownership.

No credentials, cookies, native account identifiers, homes, endpoint URLs, live docs,
browser sessions or runtime tokens in recipes, catalog DTOs, or template seed bundles.
Admin catalog visibility shares recipes only. It grants neither instance access nor tool permissions.

Server service in NEW `src/lib/workspaces/instances.ts`:

```ts
resolveWorkspace({ principal, botId, createIfMissing }): Promise<ResolvedWorkspace | null>
assignTemplate({ principal, botId, templateVersionId }): Promise<WorkspaceInstanceView>
listOwnInstances(principal): Promise<WorkspaceInstanceView[]>
```

`principal` always comes from server authentication, never request JSON. `botId` is a selector
whose access must be checked. Read/view requests use `createIfMissing: false` and never
provision a sandbox. Allocation is concurrency-safe and assignment is transactional/idempotent
for an existing same-version binding. Reassignment creates/reuses an explicitly selected private
instance and retains the previous instance/files; it never overwrites a volume or auto-copies files.

Compatibility: keep `sandboxes` and existing APIs during the additive transition. Register each
existing ref as one `legacy_personal` instance without changing ref, container name, volume name,
timestamps or files. Unbound bots resolve to that legacy personal instance. No automatic per-bot
copy or switch. New template bindings resolve to fresh refs. Legacy callers retain their old
personal workspace until explicit instance selection is integrated. Cleanup must recognize the
UNION of legacy and new refs before template instances are enabled; disabling an account marks
and stops ALL of its instances, re-enable clears retention, and no template retirement destroys data.

Daemon contract: add a server-installed profile allowlist in NEW
`src/sandboxd/profiles.ts`; each profile maps key to pinned image ID/ref and allowed recipe
capabilities. Transport gets optional `runtimeProfileKey` in provision/ensure and exec/file
requests; omission means legacy global `SANDBOXD_IMAGE`. Portal derives key from stored instance.
Daemon pins ref-to-profile, rejects unknown/profile mismatch, and never accepts arbitrary images,
Docker arguments, network overrides, mounts, capabilities or host paths from requests.
Resolve/cache images per profile and include profile/image in drift checks. Existing ref remains
legacy profile; a new assignment gets a new ref. Profiles never raise daemon resource/runtime limits.

## Bounded durable tasks and ownership

Each task gets its own branch based on current main plus accepted common foundation.
Parent assigns one implementation owner per slice; Sol6.1 owns contract/planning/review,
Luna performs bounded implementation. Do not spawn duplicate feature owners.

### W0 — common foundation (Sol6.1, review gate)

Branch: `feature/workspace-contract-foundation`.
Own: `src/lib/workspaces/contracts.ts`, `src/db/schema.ts`, NEW migration under
`src/db/migrations/` and associated `meta/` files, NEW
`tests/integration/workspace-instance-migration.test.ts`.
Freeze DTO/service shapes and add tables only, additive legacy registration, constraints and
idempotent migration tests. Do not rename/drop `sandboxes`. Coordinate migration numbering with
Codex runtime owner: current journal ends at 0053; reserve/generate next numbers serially during
integration, never let independent workers overwrite journal/snapshots. Parent owns final schema
integration and shared package/lockfile changes. W1/W2 consume schema, do not regenerate migrations.

### W1 — recipe catalog/admin (Luna bounded implementation, Sol6.1 review)

Branch: `feature/workspace-template-catalog`.
Own NEW: `src/lib/workspaces/catalog.ts`, `src/lib/workspaces/catalog-policy.ts`,
`src/components/admin/workspace-template-catalog.tsx`,
`src/app/admin/workspace-templates/page.tsx`, `src/app/admin/workspace-templates/actions.ts`,
`src/app/api/workspace/templates/route.ts`, `tests/unit/workspace-template-catalog.test.ts`,
`tests/browser/workspace-template-catalog.mjs`.
Small coordinated patch: `src/components/admin/admin-nav.tsx` only.
Interfaces: `GET /api/workspace/templates` returns visible published summaries and pinned
version IDs; admin actions create draft/version, publish internally to catalog, retire.
Public recipe selection means visible within authorized CollectiveUI audience, never Internet publication.
Display prebuilt Office template EXACTLY **Knowledge Work** (slug `knowledge-work`).
No Docker builds, live-file sharing, assignment, runtime credentials or bot policy modifications.
Dependency: W0 schema; may develop mocked catalog/UI independently of W2/W3.
Tests: admin mutation rejection for ordinary users, unpublished/retired filtering, immutable
published recipes, hash/version stability, capability allowlist, no secret/live-path fields.

### W2 — provisioning/private bot binding (Luna substeps, Sol6.1 isolation/migration review)

Branch: `feature/workspace-private-instances`.
Own NEW: `src/lib/workspaces/instances.ts`, `src/lib/workspaces/instance-policy.ts`,
`src/app/api/workspace/instances/route.ts`, `src/app/api/workspace/bindings/route.ts`,
`src/components/settings/workspace-template-picker.tsx`, `src/sandboxd/profiles.ts`,
`tests/unit/workspace-instances.test.ts`, `tests/integration/workspace-bindings.test.ts`.
Own EXISTING: `src/lib/sandbox/store.ts`, `lifecycle.ts`, `view.ts`, `session.ts`, `client.ts`,
`src/sandboxd/config.ts`, `manager.ts`, `spec.ts`, `server.ts`, `protocol/types.ts`,
`src/lib/agent/toolset.ts`, `src/components/settings/workspace-panel.tsx`,
`src/app/(chat)/settings/workspace-actions.ts`, `src/app/admin/sandboxes/page.tsx`,
`src/components/admin/sandbox-admin.tsx`; update current workspace file/upload/terminal route
resolution only in a separate bounded follow-up if instance selection is added there.
POST binding body: `{ botId, templateVersionId }`; response `{ instance: WorkspaceInstanceView }`.
GET instances lists own DTOs only. Never accept owner/ref/profile/image from request JSON.
Break into reviewable commits: registry/legacy adapter; daemon profiles; binding/picker;
lifecycle/cleanup/tool resolution. Cleanup union lands BEFORE new instance allocation is enabled.
Dependencies: W0 and catalog publish contract; profiles consume W3 artifacts. No native Codex
runtime implementation. Its owner consumes `ResolvedWorkspace` via a server-only adapter and
must explicitly verify same physical execution workspace before claiming shared documents.
Tests: two users same bot have different refs/volumes; two bound bots for one user isolated;
concurrent assignment stable; inaccessible bot/other-user instance rejected; no image injection;
legacy files/ref survive migration/restart; unavailable image leaves prior binding intact;
disabled retention, orphan cleanup union, stop/reset targeted to selected own instance;
existing sandbox-policy/spec/capacity/protocol/workspace permission regression tests pass.

### W3 — prebuilt starter images (Luna bounded implementation, Sol6.1 review)

Branch: `feature/workspace-starter-images`.
Own NEW: `docker/workspace-templates/knowledge-work/Dockerfile`,
`docker/workspace-templates/dotnet-linux/Dockerfile`,
`docker/workspace-templates/dotnet-linux/starter/`,
`docker/workspace-templates/manifest.json`, `scripts/build-workspace-template-images.sh`,
`docs/architecture/workspace-starter-images.md`, `tests/sandbox/workspace-starter-images.test.ts`.
Keep existing `docker/sandbox/Dockerfile` and build command backwards compatible; NEW images
reuse existing helpers through repository-root build context. Manifest describes recipe seeds,
profile keys, capabilities and immutable image references; W1 imports catalog seed definitions,
W2 handles server profile admission. Do not silently modify compose/deployment/security config.
Knowledge Work retains tested headless Office conversion. Set `agentBrowserView: false` unless
actual runtime capture support is independently proven; no claim of GUI capability.
.NET Linux: pin a supported Linux SDK/base digest (verify current Microsoft support before
choosing exact version), ship a small console starter and locked package graph. Image build has
explicit restore network access; `dotnet restore --locked-mode` happens at build time against
declared feeds with no credentials. Seed pre-restored dependencies to persistent home on first
initialization without overwriting existing files. Runtime stays `networkPolicy: none`; prove
`dotnet build --no-restore` and `dotnet run --no-restore` from a fresh instance offline. Additional
NuGet packages need a new prebuilt template version; runtime network restore is a separate future
policy change. Document cold-cache/offline limitations, Linux-only capabilities, and SDK version.
Tests: image helper permissions/uid, Office conversion, SDK version, actual offline starter
build/run in read-only-rootfs sandbox, fresh-volume initialization, restart persistence,
image missing fails clearly. Use isolated temporary test refs; no production daemon credentials.
Dependency: contract only; safest fully independent task. Builds are optional when Docker unavailable,
with precise untested evidence reported rather than a simulated success.

### W4 — actual private agent browser runtime/tools (separate bounded owner)

Branch: `feature/agent-browser-runtime`.
Own NEW: `src/lib/agent-browser/provider-contract.ts`, `provider.ts`, `sessions.ts`,
`src/lib/agent/tools/agent-browser.ts`, `src/agent-browserd/` (broker/transport),
`docker/agent-browser/Dockerfile`, `tests/unit/agent-browser-provider.test.ts`,
`tests/sandbox/agent-browser-runtime.test.ts`.
Parent owns the small tool registration patch in `src/lib/agent/toolset.ts` to avoid W2 conflict,
root package/lockfile integration and shared contract changes. Provider owner coordinates
`session-source.ts` with W5; W5 owns viewer adapter/DTO, W4 owns actual source registration.

Discovery is now confirmed: native runtime has stateless search/fetch, Hermes is external,
Codex pilot is text-only, sandboxd supplies commands/files. An actual private browser session is
an engineering prerequisite to implement, not a reason to stop the overall feature.

Implement in bounded steps: (a) isolated browser process/container and session lifecycle,
(b) native agent tools against that exact page, (c) bounded same-page frame publication.
One browser container/process per private workspace instance/owner; no shared user profile or
fallback to another person's session. Browser profile persists privately where explicitly intended;
frames are ephemeral. Binding uses `workspaceInstanceId` when present, otherwise an explicit
server-owned per-user browser instance, never an accidental global browser. Keep browser runtime
separate from no-network sandboxd until reviewed integration policy exists. Do not edit existing
SANDBOXD network/security configuration or deploy anything live. Browser outbound network needs
an explicit application network policy: block localhost/private/link-local/metadata destinations,
handle redirects and DNS rebinding, and never expose host/CDP ports publicly. Review broker and
network isolation before enabling the tools. A browser container can access allowed public sites;
this does not authorize general shell/NuGet egress in the user's command sandbox.

```ts
type BrowserScope = { ownerUserId: string; botId: string; runId: string;
  workspaceInstanceId: string | null };
interface AgentBrowserProvider {
  // Server-created scopes after user/bot/run admission; not raw client claims.
  open(scope: BrowserScope): Promise<{ sessionId: string }>;
  navigate(sessionId: string, url: string): Promise<{ title: string }>;
  inspect(sessionId: string): Promise<{ text: string; /* bounded element refs */ }>;
  act(sessionId: string, action: /* validated click/type/scroll using element refs */ unknown): Promise<void>;
  subscribeFrames(sessionId: string, signal: AbortSignal): AsyncIterable<{
    sequence: number; capturedAt: string; contentType: "image/jpeg";
    bytes: Uint8Array; width: number; height: number;
  }>;
  status(sessionId: string): Promise<"active" | "idle" | "disconnected">;
  close(sessionId: string): Promise<void>;
}
```

Replace the illustrative `unknown` action with a strict discriminated union in W4's first contract
commit; fixed native actions only, no eval/script, shell, arbitrary filesystem, debugger endpoint,
headers/cookies/credentials or proxy configuration from a bot/tool argument. Tools derive scope
from the authenticated run and enforce existing workspace/tool permission admission. Viewing does
not grant tool execution. Agent navigation/click/type is allowed by the agent's admitted tools;
viewer has no action endpoint. Surface bounded sanitized page text/element refs to the agent and
subscribe to screencast/screenshots of the SAME page/context. Frame production must not create
a replacement page/context. Authenticated internal broker requests use server-controlled bindings;
credentials remain runtime-owned, outside template/catalog and UI contracts.

Tests prove agent navigate/click changes the exact frame source; two owners get separate
processes/profiles/pages; spoofed session/run/owner denied; blocked network targets/redirects;
idle/disconnect/restart cleanup; per-owner resource caps and bounded frames. Docker unavailable
is an explicit execution-test limitation, not permission to show synthetic live frames. Starter
Knowledge Work capability stays false until provider admission proves actual availability.
Dependencies: shared BrowserScope/source contract with W5, W0/W2 only for instance adapter.
Can implement provider tests and broker with synthetic local test pages independently of W1/W3.
No edits to external Hermes or Codex-owned runtime without its existing owner's agreement.

### W5 — actual agent browser viewer (EXISTING new owner; do not duplicate)

Suggested branch: `feature/agent-browser-viewer` (parent's discovery/implementation owner).
Exclusive NEW paths: `src/lib/agent-browser/contracts.ts`, `session-source.ts`, `viewer.ts`,
`src/app/api/agent-browser/status/route.ts`, `src/app/api/agent-browser/stream/route.ts`,
`src/components/chat/agent-browser-viewer.tsx`, its CSS and dedicated unit/browser tests.
Coordinate a small `src/components/chat/` header mount with parent; do not take ownership of
existing `workspace-browser.tsx` or `/api/workspace/browser`, and do not edit W2 daemon paths.
Discovery must identify an actual agent browser/tool transport. Current inspected sandbox paths
provide no such source. If none exists, report the missing adapter; do not launch an unrelated
browser and label it the agent's session. Fixtures are acceptable tests, never product live content.

```ts
type AgentBrowserStatus = {
  state: "active" | "idle" | "disconnected";
  viewOnly: true;
  lastFrameAt: string | null;
};
// Internal adapter; register only from the runtime/browser owner after server authorization:
type BrowserSessionSource = {
  ownerUserId: string; botId: string; runId: string;
  workspaceInstanceId: string | null; sessionId: string;
  // opaque internal subscription to the SAME browser context/page the agent uses
};
```

Status/stream selectors may use authorized `botId`/`runId`; owner and source are resolved server-side.
No browser-supplied CDP/WebSocket endpoint, container ref, cookie or arbitrary URL. Transport can
be bounded frames over existing compatible streaming facilities; owner chooses encoding after
discovery. Freeze status shape now, capture adapter shape with W4 after its first provider contract commit.
Authenticate each connection, authorize run ownership, private/no-store, cap frame size/rate and
subscribers, close on revoke/expiry/disconnect. Viewer opening cannot start a run/browser. Viewer
disconnect cannot stop an agent run. No keyboard, mouse, remote input, navigation controls or
control lease needed in this initial view-only slice. Stale capture must show disconnected,
never imply an old frame is live. Idle means the same session is still attached but agent inactive.
Tests: actual agent navigation produces viewer frame from same context/session; other user/run
cannot subscribe; unauthenticated/expired access rejected; stale frames/disconnect/reconnect,
bounded stream cleanup, no credentials/endpoints in DTOs, no input channel, no run cancellation
on viewer close. If no actual source exists, that same-session test remains an explicit blocker.
Dependencies: build status/UI independently against W4 source contract; live integration waits for
W4 actual browser/tools/frame proof. Coordinate native runtime adapters with their owners, including
Codex owner; do not assume template sandbox equals native runtime browser.

## Integration order and release evidence

1. Parent/Sol6.1 accepts W0 contract/schema; serialize shared migration numbering and metadata.
2. Run W1, W3, W4 browser provider and existing W5 viewer consumer independently. W2 starts against frozen W0 types/schema.
3. Review W2 cleanup/legacy preservation and allowlisted profile transport before enabling allocation.
4. Integrate W3 pinned profiles/seeds and W1 internal publication; test assignment end-to-end locally.
5. Browser provider W4 proves same-page agent tool/frame behavior; W5 connects the consumer.
   Native runtime owner explicitly consumes instance adapter and viewer source without moving credentials
   into templates. No claim that app-server-native tools already run inside sandboxd.
6. Run relevant existing unit tests, new integration migration/ownership tests, typecheck/lint,
   sandbox tests only against isolated test infrastructure, and browser fixtures for accessibility.
   Integration proof: Knowledge Work selected for user A/bot X, private instance allocated,
   files persist through stop/restart, user B denied; .NET starter builds offline; real agent browser
   activity reaches only the authorized viewer. Report unavailable Docker/source adapters clearly.

Shared file conflicts are resolved by parent integration commits, never by independent owners
editing schema, journals, package files, runtime owner files, or native macOS code concurrently.
