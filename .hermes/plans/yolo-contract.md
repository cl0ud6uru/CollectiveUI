# Runs API /yolo integration contract

Source inspected: src/lib/llm/resolve.ts, src/lib/llm/providers/hermes/client.ts, src/lib/runs/hermes-context.ts at base 234b57703553da249d531618d73e1b1fe36981fa.

Normal remote bot runs pass session_id = `portal-${conversationId}-${botId}` to POST /p/{profile}/v1/runs. These are caller-supplied IDs, not native workspace runtime/stored IDs. Approval-mode endpoints must use precisely this same ID, including before the first run; do not invent a separate session identity. Persist it across server restarts and do not inherit it into a fresh session.

Required: authenticated profile-prefixed GET and PUT /p/{profile}/v1/sessions/{encoded_session_id}/approval-mode; features.session_approval_control === true from /p/{profile}/v1/capabilities. GET and PUT respond {session_id, profile, enabled:boolean, scope:"session"}. PUT body is only {enabled:boolean}. GET before PUT must support session-before-first-run (default false), and GET after PUT must report committed state. Profile must be the exact named profile in the URL. Profile-less/default targets fail closed in this bounded UI feature.

Backend must atomically reject PUT during an active run (409), including work started outside CollectiveUI, serialize PUT with run admission, and enforce authentication/profile binding. Portal holds its existing per-user run admission lock while changing mode but cannot protect backend admission by itself. No global/profile config APIs are used. No live backend or credentials were accessible in this isolated checkout: coordinator must independently verify actual endpoint implementation and approval-core persistence before cutover.
