# Consented private Codex runtime preparation

This change is a bounded setup slice. Connected accounts shows account eligibility,
private runtime readiness, and the local sign-in prerequisite separately. An eligible
user can consent to preparation of their preapproved isolated runtime. Preparation
does not create a ChatGPT credential, bind a personal account, authorize inference,
or begin an OAuth grant. Connect remains disabled until a supported local sign-in
companion is implemented and installed.

## Authorization and installation prerequisites

The existing Admin → Settings → ChatGPT policy remains authoritative. Preparation
rechecks the current user, session version, groups/admin privileges, installation
host ID, email binding, personal-plan policy, and workspace restrictions under the
owner lock. Nonterminal Codex work blocks preparation. Browser requests carry only
an action and explicit versioned consent; they cannot choose an owner or upload
credentials.

`allowSelfEnrollment` is a broker installation capability and defaults to `false`.
An operator may enable it for an installation whose immutable stock image, reviewed
sandbox profile, protected socket directory, and isolated owner egress resources
are already approved. Readiness inspects those resources without creating or
starting anything. This slice does not provision networks or proxies, change host
security policy, pull/build an image, or enable that capability on a live host.
Existing statically enrolled owners remain supported.

After explicit consent, the broker creates/starts only the owner's private volumes
and container, confirms token clearing, and writes a protected infrastructure
receipt. Receipts are bound to the owner, installation namespace, and immutable
image. Pending receipts never restore admission after restart. Failed cleanup
revokes in-memory admission before unlinking. A running, fingerprint-bound
connection is preserved by repeated preparation. Restarted brokers still require
fresh token synchronization before a connected account can dispatch work.

## Remaining sign-in work

OpenAI's open-source token-sharing path requires a system browser and an exact
HTTP `127.0.0.1` callback ending in `/auth/callback`; the port may vary. Its
self-hosted VM guidance uses local authorization and protected transfer while the
VM keeps its own host ID and owns refresh. The website integration requires an
issued client and registered callback. A website identity client cannot simply be
substituted for subscription token sharing, and availability of a suitable website
client has not been established for this installation.

Sources: [OSS sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms),
[website integration](https://developers.openai.com/siwc/website),
[client availability](https://developers.openai.com/siwc/request-client-id), and
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

The repository's existing loopback SIWC helper and official-plan companion
transport can support a later implementation, but no verified installed driver
currently completes that handoff. The current iOS web authenticator handles the
CollectiveUI login callback; it is not a ChatGPT companion. A supported native
companion, pairing/return flow, secure owner-bound handoff, and cancellation/replay
handling are required to complete Connect → OpenAI sign-in → Native CollectiveUI
or stock Codex. No personal identity, enrollment, OAuth grant, or credential was
changed while building this slice.

## Validation

Focused synthetic tests cover strict HTTP consent and owner derivation, current
policy/session checks, active-work refusal, credential-free preparation, truthful
UI states, read-only readiness, installation-bound receipts, failed unlink across
restart, and connected-runtime idempotence. Driver tests verify preflight performs
no resource mutation. Unix socket tests use disposable fixtures; no production
Docker runtime or OAuth service is contacted. Final validation passed 173 tests
across eleven focused suites (including repository policy guards) and `npm run typecheck`. Targeted lint reported no errors
and five existing warnings in the driver and account tests. Independent Sol 6.1
and Luna reviews found no blocking issue within this slice. Stock runtime image
files are unchanged. Desktop/browser UI control was paused at the user's request.
Terminal-only UI checks include static renders and disposable headless Chromium
fixtures that exercise consent, exact mutation payloads, failure recovery,
connected controls, approval headers, retained saved-connections settings and
distinct backend guidance at 320/390/768/1280 pixel widths. The fixtures use
synthetic localhost endpoints and separate temporary browser profiles.
