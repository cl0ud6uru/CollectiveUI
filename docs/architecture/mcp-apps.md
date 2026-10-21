# Native MCP Apps widgets

Native web chats can render bundled MCP UI resources through the official `@modelcontextprotocol/ext-apps` **AppBridge** (pinned to 2.0.3). Codex and Hermes execution adapters are unchanged. This is a bounded host implementation, not a claim of full ChatGPT or Apps SDK compatibility. Swift/iOS/macOS transcript views do not gain a widget renderer in this change.

## Enablement

This change supplies code and a migration; it does not alter a running installation, credentials, grants, or authentication settings.

1. Apply migration `0066_mcp_apps` through the normal deployment process.
2. Serve `scripts/mcp-app-sandbox.mjs` on a **dedicated, cookieless origin**, distinct from `AUTH_URL`. Do not serve CollectiveUI, an authenticated proxy, or any other application on that origin. Preserve its HTTP CSP and Permissions-Policy headers. Production must use HTTPS. Only loopback may use HTTP.
3. Set `MCP_APPS_HOST_ORIGIN` to the CollectiveUI origin for that separate sandbox process. It listens on `127.0.0.1:3102` by default; `MCP_APPS_SANDBOX_HOST` and `MCP_APPS_SANDBOX_PORT` control the listener behind a reverse proxy.
4. Set `MCP_APPS_SANDBOX_URL` on the application **and worker** to the complete sandbox URL with the exact pathname `/sandbox`. Other paths (including prefixes or a trailing slash), query, fragment, user info, and same-origin URLs are rejected.
5. Test/refresh an MCP server and review/accept any tool snapshot drift through the existing admin workflow. The catalog refresh advertises MCP Apps support. Previously discarded descriptors are not silently trusted.

Example local **synthetic development only** configuration (not applied by this PR):

```sh
MCP_APPS_HOST_ORIGIN=http://127.0.0.1:3000 npm run mcp-app-sandbox
# In the application and worker configuration:
# MCP_APPS_SANDBOX_URL=http://127.0.0.1:3102/sandbox
```

Without a valid separate sandbox URL, tools continue returning bounded text/structured results with an actionable diagnostic when their accepted descriptor advertises a widget. Diagnostics never include configured URL values, credentials, raw resource errors or private component metadata. Admin → MCP servers reports the web process's configuration issue; it cannot prove worker configuration or sandbox reachability. Old messages cannot recover previously discarded widget metadata; make a new tool call after enablement.

## Docker setup and upgrades

Both Compose files include an optional `mcp-app-sandbox` service in the **`mcp-apps` profile**. It is separate from workspace `sandboxd` and Docker Hermes. Source builds use the minimal `mcp-app-sandbox` Dockerfile target (Node plus the standalone script, no npm dependencies). Image deployments reuse the release's **same immutable worker image**, overriding its command and healthcheck; that image must include `scripts/mcp-app-sandbox.mjs` from this repair. An older worker image cannot run the profile. No third image tag or release manifest change is required.

The service has a read-only filesystem, non-root UID, dropped capabilities, process/memory/CPU limits, its own network, no volumes, no Docker socket, and **no `env_file`**. Only the parent origin and listener settings are forwarded from operator configuration. Never add the application's `.env`, database/provider credentials, authentication middleware or application routes to it. Its host port binds only to `127.0.0.1`; the container listener is `0.0.0.0:3102`. For a proxy in another container, arrange a private, explicit proxy-to-sandbox network in an operator-reviewed override; `127.0.0.1` inside that proxy container is not the Docker host. Do not publish this HTTP port to the LAN or Internet as a workaround.

An administrator must first identify the **work installation's** revision, image references, Compose project/directory, persistent volumes, proxy and bot harness. A working ChatGPT widget establishes server support in that host; it does not establish matching credentials, accepted descriptors or supported APIs in CollectiveUI. This path supports direct native web bot chats. Swift clients, Hermes/Codex harnesses, groups and background/delegated runs do not gain a widget renderer.

1. Back up the existing database, uploads, runtime `.env` and encryption/session keys as a consistent set using the [upgrade procedure](../operations.md#updates-migrations-and-backups). Preserve the actual Compose project name and volume identities. Stop web **and** worker before migration, and apply all bundled migrations including `0066_mcp_apps` using the normal runner. Do not reset the schema/journal or use `down -v`. This repair adds no new migration. Update web and worker together to a reviewed revision containing this repair.
2. Allocate a **dedicated HTTPS origin** for widgets, with a valid certificate trusted by users' browsers. Use a different registrable domain if the portal/SSO uses parent-domain cookies; a sibling hostname can still receive those cookies. No service on the widget origin may set cookies. Do not place an authenticated ingress/SSO gateway on it. No application/authentication routes may be reachable there.
3. Add these non-secret settings to the installation's protected `.env` (replace the example domains):

   ```dotenv
   # Existing canonical portal origin:
   AUTH_URL=https://ai.corp.example.com
   # Explicit, identical in web AND worker:
   MCP_APPS_SANDBOX_URL=https://widgets.example.net/sandbox
   # Exact parent origin, consumed only by the sandbox:
   MCP_APPS_HOST_ORIGIN=https://ai.corp.example.com
   # Optional host port; the container port remains 3102:
   MCP_APPS_SANDBOX_PORT=3102
   ```

   Keep `MCP_APPS_HOST_ORIGIN` equal to the portal's `AUTH_URL` origin. Both reject credentials, paths, queries and fragments; non-loopback HTTP is rejected. The sandbox URL requires the exact `/sandbox` path and a distinct origin. Neither `http://mcp-app-sandbox:3102/sandbox` nor a same-origin `/sandbox` route is a valid public URL.
4. Build/pull reviewed images and validate quietly before starting the optional service. These are **administrator-run examples**, not commands executed against an installation by this change. Use the installation's existing `-p` project option on every command when it differs from the directory default.

   Source build, after the normal backup and stopped-writer upgrade steps:

   ```sh
   docker compose --profile mcp-apps config --quiet
   bash scripts/build-images.sh web worker mcp-app-sandbox
   docker compose run --rm --no-deps worker npm run db:migrate
   docker compose --profile mcp-apps up -d --wait mcp-app-sandbox worker web
   ```

   Image deployment, with `COLLECTIVEUI_WEB_IMAGE` and `COLLECTIVEUI_WORKER_IMAGE` already set to the reviewed release's immutable references, and the existing database running:

   ```sh
   docker compose -f docker-compose.release.yml --profile mcp-apps config --quiet
   docker compose -f docker-compose.release.yml pull web worker
   docker compose -f docker-compose.release.yml --profile maintenance run --rm --no-deps migrate
   docker compose -f docker-compose.release.yml --profile mcp-apps up -d --no-build --wait mcp-app-sandbox worker web
   ```

   **Managed release updater:** its recorded `.env`/Compose fingerprints intentionally block unreviewed configuration changes. Enabling widgets or replacing the Compose file is a separate manual configuration reconciliation; plan it with the operator before editing those files. Do not delete/edit updater identity or journals to force an update through. Follow the [manual transition and recovery guidance](../docker-hub-deployment.md); an existing recorded installation needs an explicit operator recovery/update plan. The updater manages the core image pair only, so explicitly recreate and health-check the optional sandbox against the new worker reference after each image upgrade. Keep profiles out of the global `COMPOSE_PROFILES` setting for updater runs; use `--profile mcp-apps` for the manual sidecar command.
5. Route only `https://widgets.example.net/sandbox` to `http://127.0.0.1:3102/sandbox` with a host TLS proxy. Preserve the upstream **CSP**, Permissions-Policy, no-store and no-referrer headers. Do not inject scripts or relax any CSP directive for CDN/network requests. A minimal Nginx location inside a dedicated TLS virtual host is:

   ```nginx
   # server_name widgets.example.net; configure listen 443 ssl and certificates normally.
   # Disable inherited auth on this dedicated virtual host; never route portal paths here.
   location = /sandbox {
       auth_basic off;
       auth_request off;
       proxy_pass http://127.0.0.1:3102;
       proxy_set_header Cookie "";
       proxy_set_header Authorization "";
       proxy_hide_header Set-Cookie;
   }
   location / { return 404; }
   ```

   Review inherited/global proxy rules as well. Stripping upstream Cookie is defense in depth, not a substitute for a cookieless browser origin. Do not replace the sandbox's headers with the portal's `X-Frame-Options: SAMEORIGIN` or a conflicting `frame-ancestors`; that blocks the intended cross-origin frame. Do not disable framing policy wholesale.
6. Check service health and use a **credential-free GET** to the public `/sandbox` from a browser/network that represents users. Expect 200, no `Set-Cookie`, `Cache-Control: no-store`, `connect-src 'none'`, `frame-ancestors` naming the exact portal origin, and the documented Permissions-Policy. `/`, `/api/auth/session` and `/sandbox/` must return 404. Inspect browser requests to ensure no portal/SSO cookies reach the widget origin. Health checks only test the internal listener; DNS/TLS/proxy correctness still needs external verification. Avoid printing full `docker compose config`, container environments or credential-bearing URLs in shared logs.
7. In **Admin → MCP servers**, open the Ticket Tracker server and choose **Test saved server**. This uses `initialize`/`tools/list`, not ticket submission. Review/accept pending changes, including routing/visibility metadata, through the normal admin workflow. The editor shows the count of accepted widget descriptors and marks advertised tools with a widget badge. Old snapshots may contain no metadata at all; that cannot be distinguished reliably from a text-only server without refreshing. Do not infer widget support from model narration or result metadata and do not auto-accept drift. Re-review grants and republish affected service bots because metadata participates in definition hashes.
8. Verify the bot uses the native harness and that its accepted `draft_ticket` descriptor contains a supported `ui://` URI. In an isolated test environment, make a fresh **draft-only** invocation and verify initial rendering, form fields, edits, reload and permissions independently of submission. Never use Create ticket as a rendering check. Use the synthetic fixture below before any work-service verification. Actual credentials, `resources/read` availability, MIME type, bundled assets and API compatibility must still be verified for that server. A passing local suite is not proof that a work instance is fixed.

To disable widgets, clear `MCP_APPS_SANDBOX_URL` on **both** web and worker, recreate those services through the same reviewed configuration process, and stop `mcp-app-sandbox`. Merely omitting the profile does not stop an already running service. Preserve database/volumes and coordinate any application rollback with migration compatibility; never run an older worker against a newer policy schema without the documented recovery process.

### Troubleshooting missing frames

| Evidence | Next check |
| --- | --- |
| Tool result says `MCP_APPS_SANDBOX_URL` is absent/invalid | Configure the distinct HTTPS `/sandbox` URL on both processes and recreate them; values are intentionally not echoed. |
| Admin reports valid configuration but new results still report it missing | Admin checks web only. Check worker configuration and whether the new worker image is actually running. |
| No diagnostic and no frame despite text saying “widget ready” | Verify native/direct scope and inspect the **accepted descriptor**, refresh metadata and review drift. Result metadata/narration cannot enable a widget. |
| Resource/storage diagnostic | Confirm migration 0066, accepted URI, one supported HTML resource, size limits and server authorization. Raw provider/credential errors are deliberately withheld. |
| Frame loads but initialization times out | Check public DNS/TLS/proxy, exact parent origin, CSP/Permissions-Policy and conflicting frame headers. No same-origin or CSP bypass. |
| Widget needs CDNs, remote API fetches or broader ChatGPT APIs | Those capabilities are outside this host's supported boundary. Bundle required assets or pursue separately reviewed compatibility work. |

## Accepted descriptors and resources

- Preferred: `_meta.ui.resourceUri` with a `ui://` URI. Deprecated `_meta["ui/resourceUri"]` is also supported.
- `_meta.ui.visibility` supports `model` and `app`; omitted means both. App-only tools stay out of the native model toolset. Malformed routing/visibility fields reject the descriptor rather than accidentally exposing an app-only tool.
- Bounded OpenAI compatibility: `_meta["openai/outputTemplate"]` with a `ui://` URI and `text/html+skybridge`. Every callable target tool must explicitly set `_meta["openai/widgetAccessible"]: true` for this compatibility mode. Standard MCP metadata takes precedence when both are present.
- Only these routing/visibility/accessibility metadata fields survive catalog normalization. They participate in snapshot hashes, drift review, and service grant hashes. Unknown metadata is discarded.
- Resource loading calls `resources/read` on the **same authorized MCP connection**, using only the accepted descriptor URI. Result metadata cannot redirect it. Exactly one matching resource with `text/html;profile=mcp-app` is accepted (or the legacy MIME above in compatibility mode). UTF-8 text and base64 HTML are supported, up to 1 MiB after decoding.
- The HTML is pinned to that invocation and SHA-256 checked on restore. Reload restores the pinned document and result; it neither rereads a mutable resource nor repeats the original tool call. A new invocation may fetch a new document. This does not introduce a separate admin review of HTML contents.

## Data and authorization boundaries

`content` and `structuredContent` are model-visible; native MCP keeps both within the server's result budget, capped at 256 KiB for this path. Component-only result `_meta` has a separate 64 KiB cap and is stored in the encrypted `mcp_app_instances.payload_enc`, alongside the pinned document. It is never included in message parts, model history, search text, shared transcript data, or tool audit output. The transcript carries only a widget instance reference plus model-visible results; the reference is removed on model conversion/replay, including when the original tool definition is no longer available. Credential echo redaction runs before storage or delivery. These are post-parse bounds, not transport or peak-memory guarantees.

Widgets are restricted to the owning user's direct, non-archived, native bot chat. They are not rendered in shared/read-only transcripts, groups, delegated/background work, Team/Hermes adapters, or Codex harnesses. Instances expire for access after 24 hours. Encrypted rows remain until their conversation/user/bot/server is deleted (cascade); expiry is not a scheduled erasure policy.

Every load, poll, request and approval rechecks ownership, account/session, bot/app availability, configured tool selection, server availability/access, descriptor hash, service publication and the existing authority binding. Changing permissions or configuration invalidates the instance. Widget tools use the existing MCP execution wrapper, schema validation, per-tool approval overrides, trusted Smart annotations, organization enforcement, service grants and scope constraints. Identity is freshly authorized before every widget MCP transport request; credentials remain server-side, restricted to the server's own origin with redirects rejected. Per-call service identities retain the exact grant, tool and call attribution. Returned private metadata is withheld if permission changes during a call.

Approvals appear in host UI outside the sandbox and cover one immutable tool/input pair. Widgets cannot call an approval endpoint through AppBridge. Pending approvals survive reload; approve/deny is an atomic transition. Request IDs bind instance, tool and input, so retries return the recorded outcome and never repeat a running, completed, failed or denied dispatch. An interrupted `running` request remains uncertain and is never automatically retried. There are at most 100 requests per instance and 32,000 serialized bytes of arguments per request. Existing name-based enforced/remembered approvals use the native cross-server tool aliases; app-only actions cannot inherit a remembered model-tool grant. Unsnapshotted configured MCP servers must be reviewed before widget actions can safely resolve those aliases.

## Sandbox and lifecycle

The official AppBridge talks only to its particular proxy iframe; the host also checks that iframe's origin. The separate proxy relays only its exact parent origin/window and the opaque inner frame/window. The inner frame uses `allow-scripts allow-forms`, without same-origin, navigation, popups or download privileges. Its HTTP-inherited CSP cannot be relaxed by widget HTML. The host supports initialization, complete tool input/result delivery, bounded size updates, theme/container changes, inline display requests, request-close, and resource teardown. Explicit reload waits for teardown acknowledgement (up to 500 ms); React unmount sends a best-effort teardown request before removing the frame. A permission failure removes the frame immediately. Access polling runs every 20 seconds while mounted; each action still reauthorizes synchronously. Revocation cannot retract data already displayed to an authorized user.

## Exact limits

| Capability | This host |
| --- | --- |
| Standard MCP Apps | Bundled HTML/JS/CSS, forms, tables, buttons, and authorized `tools/call` |
| Network and CSP domains | All connections and external assets denied, including requested `connectDomains`, `resourceDomains`, `frameDomains`, and base URI allowances |
| Images/fonts | Inline data/blob images and data fonts only |
| Browser/device permissions | Camera, microphone, location, clipboard, payment, fullscreen, USB and serial denied |
| Resource browsing, subscriptions, prompts, sampling | Not advertised or forwarded |
| UI model context, follow-up messages, external links, downloads | Not advertised or forwarded; widget actions do not create model turns or add private results to model history |
| Display | Inline only; requested height clamped to 120–800 px |
| Loading | Completed successful native tool results only; no speculative/partial-input widget rendering; 15-second initialization timeout |
| OpenAI globals | `toolInput`, structured `toolOutput`, private `toolResponseMetadata`, `theme`, `locale`, `displayMode`, `maxHeight` |
| OpenAI methods | Authorized `callTool`, iframe-local `setWidgetState`, inline `requestDisplayMode`, `notifyIntrinsicHeight`, `requestClose` |
| OpenAI unsupported | Follow-up messages, external navigation, modal, uploads/download URLs, fullscreen/PiP and other ChatGPT-only facilities; implemented stubs reject clearly |
| Widget state and reload | `setWidgetState` lasts only for that iframe; no persistent ChatGPT state semantics. Pending host approvals remain visible after reload. Approval completion after reload is reported in host UI; the old iframe's pending RPC is not replayed into a new one. |

Servers that rely on external bundles/CDNs, WebSockets, live subscriptions, OAuth inside a widget, or broader ChatGPT APIs require further reviewed work. This PR does not enable them, reconfigure servers, or modify credential custody.

## Verification

All fixtures are invented and use no live MCP server or private work data.

```sh
npm test -- --project unit tests/unit/mcp-apps.test.ts
npm run typecheck
npm run lint
npm run test:mcp-apps:browser
# Compose validation is daemon-free and uses only invented configuration:
node tests/docker/mcp-apps-compose.mjs
# With an available local/CI Docker daemon (disposable containers only):
docker build --target mcp-app-sandbox -t collectiveui-mcp-app-sandbox:test .
docker build --target worker -t collectiveui-worker:test .
bash tests/docker/mcp-apps-smoke.sh
```

The service suite uses production authorization/approval code with PGlite, all migrations and a synthetic MCP client. It covers descriptor drift (including upgrading snapshots that discarded metadata), resource substitution/MIME/size errors, metadata isolation (including missing-tool replay), approval policy, exact-input idempotency, concurrent decisions, reload and revocation. Browser tests use the production React host, AppBridge, the official `App` view SDK, the actual standalone sandbox, and a clearly synthetic HTTP backend. They cover forms/tables/buttons, private data confined to the inner frame, approvals, reload, network isolation, spoofed messages, error fallback and OpenAI compatibility. The invented Ticket Tracker fixture includes summary, multiline description, reporter, location/scope selects and an attachment checkbox. Preview edits stay in the iframe; its Create ticket button is disabled, and tests assert zero tool calls/actions. Browser fixtures deliberately do not test real accounts or claim live server interoperability. CI installs an isolated Chromium browser for this suite. Docker CI validates opt-in Compose configuration and smoke-tests the minimal target plus the release worker-image command with no credentials, published ports or live services.

Protocol references: [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [official host example](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host), [OpenAI UI compatibility reference](https://developers.openai.com/plugins/build/chatgpt-ui).
