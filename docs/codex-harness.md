# Personal Codex app-server

The bot editor includes an optional **Codex · personal agent** path. Each caller's bot uses that caller's owner-bound ChatGPT subscription connection and a private Codex app-server runtime. Sharing a bot shares its definition only; it does not share the bot owner's account, runtime, workspace, history, or credentials.

This is a separately gated preview for an owner’s private runtime. Stock Codex has a browser device-code sign-in in Settings → Connected accounts. It needs no Mac companion, profile import, installation host ID, or prefilled local email. Operators must still install the reviewed runtime/broker, enroll the intended owner, and complete its live sandbox checks. The independent Native CollectiveUI provider retains its separate SIWC authentication. Computer/SBX mode remains a separate opt-in; this browser device flow currently targets the Docker backend.

## ChatGPT account and runtime setup

1. In **Settings → Connected accounts → Stock Codex**, accept the private workspace/account consent and click **Connect stock Codex**.
2. The portal prepares the owner’s previously approved resources and asks stock Codex for a device code. Enter the displayed code on the official OpenAI page opened by the button. The owner performs all OpenAI login/consent.
3. Return to CollectiveUI. It polls the owner’s app-server, displays the verified email, account/workspace and plan, and requires **Confirm stock Codex account**. The confirmation is compared with a fresh app-server identity under the local owner lock. No local-email equality is required. Current audience, workspace and plan policies still apply.
4. Select a caller-mode bot using **Codex · personal agent** and ChatGPT subscription funding. Send a direct text message. Commands and file edits execute inside that owner’s sandbox; broader permissions can be denied or stopped.

Codes expire after 15 minutes. Cancel and disconnect cancel pending login and log out any concurrently completed grant. Disconnect retains workspace/history files and invalidates the portal binding. Codex owns credential persistence and refresh in the isolated `/codex-home`; the portal does not read or export tokens. Login uncertainty survives broker restart and requires cancellation before another dispatch. A completed account survives runtime/broker restart and is checked against the saved owner binding on use.

Native CollectiveUI’s SIWC connection remains independent. Connecting or disconnecting it does not replace a confirmed device account. Administrator disable/bulk disconnect still clears both. The legacy stock SIWC adapter requires explicit broker `authenticationMode: "siwc"`; it cannot silently replace a connected native grant. See the [companion guide](chatgpt-companion.md) for that separate integration.

## Runtime boundary and capabilities

`src/personal-codex` is a host-side broker and the only personal-runtime service with Docker access. Web and worker reach it through a protected Unix socket; the agent container receives neither that socket nor the host Docker socket. Owner identity comes from authenticated server code. The runtime uses dedicated owner storage for Codex state and work files, retained across container replacement. Disconnecting an account does not silently delete those files or native threads.

The app-server handles direct bot turns and persistent native threads. The portal records durable run state, supports reconnect and Stop, and checks the current account/runtime binding before dispatch and completion. A lost dispatch acknowledgment is treated as uncertain and is not replayed automatically. Native device mode selects stock Codex’s `openai` provider; local tools remain in its tool loop. Automatic API-funded fallback is unsupported.

The current bot mode does not support attachments, group chats, routines, or delegation. Commands and file changes remain inside the configured stock sandbox. Network access and broader computer/SBX capabilities are separate operator-controlled features; they are not implied by a successful portal setup check.

## Activation and validation

The broker keeps its historical `siwcSandboxVerified` sandbox-verification gate false by default, including for device runtime preparation. The new wrapper changes provider selection and requires a fresh exact-image proof. Do not reuse an earlier image’s evidence. The [browser device deployment record](validation/codex-browser-device-login.md) lists exact rollout requirements, local evidence and remaining owner/VM checks. The [stock SIWC validation record](validation/chatgpt-siwc-stock-runtime.md) remains the separate token-bearing process proof.

Before enabling any caller, operators must distribute the reviewed image, verify the exact image and isolation policy, configure the narrowly scoped egress path, complete the protected live proof, and explicitly enable the intended audience. Keep each option off until its own checks pass. The [computer deployment guide](deploy/computer-view.md) distinguishes `COMPUTER_VIEW_ENABLED=0` and the web-session registry, protected broker `adminEnabled: false`, and `siwcSandboxVerified: false`. Enabling the viewer or recording an admin validation note does not establish credential containment or enable SIWC. A successful stock-runtime proof does not approve a different computer/SBX image; that mode requires separate exact-image live validation. Apply the full journal through `0057_chatgpt_companion` with the matching web/worker version.

## Legacy manifest assignments

`CODEX_RUNTIME_MANIFEST` remains a compatibility path for older assignments. Those runtimes provide direct text chat only; they do not receive the native command/file tools, attachments, groups, routines, or delegation. A failed personal runtime never falls back to the bot owner's credentials, another caller's account, or an API-funded connection.
