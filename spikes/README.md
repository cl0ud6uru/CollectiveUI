# ChatGPT plan + hosted Codex compatibility spike

Branch: `spike/chatgpt-plan-codex-websockets`
Baseline: `bc1a7bfcdcb691f8e533528d1227c0eb570e2b7b`

This work is isolated research tooling, not a production feature. Do not merge or deploy it as a replacement for the existing ChatGPT provider. No production database, connected account, model selection, or service is changed by building the spikes.

## Questions and gates

1. Given an eligible personally self-hosted open-source application, can a newly registered application complete the documented ChatGPT-plan OAuth flow and a public Responses request? `001-chatgpt-plan` tests registration validation and HTTP/SSE, then requires an operator-completed fresh login for live inference.
2. Given a pinned hosted Codex runtime, can CollectiveUI's bridge initialize it, preserve thread identity, map approvals and stop safely without relying on internal auth RPCs? `002-runtime-transports` tests private stdio, explicit request correlation and fail-closed approvals.
3. Given a new eligible credential, can the native harness use public Responses WebSockets with terminal-event validation and no automatic replay of uncertain submissions? `002-runtime-transports` tests the transport locally first; live upstream availability is a separate gate.

No fixture or mock result is a live API compatibility result. A terminal success event, not a text delta, proves completion. API-key features and ChatGPT-plan features must be capability-gated separately.

## Existing integration audit

The baseline's `src/lib/llm/chatgpt/oauth.ts` uses a fixed `CHATGPT_CLIENT_ID` with the Codex device-code flow. `src/lib/llm/chatgpt/fetch.ts` targets the ChatGPT backend and supplies account, originator and internal residency headers. `body.ts` rewrites requests to that route's field restrictions.

The new first-party OSS plan-use flow is materially different: dynamic application registration, issued client IDs, stable host IDs, PKCE + OIDC validation, scope consent, and public `https://api.openai.com/v1/responses`. Existing encrypted credentials cannot simply be repointed; a separately consented connection is required. Preserve existing connections unchanged during this spike.

Do not confuse identity-only website login with plan-use authorization. Website partner registration is separately limited. OSS/private self-hosted eligibility must not be generalized to a paid or remotely hosted multi-user service.

## Promotion requirements

- Fresh operator-authorized OAuth + account-specific model listing + terminally completed public HTTP/SSE inference.
- Codex private stdio model turn with persistent thread resume, explicit approve/deny, verified stop and restart recovery.
- Optional native Responses WebSocket experiment; no cross-account multiplexing and no blind replays on disconnect.
- Credential refresh and ownership policy validated before provisioning multiple users.
- Review runtime isolation, per-user volumes, secret handling and gateway request authorization before adding production routes.

## Primary sources

- Registration: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- Public inference: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- Hosted/private VM notes: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- Eligibility: https://developers.openai.com/siwc/token-sharing-open-source
- Plan-use limits: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- App-server plan setup: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- App-server transport: https://developers.openai.com/codex/app-server
- Native WebSocket transport: https://developers.openai.com/api/docs/guides/websocket-mode
- API changes: https://developers.openai.com/api/docs/changelog

Runtime commands and current verdicts are in each spike's README. Until a fresh authorized model request has completed, the compatibility verdict is PARTIAL, not VALIDATED.
