// Isolated browser fixture: local component bundle only, with stubbed actions and no live database.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const { chromium, expect } = require("@playwright/test");
const dir = await mkdtemp(path.join(tmpdir(), "workspace-template-catalog-browser-"));
let browser, server;
let templates = [];
const profiles = [
  { key: "knowledge-work-v1", label: "Knowledge Work", seedBundleKeys: ["knowledge-work"], capabilities: { shell: true, officeHeadless: true, dotnet: false, agentBrowserView: false } },
  { key: "dotnet-linux-v1", label: ".NET Linux", seedBundleKeys: ["dotnet-linux-starter"], capabilities: { shell: true, officeHeadless: false, dotnet: true, agentBrowserView: false } },
];
const recipe = { schemaVersion: 1, runtimeProfileKey: "knowledge-work-v1", seedBundleKey: "knowledge-work", networkPolicy: "none", capabilities: { shell: true, officeHeadless: true, dotnet: false, agentBrowserView: false } };
const calls = [];

try {
  const entry = path.join(dir, "entry.tsx");
  await writeFile(entry, `import React,{useState} from 'react';import{createRoot}from'${root}/node_modules/react-dom/client';import{WorkspaceTemplateCatalog}from'${root}/src/components/admin/workspace-template-catalog';
  const profiles=${JSON.stringify(profiles)};function App(){const[data,setData]=useState(window.fixture);window.fixtureRefresh=async()=>setData(await(await fetch('/state')).json());return <WorkspaceTemplateCatalog templates={data.templates} profiles={profiles}/>};createRoot(document.getElementById('root')).render(<App/>);`);

  const bundle = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    nodePaths: [path.join(root, "node_modules")], alias: { "@": path.join(root, "src") },
    plugins: [{ name: "catalog-fixture-actions", setup(builder) {
      builder.onResolve({ filter: /app\/admin\/workspace-templates\/actions$/ }, () => ({ path: "actions", namespace: "fixture" }));
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
        contents: args.path === "navigation"
          ? `export const useRouter=()=>({refresh:()=>window.fixtureRefresh()});`
          : `async function send(kind,value){const r=await fetch('/mutate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,value})});return r.json()}
            export async function createWorkspaceTemplateDraft(form){return send('create',Object.fromEntries(form.entries()))}
            export async function createWorkspaceTemplateVersion(form){return send('version',Object.fromEntries(form.entries()))}
            export async function publishWorkspaceTemplateVersion(id){return send('publish',id)}
            export async function retireWorkspaceTemplateVersion(id){return send('retire',id)}`,
        loader: "js", resolveDir: root,
      }));
    } }],
  });
  const css = await require("postcss")([require("@tailwindcss/postcss")({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });

  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].contents); return; }
    if (url.pathname === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
    if (url.pathname === "/state") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ templates })); return; }
    if (url.pathname === "/mutate" && req.method === "POST") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const { kind, value } = JSON.parse(Buffer.concat(chunks)); calls.push(kind);
      if (kind === "create") {
        templates = [{ id: "template-knowledge-work", slug: value.slug, name: value.name, description: value.description,
          activeVersionId: null, versions: [{ id: "version-1", version: 1, recipe, recipeHash: "a".repeat(64), publishedAt: null, retiredAt: null, createdAt: "2026-10-12T00:00:00.000Z" }] }];
      } else if (kind === "publish") {
        const template = templates[0], version = template.versions.find(row => row.id === value);
        version.publishedAt = "2026-10-12T00:00:00.000Z"; template.activeVersionId = version.id;
      } else if (kind === "retire") {
        const template = templates[0], version = template.versions.find(row => row.id === value);
        version.retiredAt = "2026-10-12T00:00:00.000Z"; template.activeVersionId = null;
      } else if (kind === "version") {
        const template = templates.find(row => row.id === value.templateId);
        const version = Math.max(...template.versions.map(row => row.version)) + 1;
        template.versions.unshift({ id: `version-${version}`, version, recipe, recipeHash: "b".repeat(64), publishedAt: null, retiredAt: null, createdAt: "2026-10-12T00:00:00.000Z" });
      }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true })); return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main style="padding:20px;max-width:1080px;margin:auto"><p style="font-size:12px;color:#666">Isolated fixture · Admin</p><div id="root"></div></main><script>window.fixture=${JSON.stringify({ templates })}</script><script src="/bundle.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());

  for (const width of [320, 390, 768, 1280]) {
    templates = [];
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(base);
    await expect(page.getByRole("heading", { name: "Workspace templates", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Knowledge Work", exact: true })).toBeVisible();
    await expect(page.getByText(/does not share files or credentials, install an image, or admit a runtime/)).toBeVisible();
    await expect(page.getByText(/Profile allowlisting does not prove image availability or assignment admission/)).toBeVisible();
    await expect(page.locator('input[type="hidden"][name="name"]')).toHaveValue("Knowledge Work");
    await expect(page.locator('input[type="hidden"][name="slug"]')).toHaveValue("knowledge-work");
    await expect(page.getByRole("checkbox", { name: "Agent browser view (not available)" })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }

  const create = page.getByRole("button", { name: "Create Knowledge Work draft" });
  await create.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Knowledge Work draft created.");
  await expect(page.getByRole("heading", { name: "Knowledge Work", exact: true }).last()).toBeVisible();
  await expect(page.getByText("SHA-256 " + "a".repeat(64))).toBeVisible();
  await page.getByRole("button", { name: "Publish to catalog" }).click();
  await expect(page.getByRole("status")).toHaveText("Version 1 published to the catalog.");
  await expect(page.getByText("Available in picker", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retire from picker" }).click();
  await expect(page.getByRole("status")).toHaveText("Version 1 retired from new selections.");
  await expect(page.getByText("No published version", { exact: true })).toBeVisible();

  const details = page.getByText("Create a new draft version", { exact: true });
  await details.focus(); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Create draft version" }).click();
  await expect(page.getByRole("status")).toHaveText("New draft version for Knowledge Work created.");
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
  expect(await page.locator("input").evaluateAll(nodes => nodes.map(node => node.name).filter(name => /^(credentials?|tokens?|secrets?|paths?|files?)$/i.test(name)))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(calls).toEqual(["create", "publish", "retire", "version"]);
  expect(errors).toEqual([]);
  console.log("Workspace template catalog fixture passed: accessible labels and keyboard submit, Knowledge Work name/slug, allowlisted disabled capability, draft/publish/retire/version feedback, 320/390/768/1280 layouts, no credential/live-path form fields, no external requests.");
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
}
