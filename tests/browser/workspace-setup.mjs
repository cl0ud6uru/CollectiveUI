// Isolated component fixture: loopback server and a new browser. Never uses the live app, browser, DB or Docker.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const { chromium, expect } = require("@playwright/test");
const dir = await mkdtemp(path.join(tmpdir(), "workspace-setup-browser-"));
const output = process.env.WORKSPACE_SETUP_SCREENSHOT_DIR;
let browser, server;
const initial = { enabled: false, access: "selected", allowedGroupIds: [], allowedUpns: [], allowRunc: false, commandTimeoutSec: 120, outputKb: 32, deleteAfterDays: 30 };
const healthy = { ok: true, docker: { version: "fixture", apiVersion: "fixture" }, image: { present: true }, gvisor: { available: true }, defaultRuntime: "runsc", warnings: [] };
let settings = { ...initial }, mode = "missing", saves = [], failSave = false, checkCalls = 0;
try {
  const entry = path.join(dir, "entry.tsx");
  await writeFile(entry, `import React,{useState} from 'react';import {createRoot} from '${root}/node_modules/react-dom/client';import {SandboxAdmin} from '${root}/src/components/admin/sandbox-admin';import {workspaceSetupReport} from '${root}/src/lib/sandbox/setup';
  function App(){const [data,setData]=useState(window.fixture);window.fixtureRefresh=async()=>setData(await(await fetch('/state')).json());const setup=workspaceSetupReport({config:data.mode==='missing'?'missing_url':'configured',health:data.mode==='success'?${JSON.stringify(healthy)}:data.mode==='runc'?{...${JSON.stringify(healthy)},gvisor:{available:false},defaultRuntime:'runc'}:null,errorCode:data.mode==='failure'?'unauthorized':undefined,allowRunc:data.settings.allowRunc,checkedAt:'2026-10-07T05:00:00Z'});return <SandboxAdmin settings={data.settings} setup={setup} groups={[{id:'trusted',name:'Trusted pilot'}]} error={null} rows={[]} orphans={[]}/>};createRoot(document.getElementById('root')).render(<App/>);`);
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    nodePaths: [path.join(root, "node_modules")], alias: { "@": path.join(root, "src") }, plugins: [{ name: "fixture-actions", setup(b) {
      b.onResolve({ filter: /app\/admin\/actions$/ }, () => ({ path: "actions", namespace: "fixture" }));
      b.onResolve({ filter: /workspace-setup-actions$/ }, () => ({ path: "check", namespace: "fixture" }));
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "navigation"
        ? `export const useRouter=()=>({refresh:()=>window.fixtureRefresh()});`
        : args.path === "check" ? `import {workspaceSetupReport} from '${root}/src/lib/sandbox/setup';export async function checkWorkspaceSetup(){const r=await fetch('/check',{method:'POST'});if(!r.ok)throw new Error('CANARY_SECRET');const data=await r.json();return workspaceSetupReport({...data,allowRunc:data.settings.allowRunc})}`
        : `export async function saveSandboxSettings(value){const r=await fetch('/save',{method:'POST',body:JSON.stringify(value)});if(!r.ok)throw new Error('Workspace prerequisites are not ready. Run the setup check and resolve the failed steps before enabling access.')}export async function adminDestroyOrphan(){};export async function adminDestroySandbox(){};export async function adminStopSandbox(){}`,
        loader: "js", resolveDir: root }));
    } }] });
  const css = await require("postcss")([require("@tailwindcss/postcss")({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].contents); return; }
    if (url.pathname === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
    if (url.pathname === "/state") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ settings, mode })); return; }
    if (url.pathname === "/check") {
      checkCalls++; if (mode === "denied") { res.writeHead(403); res.end("{}"); return; }
      // Delay makes the pending/retry state observable without any external work.
      await new Promise(resolve => setTimeout(resolve, 200));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ config: mode === "missing" ? "missing_secret" : "configured", health: mode === "success" ? healthy : null,
        errorCode: mode === "failure" ? "unauthorized" : undefined, settings })); return;
    }
    if (url.pathname === "/save") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks)); saves.push(value);
      if (failSave) { res.writeHead(409); res.end("{}"); return; }
      settings = { ...settings, ...value }; res.end("{}"); return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main style="padding:24px;max-width:1000px;margin:auto"><p style="font-size:12px;color:#666">Isolated fixture · Admin</p><h1 style="font-size:24px;font-weight:600;margin-bottom:20px">Workspaces</h1><div id="root"></div></main><script>window.fixture=${JSON.stringify({ settings, mode })}</script><script src="/bundle.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const screenshot = async name => { if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true }); } };
  for (const width of [320, 390, 768, 1280]) {
    settings = { ...initial }; mode = "missing"; await page.setViewportSize({ width, height: 1000 }); await page.goto(base);
    await expect(page.getByRole("switch", { name: "Enable workspaces" })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Enable workspaces" })).toBeDisabled();
    const easy = page.getByRole("button", { name: "Easy setup" }); await easy.focus(); await page.keyboard.press("Enter");
    await expect(page.getByText("1. Prepare the Linux Docker host")).toBeVisible();
    await expect(page.getByText("SANDBOXD_RUNTIME=runsc", { exact: false })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Command time limit" })).toHaveValue("120");
    await expect(page.getByRole("spinbutton", { name: "Output kept" })).toHaveValue("32");
    await expect(page.getByRole("spinbutton", { name: "Retention days" })).toHaveValue("30");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(`missing-${width}`);
  }
  await page.getByRole("button", { name: "Copy commands" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: /Commands copied|Copy unavailable/ })).toBeVisible();
  mode = "failure"; await page.getByRole("button", { name: "Run setup check" }).click();
  await expect(page.getByRole("button", { name: "Checking…" })).toBeDisabled(); await screenshot("retry-pending");
  await expect(page.getByText("Authentication failed.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry setup check" })).toBeEnabled(); await screenshot("authentication-failure");
  mode = "denied"; await page.getByRole("button", { name: "Retry setup check" }).click();
  await expect(page.getByRole("alert")).toHaveText(/Confirm you are still an admin/); expect(await page.locator("body").innerText()).not.toContain("CANARY_SECRET");
  mode = "success"; await page.getByRole("button", { name: "Retry setup check" }).click();
  await expect(page.getByText("Service ready", { exact: true })).toBeVisible();
  await expect(page.getByText("Access off", { exact: true })).toBeVisible(); expect(saves).toHaveLength(0); await screenshot("prerequisites-success");
  await page.getByRole("textbox", { name: "Allowed people" }).fill("pilot@fixture.invalid");
  await page.getByRole("switch", { name: "Enable workspaces" }).click();
  const save = page.getByRole("button", { name: "Save workspace settings" }); await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: "Confirm workspace access" }).check(); await expect(save).toBeEnabled();
  await page.getByRole("combobox", { name: "Who gets a workspace" }).click(); await page.getByRole("option", { name: "Everyone", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Confirm workspace access" })).not.toBeChecked(); await expect(save).toBeDisabled();
  await page.getByRole("combobox", { name: "Who gets a workspace" }).click(); await page.getByRole("option", { name: "Selected groups and people", exact: true }).click();
  await page.getByRole("checkbox", { name: "Confirm workspace access" }).check();
  await page.getByRole("button", { name: "Trusted pilot", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Confirm workspace access" })).not.toBeChecked(); await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: "Confirm workspace access" }).check();
  failSave = true; await save.click(); await expect(page.getByRole("alert")).toHaveText(/Workspace prerequisites are not ready/);
  await expect(page.getByRole("textbox", { name: "Allowed people" })).toHaveValue("pilot@fixture.invalid"); await screenshot("save-failure");
  failSave = false; await save.click(); await expect(page.getByText("Access enabled", { exact: true })).toBeVisible();
  expect(saves.at(-1)).toMatchObject({ enabled: true, acknowledgeEnable: true, access: "selected", allowedGroupIds: ["trusted"], allowedUpns: ["pilot@fixture.invalid"], allowRunc: false, commandTimeoutSec: 120, outputKb: 32, deleteAfterDays: 30 });
  await screenshot("confirmed-access-success");
  // Refreshed setup props replace old manual-check readiness after changing the saved isolation policy.
  settings = { ...initial }; mode = "runc"; await page.goto(base);
  await expect(page.getByRole("switch", { name: "Enable workspaces" })).toBeDisabled();
  await page.getByRole("switch", { name: "Allow standard isolation" }).click(); await expect(save).toBeDisabled();
  await page.getByRole("checkbox").check(); await save.click();
  await expect(page.getByText("Service ready", { exact: true })).toBeVisible(); await expect(page.getByRole("switch", { name: "Enable workspaces" })).toBeEnabled();
  await page.getByRole("switch", { name: "Allow standard isolation" }).click(); await save.click();
  await expect(page.getByText("Setup needed", { exact: true })).toBeVisible(); await expect(page.getByRole("switch", { name: "Enable workspaces" })).toBeDisabled();
  expect(checkCalls).toBe(3); expect(errors).toEqual([]);
  console.log("Workspace setup fixture passed: 320/390/768/1280 layouts, keyboard/copy, missing config, auth failure, denied check, retry, readiness success, audience confirmation reset, save failure/retry, default limits/isolation, refreshed policy. No external requests or live mutations.");
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
}
