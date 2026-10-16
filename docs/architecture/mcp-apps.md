# Native MCP Apps widgets

Native web chats can render bundled MCP UI resources through the official `@modelcontextprotocol/ext-apps` **AppBridge** (pinned to 2.0.3). Codex and Hermes execution adapters are unchanged. This is a bounded host implementation, not a claim of full ChatGPT or Apps SDK compatibility. Swift/iOS/macOS transcript views do not gain a widget renderer in this change.

## Enablement

This change supplies code and a migration; it does not alter a running installation, credentials, grants, or authentication settings.

1. Apply migration `0066_mcp_apps` through the normal deployment process.
2. Serve `scripts/mcp-app-sandbox.mjs` on a **dedicated, cookieless origin**, distinct from `AUTH_URL`. Do not serve CollectiveUI, an authenticated proxy, or any other application on that origin. Preserve its HTTP CSP and Permissions-Policy headers. Production must use HTTPS. Only loopback may use HTTP.
3. Set `MCP_APPS_HOST_ORIGIN` to the CollectiveUI origin for that separate sandbox process. It listens on `127.0.0.1:3102` by default; `MCP_APPS_SANDBOX_HOST` and `MCP_APPS_SANDBOX_PORT` control the listener behind a reverse proxy.
4. Set `MCP_APPS_SANDBOX_URL` on the application **and worker** to the complete sandbox URL, ending in `/sandbox`. No query, fragment, user info, or same-origin URL is accepted.
5. Test/refresh an MCP server and review/accept any tool snapshot drift through the existing admin workflow. The catalog refresh advertises MCP Apps support. Previously discarded descriptors are not silently trusted.

Example local **synthetic development only** configuration (not applied by this PR):

```sh
MCP_APPS_HOST_ORIGIN=http://127.0.0.1:3000 npm run mcp-app-sandbox
# In the application and worker configuration:
# MCP_APPS_SANDBOX_URL=http://127.0.0.1:3102/sandbox
```

Without a valid separate sandbox URL, tools continue returning bounded text/structured results. Old messages cannot recover previously discarded widget metadata; make a new tool call after enablement.

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
```

The service suite uses production authorization/approval code with PGlite, all migrations and a synthetic MCP client. It covers descriptor drift, resource substitution/MIME/size errors, metadata isolation (including missing-tool replay), approval policy, exact-input idempotency, concurrent decisions, reload and revocation. Browser tests use the production React host, AppBridge, the official `App` view SDK, the actual standalone sandbox, and a clearly synthetic HTTP backend. They cover forms/tables/buttons, private data confined to the inner frame, approvals, reload, network isolation, spoofed messages, error fallback and OpenAI compatibility. Browser fixtures deliberately do not test real accounts or claim live server interoperability. CI installs an isolated Chromium browser for this suite.

Protocol references: [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [official host example](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host), [OpenAI UI compatibility reference](https://developers.openai.com/plugins/build/chatgpt-ui).
