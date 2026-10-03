import { randomUUID } from "node:crypto";
import { consumeLoginTicket } from "@/lib/auth/security";
import { assertSecurityOrigin, readBinding } from "@/lib/auth/factors";
import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { authenticateLdap, normalizeUsername } from "@/lib/auth/ldap";
import { syncUserOnSignIn } from "@/lib/auth/groups";
import { fetchEntraGroupsViaGraph, saveEntraTokens } from "@/lib/auth/entra";

import { entraEnabled, ldapEnabled, localEnabled } from "@/lib/auth/config";
import { authenticateLocal } from "@/lib/auth/local";
import { allowPasswordAttempt, allowAccountAttempt, allowSecurityRequest } from "@/lib/auth/throttle";
import { sessionState, absoluteSessionDeadline } from "@/lib/auth/session-state";
export { entraEnabled } from "@/lib/auth/config";

class InvalidLogin extends CredentialsSignin {
  code = "invalid_credentials";
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
      credentials: { username: { label: "Username" }, password: { label: "Password", type: "password" } },
      async authorize(credentials, request) {
        if (!ldapEnabled()) throw new InvalidLogin();
        const username = String(credentials?.username ?? "");
        const password = String(credentials?.password ?? "");
        if (username.length > 254 || password.length > 512 || !await allowPasswordAttempt("ldap", normalizeUsername(username).toLowerCase(), request.headers)) throw new InvalidLogin();
        let ldapUser;
        try {
          ldapUser = await authenticateLdap(username, password, undefined, dn => allowAccountAttempt("ldap-dn", dn.toLowerCase()));
        } catch {
          console.warn("[auth] LDAP authentication failed");
          throw new InvalidLogin();
        }
        if (!ldapUser) throw new InvalidLogin();
        const user = await syncUserOnSignIn({
          upn: ldapUser.upn,
          name: ldapUser.name,
          email: ldapUser.email,
          source: "ldap",
          groups: ldapUser.groups.map((g) => ({ externalId: g.dn, displayName: g.name })),
        });
        if (user.disabled) throw new InvalidLogin();
        return { id: user.id, name: user.name, email: user.email, sessionVersion: user.sessionVersion };
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

export const { handlers, auth, signIn, signOut } = NextAuth({
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
      token.mustChangePassword = state.mustChangePassword;
      return token;
    },
    async session({ session, token }) {
      if (token.uid) session.user.id = token.uid as string;
      session.user.sessionId = typeof token.authSessionId === "string" ? token.authSessionId : "";
      session.user.sessionVersion = Number(token.sessionVersion ?? 0);
      session.user.mustChangePassword = token.mustChangePassword === true;
      return session;
    },
  },
});
