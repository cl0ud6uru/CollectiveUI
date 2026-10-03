import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { Pool } from "pg";
import { generate } from "otplib";
import { mkdir } from "node:fs/promises";
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@collective/webauthn-browser";

test.skip(process.env.LOCAL_MFA_BROWSER !== "1", "Explicit disposable factor browser installation required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-browser-factor-phrase!42";
const origin = "http://localhost:3100";
const headers = { origin };
const endpoint = "/api/auth/local-security";
const out = "/tmp/collective-mfa-screenshots";
async function clearThrottle() { await pool.query("DELETE FROM auth_throttle"); }
async function login(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(username);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account", exact: true }).click();
}
async function codeLogin(page: Page, username: string, code: string) {
  await login(page, username);
  await expect(page.getByText("Password verified.", { exact: false })).toBeVisible();
  await page.getByLabel("Use a recovery code").check();
  await page.getByLabel("Recovery code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(page).toHaveURL("/");
}
async function virtual(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, defaultBackupEligibility: true, defaultBackupState: true,
  } });
  return { cdp, authenticatorId };
}
async function directPasswordDenied(request: APIRequestContext, username: string) {
  const csrf = await (await request.get("/api/auth/csrf")).json();
  await request.post("/api/auth/callback/local", { headers, form: { csrfToken: csrf.csrfToken, username, password }, maxRedirects: 0 });
  expect(await (await request.get("/api/auth/session")).json()).toBeNull();
  expect((await request.get("/api/search?q=fixture")).status()).toBe(401);
}
async function requestAssertion(page: Page, options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
  return page.evaluate(async data => {
    const parsed = PublicKeyCredential.parseRequestOptionsFromJSON(data as unknown as Parameters<typeof PublicKeyCredential.parseRequestOptionsFromJSON>[0]);
    const credential = await navigator.credentials.get({ publicKey: parsed }) as PublicKeyCredential;
    return credential.toJSON();
  }, options) as Promise<AuthenticationResponseJSON>;
}
async function begin(page: Page) {
  const response = await page.request.post(endpoint, { headers, data: { action: "passkey-begin" } });
  expect(response.status()).toBe(200); return response.json();
}
async function finish(page: Page, flow: string, response: AuthenticationResponseJSON) {
  return page.request.post(endpoint, { headers, data: { action: "passkey-finish", flow, response } });
}
test.beforeAll(async () => {
  if (!process.env.DATABASE_URL?.endsWith("/collective_local_mfa_browser_test")) throw new Error("Dedicated disposable browser DB required");
  const { hashPassword } = await import("../../src/lib/auth/password");
  const hash = await hashPassword(password);
  await pool.query("DELETE FROM users WHERE id LIKE 'mfa-browser-%'");
  for (const user of ["totp", "passkey"]) {
    await pool.query("INSERT INTO users(id,upn,name,auth_source,identity_realm) VALUES ($1,$2,$3,'local','local')", [`mfa-browser-${user}`, `local:${user}-fixture`, `Synthetic ${user} fixture`]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ($1,$2,$3,false)", [`mfa-browser-${user}`, `${user}-fixture`, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ($1,$2)", [`${user}-fixture`, `mfa-browser-${user}`]);
  }
  await mkdir(out, { recursive: true });
});
test.beforeEach(clearThrottle);
test.afterAll(async () => { await pool.end(); });

test("TOTP enrollment, no preauth session, direct callback denial, single-use recovery and responsive UI", async ({ page, browser }) => {
  await login(page, "totp-fixture"); await expect(page).toHaveURL("/");
  await page.goto("/settings");
  const settingsNav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(settingsNav.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Account Security", exact: false })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Change local password", exact: true })).toHaveCount(0);
  await settingsNav.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page).toHaveURL("/settings?tab=security");
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  await settingsNav.getByRole("button", { name: "General", exact: true }).click();
  await expect(page).toHaveURL("/settings"); await expect(page.getByLabel("Theme", { exact: true })).toBeVisible();
  await page.goBack(); await expect(page).toHaveURL("/settings?tab=security");
  await expect(settingsNav.getByRole("button", { name: "Security", exact: true })).toHaveAttribute("aria-current", "page");
  await page.reload(); await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set up authenticator app", exact: true }).click();
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  const secret = await page.getByLabel("Manual setup key").inputValue();
  expect((await pool.query("SELECT totp_secret_enc FROM local_security WHERE user_id='mfa-browser-totp'")).rows[0].totp_secret_enc).toBeNull();
  await page.getByLabel("New authenticator code").fill(await generate({ secret }));
  await page.getByRole("button", { name: "Verify and activate" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes now" })).toBeVisible();
  let codes = await page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(10);
  // Changing sections must not discard the only display of the freshly issued recovery codes.
  await settingsNav.getByRole("button", { name: "General", exact: true }).click();
  await settingsNav.getByRole("button", { name: "Security", exact: true }).click();
  expect(await page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem").allTextContents()).toEqual(codes);
  expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
  const context = await browser.newContext();
  await directPasswordDenied(context.request, "totp-fixture"); await context.close();
  await clearThrottle();
  await login(page, "totp-fixture");
  await expect(page.getByLabel("Authenticator code", { exact: true })).toBeVisible();
  expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
  expect((await page.request.get("/api/search?q=fixture")).status()).toBe(401);
  const cookie = (await page.context().cookies()).find(c => c.name === "collective-preauth");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
  await page.getByLabel("Use a recovery code").check();
  await page.getByLabel("Recovery code", { exact: true }).fill(codes[0]);
  await page.getByRole("button", { name: "Verify and sign in" }).click(); await expect(page).toHaveURL("/");
  await page.goto("/account/security");
  await expect(page.getByText("9 recovery codes remaining.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove authenticator app", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/security-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Failed replay uses an independent client so an existing full session cannot mask the result.
  const replay = await browser.newContext(); const rp = await replay.newPage();
  await login(rp, "totp-fixture"); await rp.getByLabel("Use a recovery code").check();
  await rp.getByLabel("Recovery code", { exact: true }).fill(codes[0]); await rp.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(rp.getByRole("form", { name: "Local account" }).getByRole("alert")).toContainText("Unable to sign in");
  expect(await (await replay.request.get("/api/auth/session")).json()).toBeNull(); await replay.close();
  // Exactly one remaining code, no accessible authenticator: fresh codes permit actual recovery.
  await clearThrottle(); await page.context().clearCookies();
  const lastCode = codes[1];
  const lastHash = createHash("sha256").update(`recovery|mfa-browser-totp|${lastCode}`).digest("hex");
  await pool.query("DELETE FROM local_recovery_codes WHERE user_id='mfa-browser-totp' AND hash<>$1", [lastHash]);
  await login(page, "totp-fixture"); await page.getByLabel("Use a recovery code").check();
  await page.getByLabel("Recovery code", { exact: true }).fill(lastCode); await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(page.getByRole("heading", { name: "Save your new recovery codes" })).toBeVisible();
  codes = await page.getByRole("list", { name: "New recovery codes" }).getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(10); expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
  await page.getByLabel("I saved these new recovery codes securely").check();
  await page.getByRole("button", { name: "Continue to account" }).click(); await expect(page).toHaveURL("/");
  await page.goto("/account/security"); await page.getByRole("button", { name: "Regenerate recovery codes", exact: true }).click();
  await page.getByLabel("Current password", { exact: true }).fill(password); await page.getByLabel("Use a recovery code").check();
  await page.getByLabel("Recovery code", { exact: true }).fill(codes[0]); await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Security updated" })).toBeVisible();
  codes = await page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem").allTextContents();
  // Password reset restrictions keep factor-protected temporary users able to change password safely.
  await pool.query("UPDATE local_credentials SET must_change_password=true WHERE user_id='mfa-browser-totp'");
  await pool.query("UPDATE users SET session_version=session_version+1 WHERE id='mfa-browser-totp'");
  await clearThrottle(); await login(page, "totp-fixture");
  await page.getByLabel("Use a recovery code").check(); await page.getByLabel("Recovery code", { exact: true }).fill(codes[1]);
  await page.getByRole("button", { name: "Verify and sign in" }).click(); await expect(page).toHaveURL("/account/password");
  await expect(page.getByRole("button", { name: "Add passkey", exact: true })).toHaveCount(0);
  await page.getByLabel("New password", { exact: true }).fill("Synthetic-browser-replacement!43");
  await page.getByLabel("Confirm new password").fill("Synthetic-browser-replacement!43");
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByLabel("Use a recovery code").check(); await page.getByLabel("Recovery code", { exact: true }).fill(codes[2]);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Security updated" })).toBeVisible();
});

test("real virtual passkey registration and passwordless login; signed assertion adversarial boundaries", async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const { cdp, authenticatorId } = await virtual(page);
  await login(page, "passkey-fixture"); await expect(page).toHaveURL("/");
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/account/security");
  await expect(page).toHaveURL("/settings?tab=security");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add passkey", exact: true });
  const continueSetup = dialog.getByRole("button", { name: "Continue to passkey setup" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Current password", { exact: true })).toBeFocused();
  await expect(continueSetup).toBeInViewport();
  await expect(dialog.getByText("Enter the password you use to sign in to CollectiveUI.", { exact: false })).toBeVisible();
  // Focus stays in the modal; cancellation restores the trigger and clears entered secrets.
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await dialog.getByLabel("Current password", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const addPasskey = page.getByRole("button", { name: "Add passkey", exact: true });
  await expect(addPasskey).toBeFocused(); await addPasskey.click();
  await expect(dialog.getByLabel("Current password", { exact: true })).toHaveValue("");
  await page.screenshot({ path: `${out}/passkey-dialog-verify-mobile.png`, fullPage: true });
  await dialog.getByLabel("Current password", { exact: true }).fill(password); await continueSetup.click();
  await expect(dialog.getByRole("heading", { name: "Choose where to save your passkey" })).toBeFocused();
  expect((await pool.query("SELECT id FROM local_passkeys WHERE user_id='mfa-browser-passkey'")).rows).toHaveLength(0);
  await expect(dialog.getByRole("button", { name: "Create passkey", exact: true })).toBeDisabled();
  await dialog.getByLabel("Passkey name").fill("Cancelled setup");
  await page.keyboard.press("Escape"); await expect(addPasskey).toBeFocused(); await addPasskey.click();
  await expect(dialog.getByLabel("Current password", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Passkey name")).toHaveCount(0);
  await dialog.getByLabel("Current password", { exact: true }).fill(password); await continueSetup.click();
  await expect(dialog.getByLabel("Passkey name")).toHaveValue("");
  await dialog.getByLabel("Passkey name").fill("Synthetic platform passkey");
  await page.screenshot({ path: `${out}/passkey-dialog-create-mobile.png`, fullPage: true });
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  // Simulate closing the browser's native prompt once, then use the real virtual authenticator.
  await page.evaluate(() => {
    const create = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = async () => {
      navigator.credentials.create = create;
      throw new DOMException("Synthetic user cancellation", "NotAllowedError");
    };
  });
  await dialog.getByRole("button", { name: "Create passkey", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("verify your identity again to retry");
  await expect(dialog.getByLabel("Current password", { exact: true })).toHaveValue("");
  expect((await pool.query("SELECT id FROM local_passkeys WHERE user_id='mfa-browser-passkey'")).rows).toHaveLength(0);
  await dialog.getByLabel("Current password", { exact: true }).fill(password); await continueSetup.click();
  const registrationRequest = page.waitForRequest(r => r.url().endsWith("/api/account/security") && r.postDataJSON()?.action === "register-finish");
  await dialog.getByRole("button", { name: "Create passkey", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Security updated" })).toBeFocused();
  const registered = (await registrationRequest).postDataJSON();
  expect(registered.response.response.attestationObject).toBeTruthy();
  const codes = await page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem").allTextContents();
  const credentials = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials.credentials).toHaveLength(1);
  expect(credentials.credentials[0].isResidentCredential).toBe(true);
  // The private key belongs solely to Chromium's disposable virtual authenticator.
  // Re-sign hostile fixtures so each validation boundary is tested with a valid signature.
  const syntheticKey = createPrivateKey({ key: Buffer.from(credentials.credentials[0].privateKey, "base64"), format: "der", type: "pkcs8" });
  function resign(response: AuthenticationResponseJSON) {
    const signed = Buffer.concat([Buffer.from(response.response.authenticatorData, "base64url"), createHash("sha256").update(Buffer.from(response.response.clientDataJSON, "base64url")).digest()]);
    response.response.signature = sign(["ec", "rsa", "rsa-pss"].includes(syntheticKey.asymmetricKeyType!) ? "sha256" : null, signed, syntheticKey).toString("base64url");
  }
  expect((await pool.query("SELECT device_type,backed_up FROM local_passkeys WHERE user_id='mfa-browser-passkey'")).rows[0]).toEqual({ device_type: "multiDevice", backed_up: true });
  const anonymous = await browser.newContext(); await directPasswordDenied(anonymous.request, "passkey-fixture"); await anonymous.close();
  await clearThrottle();
  await page.goto("/login"); await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click(); await expect(page).toHaveURL("/");
  await page.goto("/account/security"); await expect(page.getByText("Synthetic platform passkey", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Synthetic platform passkey" })).toBeDisabled();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${out}/security-passkey-desktop.png`, fullPage: true });
  await addPasskey.click();
  await expect(dialog.getByLabel("Authenticator code", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Recovery code", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Use an existing passkey" }).click();
  await expect(dialog.getByRole("heading", { name: "Choose where to save your passkey" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(addPasskey).toBeFocused();
  // No cookie may be minted from any rejected ceremony. Clear the full session while retaining virtual key.
  await page.context().clearCookies(); await page.goto("/login");
  for (const mutate of ["origin", "challenge", "crossOrigin", "topOrigin", "userHandle", "signature", "rpId"]) {
    await clearThrottle(); const start = await begin(page); const response = await requestAssertion(page, start.options);
    if (mutate === "userHandle") response.response.userHandle = Buffer.from("another-user").toString("base64url");
    else if (mutate === "signature") response.response.signature = Buffer.alloc(64, 1).toString("base64url");
    else if (mutate === "rpId") { const data = Buffer.from(response.response.authenticatorData, "base64url"); data[0] ^= 1; response.response.authenticatorData = data.toString("base64url"); }
    else { const data = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString());
      if (mutate === "origin") data.origin = "https://evil.example";
      if (mutate === "challenge") data.challenge = "different-challenge";
      if (mutate === "crossOrigin") data.crossOrigin = true;
      if (mutate === "topOrigin") data.topOrigin = "https://evil.example";
      response.response.clientDataJSON = Buffer.from(JSON.stringify(data)).toString("base64url");
    }
    if (mutate !== "signature") resign(response);
    expect((await finish(page, start.flow, response)).status(), mutate).toBe(400);
    expect((await finish(page, start.flow, response)).status(), `${mutate} replay`).toBe(400);
    expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
  }
  // UV false with a valid signature, generated by the virtual authenticator.
  await clearThrottle(); await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  const noUV = await begin(page); noUV.options.userVerification = "discouraged";
  expect((await finish(page, noUV.flow, await requestAssertion(page, noUV.options))).status()).toBe(400);
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
  // Foreign binding and missing/foreign Origin cannot finish a legitimate signed assertion.
  await clearThrottle(); const start = await begin(page); const response = await requestAssertion(page, start.options);
  const foreign = await browser.newContext();
  expect((await foreign.request.post(`${origin}${endpoint}`, { headers, data: { action: "passkey-finish", flow: start.flow, response } })).status()).toBe(400); await foreign.close();
  for (const badHeaders of [{}, { origin: "https://evil.example" }]) expect((await page.request.post(endpoint, { headers: badHeaders as Record<string, string>, data: { action: "passkey-finish", flow: start.flow, response } })).status()).toBe(400);
  const parallel = await Promise.all([finish(page, start.flow, response), finish(page, start.flow, response)]);
  expect(parallel.map(r => r.status()).sort()).toEqual([200, 400]);
  const ticket = (await (await parallel.find(r => r.status() === 200)!).json()).ticket;
  // Completed factor proof is still not a session until the Auth.js CSRF-protected exchange.
  expect(await (await page.request.get("/api/auth/session")).json()).toBeNull();
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const tickets = await Promise.all([1, 2].map(() => page.request.post("/api/auth/callback/local", { headers, form: { csrfToken: csrf.csrfToken, ticket }, maxRedirects: 0 })));
  expect(tickets.filter(r => r.headers()["set-cookie"]?.includes("session-token"))).toHaveLength(1);
  // A sync-capable authenticator that always reports zero remains usable with fresh challenges.
  await page.context().clearCookies(); await clearThrottle();
  await pool.query("UPDATE local_passkeys SET counter=0 WHERE user_id='mfa-browser-passkey'");
  for (let i = 0; i < 2; i++) {
    const zero = await begin(page); const assertion = await requestAssertion(page, zero.options);
    const data = Buffer.from(assertion.response.authenticatorData, "base64url"); data.writeUInt32BE(0, 33);
    assertion.response.authenticatorData = data.toString("base64url"); resign(assertion);
    expect((await finish(page, zero.flow, assertion)).status()).toBe(200);
  }
  // A challenge signed before revocation fails; a fresh one and other-account revocation still work.
  await clearThrottle(); const revoked = await begin(page); const oldAssertion = await requestAssertion(page, revoked.options);
  await pool.query("UPDATE users SET session_version=session_version+1,auth_changed_at=clock_timestamp() WHERE id='mfa-browser-passkey'");
  expect((await finish(page, revoked.flow, oldAssertion)).status()).toBe(400);
  const fresh = await begin(page); const freshAssertion = await requestAssertion(page, fresh.options);
  await pool.query("UPDATE users SET session_version=session_version+1,auth_changed_at=clock_timestamp() WHERE id='mfa-browser-totp'");
  expect((await finish(page, fresh.flow, freshAssertion)).status()).toBe(200);
  // A nonzero counter regression is denied even with a correctly signed assertion.
  await page.context().clearCookies(); await clearThrottle();
  const storedCounter = (await pool.query("SELECT counter FROM local_passkeys WHERE user_id='mfa-browser-passkey'")).rows[0].counter;
  await pool.query("UPDATE local_passkeys SET counter=4294967295 WHERE user_id='mfa-browser-passkey'");
  const regressed = await begin(page);
  expect((await finish(page, regressed.flow, await requestAssertion(page, regressed.options))).status()).toBe(400);
  await pool.query("UPDATE local_passkeys SET counter=$1 WHERE user_id='mfa-browser-passkey'", [storedCounter]);
  // Disabled accounts cannot complete an otherwise valid signed assertion.
  await clearThrottle(); const disabled = await begin(page); const disabledResponse = await requestAssertion(page, disabled.options);
  await pool.query("UPDATE users SET disabled=true WHERE id='mfa-browser-passkey'");
  expect((await finish(page, disabled.flow, disabledResponse)).status()).toBe(400);
  await pool.query("UPDATE users SET disabled=false,session_version=session_version+1 WHERE id='mfa-browser-passkey'");
  // Recovery remains available without the virtual device.
  const recoveryContext = await browser.newContext(); const recoveryPage = await recoveryContext.newPage();
  await clearThrottle(); await codeLogin(recoveryPage, "passkey-fixture", codes[0]); await recoveryContext.close();
});
