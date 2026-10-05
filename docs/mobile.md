# Native iOS app

CollectiveUI has a native SwiftUI client for iPhone and iPad in [`ios/`](../ios/README.md). It talks to your own
installation: people enter its address, sign in through the web sign-in page, and then chat with the same bots, models
and history as on the web.

> **Pre-release:** the app is built from source with Xcode and is not on the App Store. Distribute it through your own
> Apple Developer account (TestFlight or MDM) after testing it against your installation.

## What works in the app

- Bot roster with home chats and side chats, model chats, and chat history (pin, rename, archive, delete, search).
- Streaming replies with Markdown, code blocks, reasoning and tool activity; Stop and Regenerate.
- Tool approvals: approve or deny a pending action from the chat.
- Image and document attachments (the same upload limits as the web).
- Resuming a reply that was still running when the app was closed.
- Inbox: routine and task results and approval requests.

Administration, bot editing, settings and security (passkeys, TOTP, passwords) stay on the web. Group chats can be read
but are best used on the web. Hermes slash commands are not offered in the app.

## Enable it on the server

Set in **both** the web environment (the worker does not need it):

```dotenv
MOBILE_APP_ENABLED=true
# Optional, 1–365 days (default 30): how long a device stays signed in.
MOBILE_SESSION_DAYS=30
```

Apply migrations (`0027_mobile_sessions`) before starting the new version. Use HTTPS with a certificate the device
trusts; iOS refuses plain HTTP except for local-network development servers.

## How sign-in works

The app never sees a password. It uses an OAuth-style flow with PKCE, so every sign-in method the web supports works,
including local accounts with passkeys or an authenticator app, Microsoft Entra ID and LDAP.

1. The app opens `/mobile/authorize` in a secure system browser sheet (`ASWebAuthenticationSession`) with a PKCE
   challenge, a random `state` and the device name.
2. If the person is not signed in, the normal sign-in page appears and returns to the consent page afterwards.
3. The consent page names the device and the account. **Approve** posts back to the same origin and redirects to
   `collectiveui://auth/callback` with a one-time code; **Cancel** returns `error=access_denied`.
4. The app redeems the code at `POST /api/mobile/auth/token` with its PKCE verifier. Codes are single use (a wrong
   verifier burns the code) and expire after two minutes.
5. The app receives an opaque bearer token, stored in the iOS Keychain (this device only).

### Token security

- Only SHA-256 hashes of codes and tokens are stored (`mobile_auth_codes`, `mobile_sessions`).
- A token is bound to the account's session version when it was issued, and every request re-checks the account the
  way a web session refresh does. For local accounts, anything that signs a person out of the web everywhere — a
  password reset or change, a passkey or authenticator change, or an admin access change — also signs out every
  device. For any account, disabling it in CollectiveUI or turning off its sign-in provider rejects its tokens on the
  next request. Expired and revoked tokens stop working immediately.
- **Directory accounts (Entra ID, LDAP):** like web sessions, a token does not ask the directory again on each
  request; group membership is refreshed at sign-in. A web session lasts at most 12 hours, a device token up to
  `MOBILE_SESSION_DAYS`. When someone leaves, disable the account in **Admin → Users** (which takes effect
  immediately) rather than relying on the directory alone, or choose a shorter `MOBILE_SESSION_DAYS`.
- People see their devices under **Settings → Security → Signed-in devices** and can sign out one or all. Sign-ins and
  revocations are recorded in the audit log (`mobile.authorize`, `mobile.revoke`).
- Turning `MOBILE_APP_ENABLED` off stops new sign-ins and rejects all existing tokens without deleting them.
- A bearer token reaches only the mobile API: `/api/mobile/v1/*`, `/api/chat` (send, snapshot, resume, stop),
  `/api/files` and `/api/search`. `proxy.ts` rejects it everywhere else (pages, admin, account security, server
  actions). A request carrying a bearer token is judged by the token alone, never by cookies, and `/api/mobile/v1/*`
  never accepts browser cookies. Other `Authorization` schemes, such as Basic auth from a reverse proxy, are unaffected.

## API reference

All JSON; errors are `{ "error": "…" }`. Authenticated requests send `Authorization: Bearer <token>`; a `401` means the
token is no longer valid and the app signs out.

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/mobile/info` | public | `{ enabled, appName, logoEmoji, apiVersion }` — checks a server address before sign-in |
| `GET /mobile/authorize?code_challenge=…&code_challenge_method=S256&state=…&device_name=…` | browser | Consent page |
| `POST /api/mobile/auth/token` `{ code, codeVerifier }` | public (code) | `{ token, expiresAt, user }` |
| `GET /api/mobile/v1/session` | token | `{ user, deviceName, expiresAt }` |
| `DELETE /api/mobile/v1/session` | token | Sign this device out |
| `GET /api/mobile/v1/shell` | token | `{ user, branding, conversations, folders, apps, bots, inboxUnread }` — the web sidebar's data |
| `POST /api/mobile/v1/bots/{id}/chat` `{ kind: "home" \| "side" }` | token | `{ conversationId }` |
| `PATCH /api/mobile/v1/conversations/{id}` `{ title?, pinned?, archived? }` | token | Rename, pin, archive |
| `DELETE /api/mobile/v1/conversations/{id}` | token | Delete a chat |
| `GET /api/mobile/v1/inbox` | token | `{ items: [{ id, kind, title, body, conversationId, createdAt, read }] }` |
| `POST /api/mobile/v1/inbox/read` `{ id? }` | token | Mark one or all read |
| `GET /api/chat/{id}` | token | Conversation snapshot (same as the web) |
| `POST /api/chat` | token | Send, regenerate or answer approvals; replies with the AI SDK UI message stream over SSE |
| `GET /api/chat/{id}/stream` | token | Resume the current reply (`204` when there is nothing to resume) |
| `POST /api/chat/{id}/stop` `{ messageId }` | token | Stop the reply |
| `POST /api/files`, `GET /api/files/{id}` | token | Upload (multipart field `file`) and download attachments |
| `GET /api/search?q=…` | token | Search chat titles and messages |

`POST /api/chat` bodies are the same as the web client's: a new user message
`{ conversationId, appId? | botId?, parentId, message: { id, role: "user", parts } }`, a regeneration
`{ conversationId, regenerate: true, parentId }`, or approval answers
`{ conversationId, message: { id, role: "assistant", parts } }` where only each tool part's `approval.approved` and
`approval.reason` are read (see `src/lib/agent/approval-merge.ts`).

## Verifying a deployment

1. Open `https://<your-host>/api/mobile/info` and check `"enabled": true`.
2. In the app, enter the address, sign in and approve. The device appears in Settings → Security.
3. Send a message, close the app while the reply streams, reopen it: the reply resumes.
4. Sign the device out from Settings on the web: the app returns to its sign-in screen on its next request.
