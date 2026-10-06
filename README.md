# CollectiveUI

<a id="ai-portal"></a>

**A self-hosted AI workspace. Choose what runs your bots.**

CollectiveUI brings AI conversations and task-focused bots into one web app, with a choice of engine behind each bot. Use CollectiveUI’s built-in engine with a connected model, or connect a Hermes backend with its own tools, memory, skills and model. Different bots can use different engines through the same chat interface.

Use it for yourself or a team, with an administrator choosing the available connections, tools and access rules.

Already have an invitation or a link from your team? Open that site and sign in. You only need the setup instructions below if you are running your own installation.

> **Pre-release:** CollectiveUI is under active development and is not yet production-ready. Try it with demo data first. Real providers, enterprise sign-in and your deployment need validation in your own environment. See [current limitations](#current-limitations) and the [operator guide](docs/operations.md).

## A quick look

These are captures of the running app with synthetic demo data and the included mock model. They show the interface, not the quality of a live AI provider. Only original artwork shipped with CollectiveUI is shown.

![CollectiveUI chat showing a mock reply with a table, code and math, alongside the bot's activity panel.](docs/images/chat.png)

*Keep a conversation, its bot and recent activity together.*

![The Bots page with demo assistant cards, short descriptions and links to start chatting.](docs/images/bots.png)

*Choose an assistant for a job, or create your own when your administrator allows it.*

![Pet avatar settings showing the original icon and built-in Moss and Ember artwork.](docs/images/avatars.png)

*Give bots a recognizable identity with the built-in pets or artwork your administrator has approved.*

## What you can do

- **Chat and come back later.** Stream answers, attach documents or images, search your history and organize chats into projects. Answers support tables, code and math. Available features depend on the connected model.
- **Make assistants for recurring work.** A bot has a name, instructions, conversation starters and selected tools. Opening a bot returns to your ongoing home chat; start a side chat for a separate topic. `/new` or `/reset` starts a fresh home while retaining the old history and memory. Finish or stop pending work first.
- **Start with a coordinator.** An admin can choose an existing native bot or create the editable **The Queen** starter to welcome users and bring together answers from permitted specialists. It is optional and off by default; a model must be configured before the starter can answer. Bots with the **Coordinator** role are suggested, deselectably, as delegators when their editors create new bots. [Coordinator setup](docs/features/default-coordinator.md).
- **Use tools with clear permissions.** Native bots can use enabled web, knowledge, memory and workspace tools. Admins can connect other systems through MCP, a standard way to expose tools to an AI assistant. Tool approvals let you review actions before they run; sensitive actions require approval.
- **Save procedures and schedule work.** Native bots can use skills (saved instructions for a task) and routines (scheduled or webhook-triggered work). Routine results and approval requests arrive in the Inbox. Availability varies by bot engine and mode.
- **Share useful assistants.** Share bots with your organization or selected directory groups, and share chat snapshots or bot templates with signed-in colleagues. Administrators manage model access, users, tools and usage.
- **Choose a familiar face.** Moss and Ember are built-in pet avatars. Admins can publish additional artwork after reviewing its sharing rights and credits. Shared bots use one identity set by their owner or an admin; service-bot identity is admin-only. Private caller bots keep personal avatar choices. Everyone controls their own animation setting. [Avatar details](docs/features/bot-companions.md).

Want more detail? The [user guide](docs/user-guide.md) covers chat controls, bot memory, routines, sharing, approvals and branding.

**Talk by voice.** Direct chats using an OpenAI API connection have a headphones control for spoken conversations with `gpt-live-1`. Voice transcripts are temporary. [Setup and limitations](docs/voice.md).

<a id="models-agent-backends-and-bots"></a>

## Choose the engine behind each bot

An **agent harness**, called a **bot engine** here, is the software that runs a bot’s steps and tools around its AI model. Choosing the engine determines which system provides the bot’s tools, memory and skills.

When creating a bot, choose **Bot engine → Native · CollectiveUI** and a **Model connection**, or **Hermes** and an **Agent backend connection**. Today, these are the two supported engines; Hermes is the only supported external harness. Available features and permissions depend on the engine and bot mode.

| Name in the app | What it means | Where you use it |
| --- | --- | --- |
| **Model connection** | A connection to one AI model or provider deployment that generates answers. | **New Chat**, or a bot using the built-in **Native · CollectiveUI** engine. |
| **Agent backend connection** | A connection to a service that runs its own agent, tools and model. **Hermes** is the external backend currently implemented. | A bot using the **Hermes** engine. It is not a model choice in New Chat. |
| **Bot** | A named assistant with a purpose, instructions and an audience. It uses a model through the native engine, or an agent backend. | **Bots**, including its home chat and side chats. |

Admins configure both types of connection under **Admin → Connections**. [Supported providers and setup](docs/connections.md) · [Model and backend behavior](docs/features/models-and-agent-backends.md).

![Admin Connections showing Mock GPT under Models and two saved Hermes demo profiles under Agent backends, each marked bot-only.](docs/images/hermes-backends.png)

*Model connections and Hermes backends, side by side in Admin → Connections. Synthetic demo settings; no live Hermes connection was tested.*

A normal **caller bot** uses the signed-in person's permitted tools. An **admin-managed service bot** exposes a narrowly reviewed set of MCP capabilities to its audience without giving everyone direct access to the connector. Service bots currently work only in direct chats; they do not run in groups, delegation or routines. Writes always require approval, and the upstream service must enforce the configured scope. [Service-bot setup and permissions](docs/service-bots.md).

**Hermes is optional.** Manually connected Hermes bots share their configured profile's memory and skills with everyone who can use that bot. Managed Hermes can provision a separate profile for each user and bot, but requires operator-provided process/filesystem isolation, protected management access, loopback forwarding and credentials. CollectiveUI does not create that infrastructure. Managed mode currently supports direct bot chats only. Existing Hermes conversations created without a bot remain readable but cannot continue; start a new conversation with the intended bot. [Hermes setup and limits](docs/connections.md#hermes-agent-bots-from-your-hermes-profiles) · [Managed profile prerequisites](docs/architecture/hermes-profile-provisioning.md).

**Personal Docker Hermes:** Operators configure the protected broker, pinned image, storage, limits and network policy once. Admin → Hermes then grants per-user enrollment (disabled by default, including admins), separately from broker readiness. Enrolled users choose Settings → Connected accounts → Personal Hermes → Enable to lazily create their private runtime. Provider authentication remains a separate native setup step. Revoking permission denies access, invalidates leases and stops the runtime; failed stops are visible and retried, with native data and mappings retained. Existing `DOCKER_HERMES_ALLOWED_USER_IDS` deployments must use the explicit preview/apply migration documented below; the environment is no longer an authorization fallback. [Setup, security boundaries and validation limits](docs/architecture/docker-hermes.md).

## Sign-in and access

![The local-account sign-in page, with a built-in Moss companion and empty username and password fields.](docs/images/sign-in.png)

*The sign-in screen can use your installation’s name, introduction and approved artwork.*

Run with **local accounts**, **Microsoft Entra ID** single sign-on, **Active Directory over LDAP(S)**, or a combination. Local accounts need no directory or email service: the operator creates the first admin, and admins create other accounts. There is no public signup. Local and directory accounts remain separate even when their email addresses match.

An installation serves **one organization**; this is not a turnkey multi-tenant hosting platform. [Local accounts, enterprise login and recovery](docs/operations.md).

## Try it locally

This walkthrough runs a **local demo with scripted replies**, so you do not need a paid model account. You need **Node.js 22.18+**, npm, Git and Docker Compose. Use a private development machine: the demo database and optional LDAP fixture have public passwords, and the development Compose file publishes their ports. For a server or team installation, follow the [deployment guide](docs/operations.md) instead.

1. Get the code and start the demo dependencies:

   ```bash
   git clone https://github.com/cl0ud6uru/CollectiveUI.git
   cd CollectiveUI
   npm ci
   docker compose -f docker-compose.dev.yml up -d db mock-llm
   cp .env.example .env.local
   chmod 600 .env.local
   ```

2. Edit these values in `.env.local`. Run `openssl rand -base64 32` **three times**, then paste a different output into each `REPLACE_…` field; the placeholders are not working secrets.

   ```dotenv
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/portal
   AUTH_URL=http://localhost:3000
   AUTH_LOCAL_ENABLED=true
   AUTH_ENTRA_ENABLED=false
   LDAP_ENABLED=false
   AUTH_SECRET=REPLACE_WITH_FIRST_GENERATED_SECRET
   ENCRYPTION_KEY=REPLACE_WITH_SECOND_GENERATED_SECRET
   TOOL_APPROVAL_SECRET=REPLACE_WITH_THIRD_GENERATED_SECRET
   ```

3. Once Postgres is ready, apply the database migrations and create your first local administrator:

   ```bash
   docker compose -f docker-compose.dev.yml exec db pg_isready -U postgres
   node --env-file=.env.local --import tsx src/db/migrate.ts
   LOCAL_AUTH_OPERATOR=bootstrap node --env-file=.env.local --import tsx scripts/local-account.ts bootstrap
   npm run db:seed
   ```

   The interactive bootstrap prompts for your username, display name, optional email and a hidden password (15–128 characters). It runs once on a fresh installation. The seed adds **Mock GPT** and **Research Assistant**; use it only with a development database.

4. Start the web app and worker in **two terminals**, both in the repository:

   ```bash
   npm run dev
   ```

   ```bash
   npm run worker:dev
   ```

Open **http://localhost:3000**, sign in with the account you just created, choose **Mock GPT** and send `demo`. The worker is required for replies. When you want real answers, an admin can [add a model connection](docs/connections.md#connecting-models-and-agent-backends).

See [local setup and troubleshooting](docs/getting-started.md) for the optional LDAP demo, development tools and common startup problems.

## Account security

Local users can open **Settings → Account Security** to add a passkey or authenticator app. Passkeys provide passwordless sign-in with required device PIN/biometric verification and may sync across devices. TOTP adds a code after the password. Adding the first factor blocks password-only sign-in, provides recovery codes and revokes existing sessions. Existing users are not enrolled by migration.

Use a stable HTTPS `AUTH_URL` in production; development supports `http://localhost:<port>`. TOTP requires an explicitly configured 32-byte base64 encryption key, including in development. Save recovery codes privately and keep a second passkey. Password resets preserve enrolled factors. LDAP users can also enroll CollectiveUI passkeys in Settings, then sign in with a company passkey. Enrollment blocks password-only LDAP sign-in; recovery requires the company password and a saved recovery code. Entra passkeys and MFA stay with the identity provider and require separate enrollment. See [security design, recovery and verification](docs/security/local-mfa.md) before enabling this on an installation.

## Current limitations

- The worker must be running for direct-chat replies, routines and memory extraction. Direct replies can resume their stream after reload; group chats still run inside the request and do not resume after reload.
- Group chats and delegated bots cannot ask for tool approval. Native durable turns can delegate synchronously or asynchronously. Related follow-ups use the specialist's `continue_*` tool with an earlier task ID, preserving the child conversation and one Recent entry; unrelated work uses `ask_*` to start a new task. Follow-ups queue in order and require the same owner, originating chat, source bot, target and current permissions. Hermes continuation is not supported. [Continuation design and verification](docs/testing/delegation-followups.md).
- Optional workspaces have no network access or per-workspace disk quota. Set up isolation and host storage limits before enabling them.
- Managed Hermes provisioning has mock-backed contract tests, not live deployment conformance. It is not a claim of tested isolation or real-provider readiness.
- This release has no general model-usage quotas or cost caps, and uploaded files have no malware scanning. Passkeys are optional for local and LDAP accounts; local TOTP is optional, and Entra authentication policy remains provider-managed.

See the [development status and backlog](TODO.md), [service-bot restrictions](docs/service-bots.md) and [Hermes architecture](docs/architecture/hermes.md) for the full context.

## Guides

| I want to… | Read this |
| --- | --- |
| Learn chat and bot controls | [User guide](docs/user-guide.md) |
| Run the demo or troubleshoot startup | [Local setup](docs/getting-started.md) |
| Deploy, update, back up or recover an installation | [Operator guide](docs/operations.md) |
| Connect models, MCP tools or Hermes | [Connection guide](docs/connections.md) |
| Set up an optional coordinator or The Queen starter | [Default coordinator](docs/features/default-coordinator.md) |
| Configure narrowly scoped shared capabilities | [Service bots](docs/service-bots.md) |
| Manage pet artwork and identity permissions | [Pet avatars](docs/features/bot-companions.md) |
| Understand the code or run tests | [Development guide](docs/development.md) |
| Understand persistent bot conversations | [Conversation architecture](docs/architecture/agent-conversations.md) |
| Use CollectiveUI on iPhone or iPad | [Native iOS app](docs/mobile.md) |

**Before deploying:** use HTTPS, keep the database private, generate unique secrets, and back up Postgres, uploaded files and the required encryption/session secrets together. Never use demo passwords or `db:seed` in production. Apply migrations before the new app starts. Compose pins uploads to `/data/uploads`; existing custom storage needs an explicit override or a planned file move in **both web and worker**. Files are not migrated automatically. Read [deployment and custom-storage upgrades](docs/operations.md#production-deployment) before recreating containers.

<details>
<summary>Looking for a section from the previous README?</summary>

<a id="features"></a>
<a id="custom-branding"></a>
Chat, bots, administration and [custom branding](docs/user-guide.md#custom-branding) are in the [user guide](docs/user-guide.md).

<a id="quick-start-local-development"></a>
The [local development guide](docs/getting-started.md) includes the original LDAP demo setup.

<a id="production-deployment"></a>
<a id="standalone-vps-with-local-accounts"></a>
<a id="provider-switches-sessions-and-upgrades"></a>
<a id="password-reset-and-operator-recovery"></a>
<a id="active-directory-setup"></a>
<a id="option-a-microsoft-entra-id-recommended"></a>
<a id="option-b-on-prem-ad-over-ldaps"></a>
<a id="workspaces-sandboxed-commands"></a>
<a id="routines-via-webhook"></a>
Deployment, local accounts, recovery, directory setup, workspaces and webhook signing moved to the [operator guide](docs/operations.md).

<a id="connecting-models-and-agent-backends"></a>
<a id="your-mcp-servers"></a>
<a id="peoples-own-chatgpt-plans-sign-in-with-chatgpt-unofficial"></a>
<a id="hermes-agent-bots-from-your-hermes-profiles"></a>
Model providers, MCP, the optional unofficial ChatGPT-plan connection and Hermes setup moved to the [connection guide](docs/connections.md).

<a id="architecture"></a>
<a id="running-the-tests"></a>
<a id="project-layout"></a>
Architecture, test commands and the source map moved to the [development guide](docs/development.md).

</details>

## License

CollectiveUI is available under the [MIT License](LICENSE). Third-party dependencies, tools and imported artwork retain their own licenses and required notices. See the [pet artwork and credit notes](docs/features/bot-companions.md#source-and-license-research).

### OpenAI native web search

Optional hosted search is available for verified official OpenAI API models, with admin limits, bot defaults, per-chat Off/Auto controls, citations and separate call accounting. It defaults off and does not use ChatGPT subscription credentials. See [setup, policy and fixture validation](docs/operations/openai-native-search.md).
