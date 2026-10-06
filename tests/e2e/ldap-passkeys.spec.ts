import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { Client, Change, Attribute } from "ldapts";
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@collective/webauthn-browser";

test.skip(process.env.LDAP_PASSKEY_BROWSER !== "1", "Requires explicitly disposable LDAP passkey installation");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = process.env.BASE_URL ?? "http://localhost:3109";
const headers = { origin }, endpoint = "/api/auth/ldap-security";
const dn = "uid=alice,ou=people,dc=corp,dc=local";
async function restoreMemberships(ldap: Client) {
  for (const groupDn of ["cn=Engineering,ou=groups,dc=corp,dc=local", "cn=AI Admins,ou=groups,dc=corp,dc=local"]) {
    const { searchEntries } = await ldap.search(groupDn, { scope: "base", attributes: ["member"] });
    const member = searchEntries[0].member;
    const values = Array.isArray(member) ? member.map(String) : [String(member)];
    if (!values.some(value => value.toLowerCase() === dn)) await ldap.modify(groupDn, new Change({ operation: "add", modification: new Attribute({ type: "member", values: [dn] }) }));
  }
}
async function clearThrottle() { await pool.query("DELETE FROM auth_throttle"); }
async function passwordLogin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Company username").fill("alice");
  await page.getByLabel("Password", { exact: true }).fill("Passw0rd!");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}
async function assertion(page: Page, options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
  return page.evaluate(async data => {
    const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(data as unknown as Parameters<typeof PublicKeyCredential.parseRequestOptionsFromJSON>[0]);
    return (await navigator.credentials.get({ publicKey }) as PublicKeyCredential).toJSON();
  }, options) as Promise<AuthenticationResponseJSON>;
}
async function begin(page: Page, path = endpoint) {
  const response = await page.request.post(path, { headers, data: { action: "passkey-begin" } });
  expect(response.status()).toBe(200); return response.json();
}
async function exchange(page: Page, ticket: string, provider = "ldap") {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  return page.request.post(`/api/auth/callback/${provider}`, { headers, form: { csrfToken: csrf.csrfToken, ticket }, maxRedirects: 0 });
}
test.beforeAll(async () => {
  if (!process.env.DATABASE_URL?.endsWith("/collective_ldap_passkey_browser_test") || process.env.LDAP_URL !== "ldap://localhost:13899")
    throw new Error("Dedicated disposable browser database and directory required");
  await pool.query("DELETE FROM users WHERE upn='alice@corp.local'");
  const ldap = new Client({ url: process.env.LDAP_URL! });
  try { await ldap.bind("cn=admin,dc=corp,dc=local", "adminpw"); await restoreMemberships(ldap); }
  finally { await ldap.unbind(); }
});
test.afterAll(async () => { await pool.end(); });

test("LDAP enrollment, real passwordless assertions, recovery, provider isolation and directory lifecycle checks", async ({ page, browser }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    defaultBackupEligibility: true, defaultBackupState: true } });
  await clearThrottle(); await passwordLogin(page); await expect(page).toHaveURL(`${origin}/`);
  await page.goto("/settings?tab=security");
  await expect(page.getByRole("button", { name: "Change password", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Set up authenticator app", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add passkey", exact: true });
  await dialog.getByLabel("Current company password").fill("Passw0rd!");
  await dialog.getByRole("button", { name: "Continue to passkey setup" }).click();
  await dialog.getByLabel("Passkey name").fill("Synthetic LDAP passkey");
  await dialog.getByRole("button", { name: "Create passkey", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes now" })).toBeVisible();
  const codes = await page.getByRole("list", { name: "Recovery codes", exact: true }).getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(10);
  const [user] = (await pool.query("SELECT * FROM users WHERE upn='alice@corp.local'")).rows;
  expect((await pool.query("SELECT * FROM local_credentials WHERE user_id=$1", [user.id])).rows).toHaveLength(0);
  const [profile] = (await pool.query("SELECT * FROM local_security WHERE user_id=$1", [user.id])).rows;
  expect(profile.ldap_dn).toBe(dn); expect(profile.ldap_identity).toMatch(/^[a-f0-9]{64}$/);
  expect(profile.totp_secret_enc).toBeNull();
  await page.context().clearCookies(); await clearThrottle();

  // Protected company passwords cannot issue a session through the direct Auth.js callback.
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  await page.request.post("/api/auth/callback/ldap", { headers, form: { csrfToken: csrf.csrfToken, username: "alice", password: "Passw0rd!" }, maxRedirects: 0 });
  expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
  await clearThrottle(); await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with a company passkey" }).click();
  await expect(page).toHaveURL(`${origin}/`);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);

  // A new browser without the passkey can recover only with company password plus saved code.
  const context = await browser.newContext(); const recoveryPage = await context.newPage();
  await clearThrottle(); await passwordLogin(recoveryPage);
  await expect(recoveryPage.getByText("Company password verified.", { exact: false })).toBeVisible();
  expect(await (await recoveryPage.request.get("/api/auth/session")).json()).toBeNull();
  await recoveryPage.getByLabel("Recovery code", { exact: true }).fill(codes[0]);
  await recoveryPage.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(recoveryPage).toHaveURL(`${origin}/`); await context.close();
  await page.context().clearCookies(); await clearThrottle(); await page.goto("/login");

  // Credential and ticket exchanges are bound to LDAP, even with local sign-in enabled.
  const wrong = await begin(page, "/api/auth/local-security");
  const wrongAssertion = await assertion(page, wrong.options);
  expect((await page.request.post("/api/auth/local-security", { headers, data: { action: "passkey-finish", flow: wrong.flow, response: wrongAssertion } })).status()).toBe(400);
  const right = await begin(page), rightAssertion = await assertion(page, right.options);
  const verified = await page.request.post(endpoint, { headers, data: { action: "passkey-finish", flow: right.flow, response: rightAssertion } });
  expect(verified.status()).toBe(200);
  const ticket = (await verified.json()).ticket;
  expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
  await exchange(page, ticket, "local");
  expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();

  // Directory groups are refreshed when the LDAP passkey is verified.
  const ldap = new Client({ url: process.env.LDAP_URL! });
  await ldap.bind("cn=admin,dc=corp,dc=local", "adminpw");
  const groupDn = "cn=Engineering,ou=groups,dc=corp,dc=local";
  await ldap.modify(groupDn, new Change({ operation: "delete", modification: new Attribute({ type: "member", values: [dn] }) }));
  let groupTicket: string;
  try {
    await clearThrottle(); const group = await begin(page);
    const verifiedGroup = await page.request.post(endpoint, { headers, data: { action: "passkey-finish", flow: group.flow, response: await assertion(page, group.options) } });
    expect(verifiedGroup.status()).toBe(200);
    groupTicket = (await verifiedGroup.json()).ticket;
    expect((await pool.query("SELECT * FROM user_external_groups WHERE user_id=$1 AND source='ldap' AND external_id=$2", [user.id, groupDn.toLowerCase()])).rows).toHaveLength(0);
  } finally { await ldap.modify(groupDn, new Change({ operation: "add", modification: new Attribute({ type: "member", values: [dn] }) })); }

  // Directory deletion/recreation at the same DN cannot inherit the old passkey.
  const pending = await begin(page), pendingAssertion = await assertion(page, pending.options);
  await ldap.del(dn);
  try {
    await exchange(page, groupTicket!);
    expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
    expect((await page.request.post(endpoint, { headers, data: { action: "passkey-finish", flow: pending.flow, response: pendingAssertion } })).status()).toBe(400);
  } finally {
    await ldap.add(dn, { objectClass: ["inetOrgPerson"], uid: "alice", cn: "Alice Admin", sn: "Admin", displayName: "Alice Admin", mail: "alice@corp.local", userPassword: "Passw0rd!" });
    await restoreMemberships(ldap);
  }
  await clearThrottle(); const replaced = await begin(page);
  expect((await page.request.post(endpoint, { headers, data: { action: "passkey-finish", flow: replaced.flow, response: await assertion(page, replaced.options) } })).status()).toBe(400);
  expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
  await ldap.unbind();
});
