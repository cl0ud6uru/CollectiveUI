# Private agent browser operator test checklist

Status: **production containment is unverified; activation remains blocked**. This checklist prepares a
future isolated staging proof. It does not authorize deployment, live migrations, credential setup,
account login, paid inference or changes to a host's security policy. Browser functionality proved with
an explicitly unsandboxed host fixture does not satisfy these containment checks.

Use the reviewed PR #183 commit and synthetic users/pages in disposable infrastructure. Record the
commit, image digest, Chromium version, host/runtime configuration, commands and results. Keep
production `AGENT_BROWSER_ENABLED` and `AUTH_WEB_SESSION_REGISTRY_ENABLED` disabled and the
`agentBrowserView` template capability false until all gates pass and activation is separately approved.

| Gate | Required operator evidence |
| --- | --- |
| Image and sandbox | Build `docker/agent-browser/Dockerfile`, pin the resulting digest and record Chromium's version. The actual production entrypoint must launch Chromium with its sandbox enabled under the existing reviewed host constraints. Do not use the fixture override or weaken containment to obtain a pass. |
| Kernel/process boundary | Verify nonroot uid, network `none`, loopback-only interfaces, read-only root, private tmpfs, bounded CPU/memory/PIDs and dropped capabilities. No privileged/SYS_ADMIN, host IPC/network, Docker socket, host account homes or published ports. Verify renderer/background network attempts cannot leave the browser container directly. |
| Unix transport | Verify the dedicated browser-control socket directory and socket permissions. Web/worker access only the control socket; browser accesses the separate egress socket. Dedicated browser and egress secrets must differ from each other and from sandboxd credentials. Invalid, tampered and replayed signatures fail; no TCP/CDP listener or viewer input endpoint exists. |
| Public-only egress | Use a synthetic public fixture and negative cases for loopback/private/reserved/mapped/metadata IPs, mixed DNS answers, DNS changes, URL credentials, unsupported schemes/ports and redirect chains. Prove denial before any private connection, address pinning and TLS hostname validation. Test blocked WebSockets, service workers, popups, downloads and file/password inputs. |
| Owner and instance admission | With two synthetic callers and private instances, exercise actual native tools and W5 status/SSE. A second web/worker process must discover the same Page. Foreign owner/bot/run/conversation/instance claims fail; viewing never allocates a browser or workspace. Reassignment, disabled accounts/tools/bots, version changes, cancellation and ended runs revoke access. Cookies remain isolated by owner/run and redirects retain normal origin rules. |
| Logout and session expiry | Install the approved migration history only in the disposable database. Verify hashed identities, preserved 0054/0055 data, fixed expiry, tombstone retention and bounded expired-row cleanup. With two viewer windows, commit signed logout during idle and in-flight capture: old-cookie lookup fails; both sources stop; queued frames are discarded. DB outage preserves retry cookies. Already delivered client bytes cannot be recalled. |
| Limits and cleanup | Verify JPEG 1024×640, at most 256 KiB, at most one capture/sec and two viewer leases/page. Exercise process/concurrency limits, malformed/oversized requests, deadlines, cancellation, slow consumers, viewer reconnect, five-minute agent inactivity and shutdown/restart. Viewer closure must not cancel the agent or extend its lifetime. Ephemeral profiles/cookies disappear on teardown. |
| Application regression | Require current-head CI, full typecheck/lint/tests, synthetic browser fixtures and production worker smoke. The worker must complete startup and repeated sweeps without Codex recovery import errors. Native/API authentication and existing workspace isolation remain intact. Ordinary worker-image CI success is not proof of browser-container containment. |

Fail any gate: retain the blocked status and capture the failed evidence for review. Do not enable
production opt-ins, publish a debugger endpoint or select an unrelated browser as a fallback.

[Runtime, private endpoints and supported limits](agent-browser-runtime.md)
