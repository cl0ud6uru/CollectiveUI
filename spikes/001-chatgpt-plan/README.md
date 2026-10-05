# 001 — Sign in with ChatGPT plan-use compatibility spike

## Verdict: PARTIAL

**Offline fixtures pass; live unauthenticated OIDC discovery succeeds. Real registration, account entitlement, and Responses inference have not been tested.** No browser sign-in was initiated and no Hermes/Codex credentials were read or reused. This is a disposable standalone Node 22 ESM package, not a production integration or deployment.

### Feasibility question

Given an eligible locally hosted open-source app and an operator-authorized ChatGPT account, can dynamic registration issue credentials with `chatgpt.tokens.use.direct`, list that account's supported models, and produce exactly `CHATGPT_PLAN_OK` through the public HTTP Responses SSE API?

## Prerequisites and eligibility

- Node **22+**, npm, and outbound HTTPS to `auth.openai.com` and `api.openai.com`.
- An operator's eligible ChatGPT account and explicit browser consent granting plan-use permission.
- The official documentation describes **open-source and locally hosted apps**. Paid or remotely hosted applications must use the [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/); these docs are not blanket authorization for a hosted CollectiveUI service.
- This package is isolated from production `src`, the root package, environment files, and existing CLI credentials. It never loads `.env`.
- Only `jose` is needed, pinned to **6.2.12** with npm lockfile integrity. Its version was checked against the npm registry.

## Run

```sh
cd /home/hermes/collectiveui-codex-spike/spikes/001-chatgpt-plan
npm ci --ignore-scripts --no-audit --no-fund
npm test
node cli.mjs --help
node cli.mjs discover
```

`discover` is public and unauthenticated; it starts no listener and reads no credentials. All tests use local HTTP fixtures and ephemeral synthetic keys/tokens, never live signup or inference. Tests put temporary files under `TMPDIR`; on a plain shell, set it to an existing private scratch directory if it is not already set.

### Operator-only live test — NOT RUN by this spike

```sh
node cli.mjs auth
node cli.mjs models
node cli.mjs probe --model <exact-account-visible-slug>
```

`auth` explicitly starts an IPv4-loopback listener, chooses an available port, prints a **Continue with ChatGPT** URL, and waits up to three minutes. Open that URL yourself in your browser. It does not launch a browser. It never prints credential values, ID-token hints, provider error bodies, or streamed partial output. Only a successfully completed response containing the exact marker is probe success. HTTP/SSE transport is covered here; WebSocket compatibility is not implemented or claimed.

For a remote shell, run auth with `--ssh-target user@host` for optional tunnel guidance, then run the displayed `ssh -N -L PORT:127.0.0.1:PORT user@host` command on the browser machine **before** opening the URL. A fixed `--port 1455` is available if required. Do not expose the listener publicly or substitute `localhost` in the callback URL.

### Credential location and lifecycle

Default: `~/.config/collectiveui-spike/account.json`. Override every account-dependent command consistently:

```sh
node cli.mjs auth --credential-file "$HOME/.config/collectiveui-spike/workspace-a.json"
node cli.mjs models --credential-file "$HOME/.config/collectiveui-spike/workspace-a.json"
node cli.mjs probe --credential-file "$HOME/.config/collectiveui-spike/workspace-a.json" --model <slug>
```

The CLI rejects credential paths inside this checkout, including resolved symlink targets. Keep a separate file for each selected registration/account. All files in the same private directory share its stable `host.json`; retain this file across sign-ins and checkout deletion, do not copy it to another host. Host creation precedes sign-in and uses random opaque `urn:uuid:` identity. Credential writes use synced owner-only temporary files and atomic rename. Host publication uses a synced temporary file and atomic non-replacing hard link, including concurrent first initialization. Storage directories must be owner-only (`0700`) and files owner-only (`0600`); unsafe existing permissions cause failure rather than silent changes.

An existing account file is only replaced after signature/identity/scope validation succeeds. Reauthentication uses the saved issued client ID and requires the same verified subject. Optional `id_token_hint` is omitted from the URL shown to the operator so credentials never enter terminal output; a returning account selector may therefore appear. ID tokens and refresh tokens are retained privately.

**Refresh is intentionally not implemented.** Expired access credentials are blocked before network use; rerun `auth` for the selected account. This does not prove rotating-refresh behavior or a complete token lifecycle. Auth denial, exchange/validation failure, or timeout does not replace the active credentials. An unsuccessful first registration is not persisted; restart registration rather than reuse the consumed code. Run only one auth process per account file at a time; cross-process account replacement locking and crash-durable directory fsync are outside this spike.

## Implemented protocol and safety checks

- Initial `client_id=dynamic_agent_client`, `agent_name_hint=CollectiveUI`, stable `ext_agent_host_id`; returning auth uses saved issued ID.
- Fresh state, nonce, and PKCE S256 per attempt. Exact `http://127.0.0.1:PORT/auth/callback` appears in authorization and token exchange.
- Required identity and plan-use scopes, resource `https://api.openai.com/v1`, documented authorize/token endpoints.
- Callback validates missing/mismatched/duplicate/expired state, consumes transaction synchronously before exchange, handles OAuth denial, requires a new issued client ID, and rejects a supplied returning ID mismatch (including empty IDs).
- Form-encoded public-client code exchange, without a client secret.
- ID token verifies RS256 signature against discovery JWKS, issuer `https://auth.openai.com`, audience issued ID, expiration, required subject/nonce, and returning subject. Live metadata advertises RS256.
- Granted token-response scope—not callback scope or a valid ID token alone—must include `chatgpt.tokens.use.direct`.
- `models` uses the same access token with public `/v1/models` and parses `.models[]`, `visibility=list`, `slug`, and `display_name`. Bundled Codex model catalogs are not entitlement evidence.
- `probe` requires an explicitly selected account-visible model; POST `/v1/responses` sets `store:false`, `stream:true`, input array and top-level instructions, not a system-role message.
- Incremental SSE handles CRLF, split chunks and multiline data, and requires final `response.completed` with completed status and exact `CHATGPT_PLAN_OK`. Failed/incomplete, partial-only, wrong marker, duplicate completion, truncated events, and missing terminal completion cannot count as success.
- HTTP requests reject redirects, bound elapsed time (30 seconds per request) and body size (1 MiB), and sanitize network/provider/parse errors. Fixtures inject transport/endpoints through module APIs, never CLI endpoint override flags.

## Evidence and test-first development

`evidence/01-...` through `11-...` retain actual red/green runs for vertical slices: storage, HTTP discovery/models, SSE probe, authorization/callback transaction, signed identity/code exchange, listener, CLI, truncated SSE, safe SSH guidance, atomic host publication, and empty returning client ID. Initial feature reds are missing-module/export failures, followed by functional green runs. Later regression reds demonstrate the specific missing safety behavior. Integration tests additionally exercise a complete signed local OAuth flow, returning authorization, and preservation of existing credentials on identity mismatch.

The evidence intentionally includes the SSH test's initial argument-syntax error and two already-green concurrency-only runs: those were not counted as successful red evidence. A filesystem publication observer then caught an empty visible `host.json` before the atomic-publication fix. Final verification is `evidence/final-tests.txt`: **34 tests passed, 0 failed, 0 skipped**.

### Live upstream observation

`node cli.mjs discover` succeeded against `https://auth.openai.com/.well-known/openid-configuration`. Its public output is retained in `evidence/live-discovery.txt`:

- issuer: `https://auth.openai.com`
- JWKS URI: `https://auth.openai.com/.well-known/jwks.json`

A separate public metadata request returned HTTP 200 and advertised `RS256`. Discovery connectivity alone proves neither registration availability nor plan inference compatibility. **Real OAuth, actual model entitlement, and live inference remain blocked on authorized operator interaction.**

### What worked

Runnable CLI, local callback listener, synthetic signed OIDC validation, exact HTTP exchange payload, owner-only protected storage, account-visible model parsing, strict SSE success/failure handling, and public discovery connectivity.

### What did not / remains unproven

No authorized real registration, entitlement, inference, refresh, WebSocket session, paid/remote deployment approval, account-file process locking, or production hardening. Do not label this VALIDATED until an eligible operator completes real OAuth, lists account models, and gets the marker through a live completed Responses stream.

### Recommendation

Use this only as an operator-run compatibility experiment. Record sanitized status/model/marker outcomes, never tokens or raw provider error bodies. Keep production integration gated on the live result and appropriate hosted-app approval; design refresh, account selection, cross-process locking, and production transport lifecycle separately.

## Official sources

- [ChatGPT plan usage for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [Public OIDC discovery](https://auth.openai.com/.well-known/openid-configuration)
