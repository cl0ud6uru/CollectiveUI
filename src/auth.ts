import { randomUUID } from "node:crypto";
import { consumeLoginTicket } from "@/lib/auth/security";
import { assertSecurityOrigin, readBinding } from "@/lib/auth/factors";
import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { authenticateLdapPassword } from "@/lib/auth/ldap-account";
import { LdapUnavailableError, logLdapUnavailable } from "@/lib/auth/ldap";
import { db } from "@/db";
import { localSecurity, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hasLocalFactors } from "@/lib/auth/factor-state";
import { lockAccounts } from "@/lib/auth/local";
import { randomToken } from "@/lib/crypto";
import { syncUserOnSignIn } from "@/lib/auth/groups";
import { fetchEntraGroupsViaGraph, saveEntraTokens } from "@/lib/auth/entra";

import { entraEnabled, isAuthProvider, ldapEnabled, localEnabled } from "@/lib/auth/config";
import { authenticateLocal } from "@/lib/auth/local";
import { allowSecurityRequest } from "@/lib/auth/throttle";
import { sessionState, absoluteSessionDeadline } from "@/lib/auth/session-state";
import { admitWebSession, webSessionIdentity, webSessionRegistryEnabled } from "@/lib/auth/web-sessions";
import { commitHttpLogout, commitServerLogout, isHttpLogout } from "@/lib/auth/web-logout";
import { headers } from "next/headers";
import { NextRequest } from "next/server";
export { entraEnabled } from "@/lib/auth/config";

class InvalidLogin extends CredentialsSignin {
  code = "invalid_credentials";
}
class DirectoryUnavailable extends CredentialsSignin {
  code = "directory_unavailable";
}

const providers: NextAuthConfig["providers"] = [];

if (entraEnabled()) {
  const extraScopes = process.env.ENTRA_GRAPH_SCOPES ?? "";
  providers.push(
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      authorization: { params: { scope: `openid profile email offline_access User.Read ${extraScopes}`.trim() } },
    }),
  );
}

if (ldapEnabled()) {
  providers.push(
    Credentials({
      id: "ldap",
      name: "Company account",
      credentials: { ticket: { label: "Verified sign-in ticket" }, username: { label: "Username" }, password: { label: "Password", type: "password" } },
      async authorize(credentials, request) {
        if (!ldapEnabled()) throw new InvalidLogin();
        try {
          assertSecurityOrigin(request.headers);
          if (typeof credentials?.ticket === "string") {
            if (!await allowSecurityRequest(request.headers)) throw new InvalidLogin();
            return await consumeLoginTicket(credentials.ticket, readBinding(request.headers), "ldap");
          }
          const verified = await authenticateLdapPassword(String(credentials?.username ?? ""), String(credentials?.password ?? ""), request.headers);
          if (!verified) throw new InvalidLogin();
          return await db.transaction(async tx => {
            await lockAccounts(tx);
            const [user] = await tx.select().from(users).where(eq(users.id, verified.user.id));
            if (!user || user.disabled || user.sessionVersion !== verified.user.sessionVersion || await hasLocalFactors(user.id, tx)) throw new InvalidLogin();
            if (verified.identity.identity) {
              await tx.insert(localSecurity).values({ userId: user.id, userHandle: randomToken(), ldapDn: verified.identity.dn, ldapIdentity: verified.identity.identity })
                .onConflictDoUpdate({ target: localSecurity.userId, set: { ldapDn: verified.identity.dn, ldapIdentity: verified.identity.identity } });
            }
            return { id: user.id, name: user.name, email: user.email, sessionVersion: user.sessionVersion };
          });
        } catch (err) {
          if (err instanceof LdapUnavailableError) { logLdapUnavailable(err); throw new DirectoryUnavailable(); }
          throw new InvalidLogin();
        }
      },
    }),
  );
}

if (localEnabled()) {
  providers.push(Credentials({
    id: "local", name: "Local account",
    credentials: { ticket: { label: "Verified sign-in ticket" }, username: { label: "Username or email" }, password: { label: "Password", type: "password" } },
    async authorize(credentials, request) {
      try {
        assertSecurityOrigin(request.headers);
        if (typeof credentials?.ticket === "string" && !await allowSecurityRequest(request.headers)) throw new InvalidLogin();
        const user = typeof credentials?.ticket === "string"
          ? await consumeLoginTicket(credentials.ticket, readBinding(request.headers))
          : await authenticateLocal(credentials?.username, credentials?.password, request.headers);
        if (user) return user;
      } catch { /* Fail closed; never log credentials, hashes, SQL parameters or provider errors. */ }
      throw new InvalidLogin();
    },
  }));
}

const authConfig: NextAuthConfig = {
  providers,
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  pages: { signIn: "/login", error: "/login" },
  trustHost: true,
  logger: { error: () => console.warn("[auth] Sign-in/session request failed") },
  callbacks: {
    async jwt({ token, user, account, profile }) {
      if (account) { token.authSessionId = randomUUID(); token.authProvider = account.provider; token.signedInAt = Math.floor(Date.now() / 1000); }
      if (account?.provider === "microsoft-entra-id" && profile) {
        if (!entraEnabled()) return null;
        const p = profile as Record<string, unknown>;
        const upn = String(p.preferred_username ?? p.upn ?? p.email ?? "").toLowerCase();
        if (!upn) throw new Error("Entra profile has no UPN");
        let groupIds = Array.isArray(p.groups) ? (p.groups as string[]) : [];
        // Group overage: the token only says "go ask Graph".
        const claimNames = p._claim_names as Record<string, string> | undefined;
        if (!groupIds.length && claimNames?.groups && account.access_token) {
          groupIds = await fetchEntraGroupsViaGraph(account.access_token).catch(() => []);
        }
        const dbUser = await syncUserOnSignIn({
          upn,
          name: String(p.name ?? upn),
          email: typeof p.email === "string" ? p.email : undefined,
          source: "entra",
          groups: groupIds.map((id) => ({ externalId: id })),
        });
        if (dbUser.disabled) throw new Error("Account disabled");
        if (account.access_token) await saveEntraTokens(dbUser.id, account).catch(() => {});
        token.uid = dbUser.id;
        token.sessionVersion = dbUser.sessionVersion;
        token.name = dbUser.name;
        token.email = dbUser.email;
      } else if (user?.id) {
        token.uid = user.id;
        token.sessionVersion = user.sessionVersion;
      }
      const deadline = absoluteSessionDeadline(token);
      token.sessionDeadline = deadline;
      if (!token.uid || Date.now() / 1000 >= deadline) return null;
      const state = await sessionState(String(token.uid), token.sessionVersion, token.authProvider);
      if (!state) return null;
      if (webSessionRegistryEnabled()) {
        const identity = webSessionIdentity({ ...token, sessionVersion: token.sessionVersion ?? 0 });
        if (!identity || !await admitWebSession(identity)) return null;
      }
      token.mustChangePassword = state.mustChangePassword;
      return token;
    },
    async session({ session, token }) {
      if (token.uid) session.user.id = token.uid as string;
      session.user.sessionId = typeof token.authSessionId === "string" ? token.authSessionId : "";
      session.user.sessionVersion = Number(token.sessionVersion ?? 0);
      session.user.mustChangePassword = token.mustChangePassword === true;
      session.user.authProvider = isAuthProvider(token.authProvider) ? token.authProvider : null;
      return session;
    },
  },
};
const runtime = NextAuth(authConfig); // Auth.js fills cookie/secret defaults, including rotation, on this object.
export const auth = runtime.auth;
/** The logout route verifies the original cookie and commits before Auth.js may clear it. */
export const guardedHttpLogout = (req: Request) => webSessionRegistryEnabled() && isHttpLogout(req, authConfig);
export const authSessionCookieName = (req: Request) => authConfig.cookies?.sessionToken?.name ?? `${(authConfig.useSecureCookies ?? new URL(process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? req.url).protocol === "https:") ? "__Secure-" : ""}authjs.session-token`;
export const signIn = runtime.signIn;
export const handlers = {
  GET: runtime.handlers.GET,
  POST: async (req: NextRequest) => {
    if (!webSessionRegistryEnabled() || !isHttpLogout(req, authConfig)) return runtime.handlers.POST(req);
    try { return await runtime.handlers.POST(new NextRequest(await commitHttpLogout(req, authConfig))); }
    catch { return Response.json({ error: "Sign-out could not complete. Please retry." }, { status: 503, headers: { "Cache-Control": "private, no-store" } }); }
  },
};
export const signOut: typeof runtime.signOut = async options => {
  if (webSessionRegistryEnabled()) await commitServerLogout(new Headers(await headers()), authConfig);
  return runtime.signOut(options);
};
