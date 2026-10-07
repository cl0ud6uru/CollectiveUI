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
const dir = await mkdtemp(path.join(tmpdir(), "decisions-browser-"));
let browser, server;
try {
  const entry = path.join(dir, "entry.tsx");
  await writeFile(entry, `import React from 'react';import {createRoot} from '${root}/node_modules/react-dom/client';import {DecisionsForm} from '${root}/src/components/admin/decisions-form';const revoked=location.pathname==='/revoked';createRoot(document.getElementById('root')).render(<DecisionsForm initial={{queenRouting:revoked,skillPicking:revoked,toolShortlisting:revoked,providerAppId:revoked?'old':null}} providers={location.pathname==='/'?[{id:'api',name:'Company OpenAI API'}]:[]}/>);`);
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    nodePaths: [path.join(root, "node_modules")], alias: { "@": path.join(root, "src") }, plugins: [{ name: "fixture-actions", setup(b) {
      b.onResolve({ filter: /decisions-actions$/ }, () => ({ path: "actions", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `export async function saveDecisionsSettings(value){const r=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});if(!r.ok)throw new Error('Fixture provider unavailable');}`, loader: "js" }));
    } }] });
  const css = await require("postcss")([require("@tailwindcss/postcss")({ base: root })]).process(
    await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
  const saves = []; let failSave = false;
  server = createServer(async (req, res) => {
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].contents); return; }
    if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
    if (req.url === "/save") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      saves.push(JSON.parse(Buffer.concat(chunks).toString())); res.statusCode = failSave ? 409 : 200; res.end("{}"); return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main style="padding:16px;max-width:900px;margin:auto"><h1>Admin · Bots & tools</h1><div id="root"></div></main><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 960 }); await page.goto(base);
    const toggle = page.getByRole("checkbox", { name: "Queen bot routing" });
    const skillToggle = page.getByRole("checkbox", { name: "Skill picking" });
    const toolsToggle = page.getByRole("checkbox", { name: "Tool shortlisting" });
    await expect(toggle).not.toBeVisible();
    await page.locator("summary").focus(); await page.keyboard.press("Enter");
    await expect(toggle).not.toBeChecked(); await expect(toggle).toBeDisabled();
    await expect(skillToggle).not.toBeChecked(); await expect(skillToggle).toBeDisabled();
    await expect(toolsToggle).not.toBeChecked(); await expect(toolsToggle).toBeDisabled();
    await page.getByRole("combobox", { name: "Decisions API connection" }).click();
    await page.getByRole("option", { name: "Company OpenAI API", exact: true }).click(); await expect(toggle).toBeEnabled();
    await toggle.check(); await page.getByRole("button", { name: "Save Decisions settings" }).click();
    await expect(page.getByRole("status")).toHaveText("Decisions settings saved.");
    expect(saves.at(-1)).toEqual({ queenRouting: true, skillPicking: false, toolShortlisting: false, providerAppId: "api" });
    await toggle.uncheck(); await skillToggle.check(); await page.getByRole("button", { name: "Save Decisions settings" }).click();
    await expect(page.getByRole("status")).toHaveText("Decisions settings saved.");
    expect(saves.at(-1)).toEqual({ queenRouting: false, skillPicking: true, toolShortlisting: false, providerAppId: "api" });
    await skillToggle.uncheck(); await toolsToggle.check(); await page.getByRole("button", { name: "Save Decisions settings" }).click();
    await expect(page.getByRole("status")).toHaveText("Decisions settings saved.");
    expect(saves.at(-1)).toEqual({ queenRouting: false, skillPicking: false, toolShortlisting: true, providerAppId: "api" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.DECISIONS_SCREENSHOT_DIR) {
      await mkdir(process.env.DECISIONS_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.DECISIONS_SCREENSHOT_DIR, `decisions-${width}.png`), fullPage: true });
    }
  }
  failSave = true; await page.getByRole("checkbox", { name: "Tool shortlisting" }).uncheck(); await page.getByRole("button", { name: "Save Decisions settings" }).click();
  await expect(page.getByRole("alert")).toHaveText("Fixture provider unavailable"); await expect(page.getByRole("checkbox", { name: "Tool shortlisting" })).not.toBeChecked();
  failSave = false; await page.goto(`${base}/revoked`); await page.locator("summary").click();
  for (const name of ["Queen bot routing", "Skill picking", "Tool shortlisting"]) {
    await expect(page.getByRole("checkbox", { name })).toBeEnabled(); await page.getByRole("checkbox", { name }).uncheck();
  }
  await page.getByRole("button", { name: "Save Decisions settings" }).click(); await expect(page.getByRole("status")).toBeVisible();
  expect(saves.at(-1)).toEqual({ queenRouting: false, skillPicking: false, toolShortlisting: false, providerAppId: "old" });
  await page.goto(`${base}/empty`); await page.locator("summary").click();
  for (const name of ["Queen bot routing", "Skill picking", "Tool shortlisting"]) await expect(page.getByRole("checkbox", { name })).toBeDisabled();
  await expect(page.getByText("Add a company OpenAI API connection in Models first.", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
  console.log("Decisions settings: independent default-off Queen/skills/tools switches, keyboard expansion, provider selection, save/failure, revoked off switches, unsupported provider, and 320/390/768/1280 layouts passed.");
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
