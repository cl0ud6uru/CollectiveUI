import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild"), { chromium, expect } = require("@playwright/test");
const postcss = require("postcss"), tailwind = require("@tailwindcss/postcss");
const dir = await mkdtemp(path.join(tmpdir(), "collective-first-run-"));
let browser, server;
try {
  const entry = path.join(dir, "entry.tsx"), actions = path.join(dir, "actions.ts"), ldap = path.join(dir, "ldap.ts"), navigation = path.join(dir, "navigation.ts"), auth = path.join(dir, "auth.ts"), entra = path.join(dir, "entra.ts");
  await writeFile(actions, "export const deleteGroup=async()=>{};");
  await writeFile(ldap, `const post=async(path,body)=>(await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
export const findLdapUserForGroup=username=>post('/fixture/lookup',{username});export const saveGroupWithFeedback=input=>post('/fixture/save',input);`);
  await writeFile(navigation, "export const useRouter=()=>({refresh(){}});");
  await writeFile(auth, "export const signIn=async()=>({ok:false,error:'CredentialsSignin',code:'directory_unavailable'});");
  await writeFile(entra, "export const entraLogin=async()=>{};");
  await writeFile(entry, `import React from 'react';import {createRoot} from '${root}/node_modules/react-dom/client';import {Toaster} from 'sonner';
import {GroupsAdmin} from '${root}/src/components/admin/groups-admin';import {LoginForm} from '${root}/src/app/login/login-form';
const users=['local','directory'].map(identityRealm=>({id:identityRealm,name:'Matching Alice',upn:'alice@fixture.invalid',email:'alice@fixture.invalid',disabled:false,identityRealm}));
createRoot(document.getElementById('root')).render(location.pathname==='/login'?<LoginForm callbackUrl='/' entra={false} ldap/>:<><GroupsAdmin groups={[]} known={[]} users={users} ldapEnabled/><Toaster/></>);`);
  const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic", nodePaths: [path.join(root, "node_modules")],
    alias: { "@": path.join(root, "src"), "@/app/admin/actions": actions, "@/app/admin/groups/ldap-actions": ldap, "@/app/login/actions": entra, "next/navigation": navigation, "next-auth/react": auth },
    plugins: [{ name: "relative-login-actions", setup(build) { build.onResolve({ filter: /^\.\/actions$/ }, () => ({ path: entra })); } }],
  });
  const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
  let lookupMode = "missing", saveMode = "outage", loginMode = "outage";
  const saves = [], lookups = [];
  server = createServer(async (req, res) => {
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].contents); return; }
    if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
    if (req.method === "POST") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); res.setHeader("Content-Type", "application/json");
      if (req.url === "/fixture/lookup") {
        lookups.push(body); res.end(JSON.stringify(lookupMode === "missing" ? { ok: false, error: "No unique active LDAP user found. Use their exact username or UPN." }
          : { ok: true, member: { username: body.username, upn: "alice@fixture.invalid", name: "Directory Alice", email: null } })); return;
      }
      if (req.url === "/fixture/save") { saves.push(body); res.end(JSON.stringify(saveMode === "outage" ? { ok: false, error: "LDAP lookup failed. Check directory connection, TLS certificate and service-account settings." } : { ok: true })); return; }
      if (req.url === "/api/auth/ldap-security") { res.statusCode = loginMode === "outage" ? 503 : 200; res.end(JSON.stringify(loginMode === "outage" ? { error: "generic", code: "directory_unavailable" } : { ticket: "synthetic-only" })); return; }
      res.statusCode = 404; res.end("{}"); return;
    }
    res.setHeader("Content-Type", "text/html"); res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main style="padding:16px;max-width:900px;margin:auto"><div id="root"></div></main><script src="/bundle.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 1100 }); await page.goto(base);
    await page.getByRole("button", { name: "New group" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Local account", { exact: false })).toBeVisible();
    await expect(dialog.getByText("Directory account", { exact: false })).toBeVisible();
    await dialog.getByRole("textbox", { name: "LDAP username or UPN" }).fill("alice");
    await dialog.getByRole("button", { name: "Add LDAP user", exact: true }).click();
    await expect(page.getByText("No unique active LDAP user found. Use their exact username or UPN.")).toBeVisible();
    expect(saves).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const dialog = page.getByRole("dialog"); lookupMode = "success";
  await dialog.getByRole("button", { name: "Add LDAP user", exact: true }).click();
  await expect(dialog.getByText("Directory Alice", { exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Helpdesk");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("LDAP lookup failed. Check directory connection, TLS certificate and service-account settings.")).toBeVisible();
  await expect(dialog).toBeVisible(); expect(saves[0].ldapUsernames).toEqual(["alice"]); expect(saves[0]).not.toHaveProperty("ldapMembers");
  saveMode = "success"; await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(lookups.every(item => item.username === "alice")).toBe(true);
  for (const mode of ["outage", "ticket"]) {
    loginMode = mode; await page.goto(`${base}/login`);
    await page.getByRole("textbox", { name: "Company username" }).fill("alice");
    await page.getByLabel("Password", { exact: true }).fill("synthetic-only");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Can't reach the company directory right now.");
    if (mode === "outage") {
      await page.getByRole("button", { name: "Sign in with a company passkey", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Can't reach the company directory right now.");
    }
  }
  expect(errors).toEqual([]);
  console.log("First-run LDAP browser checks passed: 320–1280px, distinct realms, lookup/save feedback, password/passkey outage and ticket outage; synthetic HTTP only.");
} finally { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); await rm(dir, { recursive: true, force: true }); }
