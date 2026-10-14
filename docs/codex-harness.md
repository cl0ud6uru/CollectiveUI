# Personal Codex app-server

The bot editor includes an optional **Codex · personal agent** path. Each caller's bot uses that caller's owner-bound ChatGPT subscription connection and a private Codex app-server runtime. Sharing a bot shares its definition only; it does not share the bot owner's account, runtime, workspace, history, or credentials.

This is a separately gated preview, not a generally available third engine. The optional Mac Connected accounts companion is implemented and disabled by default. It requires approved distribution, installation and HTTPS configuration; see the [companion guide](chatgpt-companion.md). The runtime remains unavailable by default until operators distribute and enroll the reviewed stock wrapper image and complete the live sandbox checks below. The optional computer/SBX mode has its own administrator opt-in and live proof requirement; it also remains off by default. Neither UI work nor a synthetic test enables these runtimes.

## ChatGPT account and runtime setup

Codex uses the same owner-bound **Sign in with ChatGPT** credential described in [People's own ChatGPT plans](connections.md#peoples-own-chatgpt-plans-sign-in-with-chatgpt). That integration uses OpenAI's supported token-sharing flow. It does not use Codex's native device-code grant, and an existing native grant is not converted or copied into the SIWC credential.

When the Mac companion is enabled and installed, start sign-in from Settings → Connected accounts. When it is disabled, an owner can use the protected CLI fallback:

1. An administrator configures a stable `CHATGPT_SIWC_HOST_ID`, enables personal ChatGPT access for the intended audience, and confirms the policy permits the owner's plan. A legacy workspace allowlist must be reviewed because SIWC does not expose the workspace metadata that policy needs.
2. The owner signs in locally with `npm run chatgpt:sign-in -- --output ./chatgpt-profile.json`. The helper uses PKCE and a loopback callback, writes a protected profile file, and binds it to the local host ID. The owner must sign in with the account matching their CollectiveUI email or UPN.
3. The owner transfers only that profile over a private channel they control. On the installation, an operator imports it for the exact CollectiveUI user with `npm run chatgpt:import -- --user-id <user-id> --file <protected-profile-path>`. Import verifies the profile and owner binding before encrypted storage. Follow the detailed steps in the [connection guide](connections.md#peoples-own-chatgpt-plans-sign-in-with-chatgpt).
4. Separately, operators distribute the reviewed, immutable stock wrapper image, configure the isolated per-owner runtime and approved egress, and enroll only the intended users. The runtime provisioner does not build or publish images, create networks, or change host security policy.

The local profile/import flow remains available when the companion is disabled. The implemented companion does not relax image distribution, per-owner enrollment, account policy, or operator verification requirements. SIWC credentials are never placed in Docker configuration, command-line arguments, or persistent Codex auth files; the adapter synchronizes the token to the stock app-server over its protected local channel.

## Runtime boundary and capabilities

`src/personal-codex` is a host-side broker and the only personal-runtime service with Docker access. Web and worker reach it through a protected Unix socket; the agent container receives neither that socket nor the host Docker socket. Owner identity comes from authenticated server code. The runtime uses dedicated owner storage for Codex state and work files, retained across container replacement. Disconnecting an account does not silently delete those files or native threads.

The app-server handles direct bot turns and persistent native threads. The portal records durable run state, supports reconnect and Stop, and checks the current account/runtime binding before dispatch. A lost dispatch acknowledgment is treated as uncertain and is not replayed automatically. The app-server provider uses the owner's SIWC credential with the Responses API; local tools stay in the native tool loop. Hosted tools, server-side response storage, `previous_response_id`, and automatic API-funded fallback are unsupported.

The current bot mode does not support attachments, group chats, routines, or delegation. Commands and file changes remain inside the configured stock sandbox. Network access and broader computer/SBX capabilities are separate operator-controlled features; they are not implied by a successful portal setup check.

## Activation and validation

The broker configuration keeps SIWC sandbox verification false by default. Do not enable it based on a config read, a local fixture, or an earlier native-device-login probe. The exact stock image must pass the shell-environment and `/proc` isolation proof on the intended runtime host. The [stock SIWC validation record](validation/chatgpt-siwc-stock-runtime.md) documents the synthetic checks, the outstanding live proof, and the required operator boundary. Its current evidence does not certify authenticated inference or authorize activation.

Before enabling any caller, operators must distribute the reviewed image, verify the exact image and isolation policy, configure the narrowly scoped egress path, complete the protected live proof, and explicitly enable the intended audience. Keep each option off until its own checks pass. The [computer deployment guide](deploy/computer-view.md) distinguishes `COMPUTER_VIEW_ENABLED=0` and the web-session registry, protected broker `adminEnabled: false`, and `siwcSandboxVerified: false`. Enabling the viewer or recording an admin validation note does not establish credential containment or enable SIWC. A successful stock-runtime proof does not approve a different computer/SBX image; that mode requires separate exact-image live validation. Apply the full journal through `0057_chatgpt_companion` with the matching web/worker version.

## Legacy manifest assignments

`CODEX_RUNTIME_MANIFEST` remains a compatibility path for older assignments. Those runtimes provide direct text chat only; they do not receive the native command/file tools, attachments, groups, routines, or delegation. A failed personal runtime never falls back to the bot owner's credentials, another caller's account, or an API-funded connection.
