import { randomBytes, createHash } from "node:crypto";
import { ISSUER, RESOURCE, discovery, jsonRequest } from "./http.mjs";
import { createLocalJWKSet, jwtVerify } from "jose";
export async function exchange(a, q, options = {}) {
  const { code, client_id } = consume(a, q);
  const received = Date.now();
  const t = await jsonRequest(
    options.tokenEndpoint ?? `${ISSUER}/api/accounts/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        code,
        code_verifier: a.verifier,
        redirect_uri: a.redirect,
        resource: RESOURCE,
      }).toString(),
    },
    options,
  );
  const metadata = await discovery(options);
  const jwksURL = new URL(metadata.jwks_uri);
  if (!options.issuerBase && jwksURL.protocol !== "https:")
    throw Error("Unsafe JWKS URI");
  const keys = await jsonRequest(jwksURL.href, {}, options);
  let identity;
  try {
    ({ payload: identity } = await jwtVerify(
      t.id_token,
      createLocalJWKSet(keys),
      {
        issuer: ISSUER,
        audience: client_id,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub", "nonce"],
      },
    ));
  } catch {
    throw Error("ID token verification failed");
  }
  if (
    identity.nonce !== a.nonce ||
    !identity.sub ||
    (a.saved && identity.sub !== a.saved.subject)
  )
    throw Error("ID token identity or nonce mismatch");
  const scopes =
    typeof t.scope === "string" ? t.scope.split(/\s+/).filter(Boolean) : [];
  if (!scopes.includes("chatgpt.tokens.use.direct"))
    throw Error("ChatGPT plan permission not granted");
  if (
    typeof t.access_token !== "string" ||
    !t.access_token ||
    t.token_type?.toLowerCase() !== "bearer" ||
    !Number.isFinite(t.expires_in) ||
    t.expires_in <= 0
  )
    throw Error("Invalid token response");
  return {
    issuer: ISSUER,
    subject: identity.sub,
    email: identity.email,
    client_id,
    ext_agent_host_id: a.host,
    id_token: t.id_token,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    token_type: t.token_type,
    scopes,
    expires_in: t.expires_in,
    expires_at: received + t.expires_in * 1000,
    saved_at: new Date(received).toISOString(),
  };
}
const random = () => randomBytes(32).toString("base64url");
export function attempt({ host, redirect, saved = null, timeoutMs = 180000 }) {
  const a = {
    host,
    redirect,
    saved,
    state: random(),
    nonce: random(),
    verifier: random(),
    deadline: Date.now() + timeoutMs,
    consumed: false,
  };
  const u = new URL(`${ISSUER}/api/accounts/authorize`);
  const params = {
    client_id: saved?.client_id ?? "dynamic_agent_client",
    ext_agent_host_id: host,
    response_type: "code",
    redirect_uri: redirect,
    scope:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: RESOURCE,
    state: a.state,
    nonce: a.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(a.verifier).digest("base64url"),
  };
  if (!saved) params.agent_name_hint = "CollectiveUI";
  if (saved?.id_token) params.id_token_hint = saved.id_token;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  a.url = u.href;
  return a;
}
export function consume(a, q) {
  if (a.consumed) throw Error("Authorization attempt already consumed");
  if (q.getAll("state").length !== 1 || q.get("state") !== a.state)
    throw Error("Invalid callback state");
  a.consumed = true;
  if (Date.now() >= a.deadline) throw Error("Authorization attempt expired");
  if (q.has("error")) throw Error("Authorization denied or failed");
  if (q.getAll("code").length !== 1 || !q.get("code"))
    throw Error("Missing authorization code");
  const supplied = q.get("client_id");
  if (q.getAll("client_id").length > 1)
    throw Error("Ambiguous issued client ID");
  if (a.saved) {
    if (q.has("client_id") && supplied !== a.saved.client_id)
      throw Error("Returning client ID mismatch");
    return { code: q.get("code"), client_id: a.saved.client_id };
  }
  if (!supplied || supplied === "dynamic_agent_client")
    throw Error("Missing issued client ID");
  return { code: q.get("code"), client_id: supplied };
}
