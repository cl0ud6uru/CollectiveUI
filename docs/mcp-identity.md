# Verifying the portal's identity header in your MCP server

When an admin turns on **Send each person's identity** for an MCP server (Admin → MCP servers → edit), every HTTP
request the portal makes to that server carries a short-lived signed token saying who is chatting. Your server can
use it to apply its own per-user permissions instead of trusting one shared key.

- **Header:** `X-Portal-Identity` by default (the admin can rename it). It is sent *next to* the server's static
  headers, so an existing `Authorization: Bearer …` key keeps working; check both.
- **Format:** a JWT signed with HS256. The key is the secret shown once when identity is turned on (use the string's
  UTF-8 bytes, which is what JWT libraries do with a string secret). "New secret" issues another one and subsequent
  portal requests use it. Update your server's verifier to accept the new secret and remove the old one; previously
  issued tokens remain verifiable until expiry wherever the old key is still accepted. Changing the server's URL
  also issues a new secret.
- **Lifetime:** 60 seconds. A fresh token is minted for every request.

## Tool approval identity

The portal's model-facing MCP names bind the server's immutable ID and exact raw tool name with a 128-bit SHA-256
suffix. Display names, punctuation normalization, truncation, catalog order and neighboring servers cannot transfer
a remembered approval to another tool. Renaming a server preserves the tool identity; the displayed title updates.
Connections are scoped to a turn's caller; they are never pooled between people.

New "Always allow" grants are stored in a separate `mcp:` namespace. Earlier alias-based grants are intentionally
ignored: approve the desired tool again, and remove obsolete entries in Settings → Tool approvals. Settings shows
the current server and tool labels when the server and its snapshot remain accessible. Existing organization rules
using old aliases remain restrictive, including possible numeric collision suffixes; an ambiguous rule can require
approval for more than one matching tool. Prefer `mcp:<serverId>`, the current stable tool name, or per-tool server
policy for new organization rules. Migrate old display-name rules before renaming a server: those compatibility
rules use the current display name and do not track earlier names.

Pending chat approvals issued under the old tool mapping fail signature validation after upgrade; start a new turn
to review them again. Web, iOS and macOS use the tool's readable title for direct approval cards. Standing-grant
management remains in web Settings; no native grant-management API is added.

## Claims

| Claim | Meaning |
|---|---|
| `iss` | `ai-portal` |
| `aud` | the server URL exactly as configured in the portal, e.g. `https://mcp.internal/jira/mcp` |
| `sub` | the portal user id, or `portal:system` when the portal lists your tools (Test and the hourly refresh) |
| `upn` | the person's user principal name (lower case), e.g. `alice@corp.local` |
| `email`, `name` | as known to the portal (email may be missing) |
| `groups` | the person's portal group names |
| `bot`, `conv` | the bot and conversation the call comes from |
| `system` | `true` on the portal's own calls (no person) |
| `service` | Present for an admin-published service capability: exact bot/grant revision, server/tool and call context; see [service bot identity](service-bots.md#enforcement-and-identity) |
| `iat`, `exp`, `jti` | issued at, expiry (iat + 60), unique id |

Always check the signature, `exp`, `iss` **and `aud`** (a token minted for another server must not work on yours).
Treat `sub: portal:system` as "the portal itself": it only lists tools; decide whether your server lists the same
tools for it as for people (the portal compares each listing with the last one and flags changes for review).

## Node.js (jose)

```js
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.PORTAL_IDENTITY_SECRET);

export async function portalUser(req) {
  const token = req.headers["x-portal-identity"];
  if (!token) return null;
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ["HS256"],
    issuer: "ai-portal",
    audience: "https://mcp.internal/jira/mcp", // this server's URL as registered in the portal
    requiredClaims: ["exp", "iat", "sub"],
    maxTokenAge: "90s",
  });
  return payload; // { sub, upn, email, name, groups, bot, conv, ... }
}
```

## Python (PyJWT)

```python
import jwt

def portal_user(headers):
    token = headers.get("x-portal-identity")
    if not token:
        return None
    return jwt.decode(
        token,
        PORTAL_IDENTITY_SECRET,  # the secret string
        algorithms=["HS256"],
        issuer="ai-portal",
        audience="https://mcp.internal/jira/mcp",
        options={"require": ["exp", "iat", "sub"]},
    )
```

## .NET (System.IdentityModel.Tokens.Jwt)

```csharp
var handler = new JwtSecurityTokenHandler();
var principal = handler.ValidateToken(token, new TokenValidationParameters
{
    ValidIssuer = "ai-portal",
    ValidAudience = "https://mcp.internal/jira/mcp",
    IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret)),
    ValidAlgorithms = new[] { SecurityAlgorithms.HmacSha256 },
    ClockSkew = TimeSpan.FromSeconds(30),
}, out _);
var upn = principal.FindFirst("upn")?.Value;
```

`dev/mcp-echo/server.mjs` has a dependency-free verifier (`verifyIdentity`) and a `whoami` tool that reports the
caller; run it with `MCP_IDENTITY_SECRET=<secret> MCP_IDENTITY_AUDIENCE=<url> MCP_REQUIRE_IDENTITY=true`.

## What the portal guarantees

- Tokens and static headers go only to the server's own origin; redirects are refused, so neither is replayed to
  another host.
- The secret is stored encrypted, bound to the server's row, and never sent to browsers after it is first shown.
- Bots only see the tools an admin accepted (Test, then Enable). If your tool list, a description or an annotation
  changes, the changed tools are hidden until an admin reviews and accepts the change.
