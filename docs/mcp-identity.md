# Verifying the portal's identity header in your MCP server

When an admin turns on **Send each person's identity** for an MCP server (Admin → MCP servers → edit), every HTTP
request the portal makes to that server carries a short-lived signed token saying who is chatting. Your server can
use it to apply its own per-user permissions instead of trusting one shared key.

- **Header:** `X-Portal-Identity` by default (the admin can rename it). It is sent *next to* the server's static
  headers, so an existing `Authorization: Bearer …` key keeps working; check both.
- **Format:** a JWT signed with HS256. The key is the secret shown once when identity is turned on (use the string's
  UTF-8 bytes, which is what JWT libraries do with a string secret). "New secret" issues another one; the old one
  stops working at once. Changing the server's URL also issues a new secret.
- **Lifetime:** 60 seconds. A fresh token is minted for every request.

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
