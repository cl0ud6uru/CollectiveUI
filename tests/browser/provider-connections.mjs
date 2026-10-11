import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'saved-provider-browser-'));
let browser, server;
const saves = [], externalRequests = [], errors = [];
try {
  const entry = path.join(dir, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import{createRoot}from'${root}/node_modules/react-dom/client';
    import{AppsAdmin}from'${root}/src/components/admin/apps-admin';import{ProviderConnectionsAdmin}from'${root}/src/components/admin/provider-connections-admin';
    const connections=[
      {id:'openai',name:'Saved Responses',provider:'openai',baseUrl:null,organization:'org-fixture',project:'project-fixture',enabled:true},
      {id:'compatible',name:'Saved Chat Completions',provider:'openai-compatible',baseUrl:'https://provider.example/api/v1',organization:null,project:null,enabled:true},
      {id:'disabled',name:'Disabled credential',provider:'openai-compatible',baseUrl:'https://disabled.example/v1',organization:null,project:null,enabled:false},
      {id:'legacy-bad',name:'Legacy operation endpoint',provider:'openai',baseUrl:'https://provider.example/v1/chat/completions',organization:null,project:null,enabled:true}
    ];createRoot(document.getElementById('root')).render(<><ProviderConnectionsAdmin connections={connections.map(c=>({...c,createdBy:'fixture',updatedAt:'2026-01-01',creatorName:'Synthetic admin',models:[]}))}/><AppsAdmin apps={[]} groups={[]} connections={connections} chatgptEnabled={false}/></>);`);
  const fixtures = {
    'next/navigation': `export const useRouter=()=>({refresh(){}});`,
    'next/link': `import React from 'react';export default function Link(p){return React.createElement('a',p);}`,
    '@/app/admin/actions': `export async function saveApp(input){await fetch('/fixture/model',{method:'POST',body:JSON.stringify(input)});return{id:'fixture-model'};}export async function deleteApp(){throw Error('Unused fixture action');}export async function testAppConnection(){throw Error('Tests never submit provider requests');}`,
    '@/app/admin/provider-actions': `export async function saveProviderConnection(input){await fetch('/fixture/provider',{method:'POST',body:JSON.stringify(input)});}export async function deleteProviderConnection(){throw Error('Unused fixture action');}export async function migrateAppProviderConnection(){throw Error('Unused fixture action');}`,
  };
  const bundle = await build({ entryPoints: [entry], outfile: path.join(dir, 'bundle.js'), bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') }, plugins: [{ name: 'synthetic-actions', setup(b) {
    b.onResolve({ filter: /^(next\/(navigation|link)|@\/app\/admin\/(actions|provider-actions))$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path], loader: 'js', resolveDir: root }));
  } }] });
  const css = await require('postcss')([require('@tailwindcss/postcss')({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });
  server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles.find(file => file.path.endsWith('.js')).contents); return; }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css + (bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '')); return; }
    if (req.url.startsWith('/fixture/')) { const chunks = []; for await (const c of req) chunks.push(c); saves.push({ route: req.url, input: JSON.parse(Buffer.concat(chunks)) }); res.end('{}'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main style="padding:16px;max-width:1100px;margin:auto"><div id="root"></div></main><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { if (!route.request().url().startsWith(base)) { externalRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  const choose = async (label, value) => {
    await page.getByRole('dialog').getByRole('combobox', { name: label, exact: true }).click();
    await page.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
  };
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(base);
    await page.getByRole('button', { name: 'Add model connection', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('combobox', { name: 'Saved provider connection' })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Provider API type' })).toContainText('OpenAI-compatible');
    await choose('Saved provider connection', 'openai');
    await expect(dialog.getByRole('combobox', { name: 'Provider API type' })).toBeDisabled();
    await expect(dialog.getByRole('combobox', { name: 'Provider API type' })).toContainText('OpenAI');
    await expect(dialog.getByLabel('Organization ID', { exact: true })).toHaveValue('org-fixture');
    await expect(dialog.getByLabel('Project ID', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('API key', { exact: true })).toHaveCount(0);
    await choose('Saved provider connection', 'compatible');
    await expect(dialog.getByLabel('Base URL', { exact: true })).toHaveValue('https://provider.example/api/v1');
    await expect(dialog.getByLabel('Base URL', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Organization ID', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Name', { exact: true }).fill('Synthetic model');
    await dialog.getByLabel('Model', { exact: true }).fill('fixture/model');
    expect(await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth; })).toBe(true);
    if (process.env.PROVIDER_CONNECTION_SCREENSHOTS && (width === 390 || width === 1280)) {
      await mkdir(process.env.PROVIDER_CONNECTION_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PROVIDER_CONNECTION_SCREENSHOTS, `saved-compatible-${width}.png`), fullPage: true });
    }
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(saves.at(-1)).toMatchObject({ route: '/fixture/model', input: { provider: 'openai-compatible', providerConnectionId: 'compatible', credentials: {}, config: {}, baseUrl: 'https://provider.example/api/v1' } });
  }
  await page.goto(base);
  await page.getByRole('button', { name: 'Add model connection', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await choose('Saved provider connection', 'openai');
  await choose('Saved provider connection', '');
  await expect(dialog.getByRole('combobox', { name: 'Provider API type' })).toBeEnabled();
  await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue('');
  await choose('Saved provider connection', 'legacy-bad');
  await expect(dialog).toContainText('Enter the API base URL');
  await expect(dialog.getByRole('button', { name: 'Test saved connection' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add provider connection', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Connection name', { exact: true }).fill('Synthetic compatible API');
  await dialog.getByLabel('Provider API key', { exact: true }).fill('synthetic-cleared-on-type-change');
  await choose('Provider API type', 'openai-compatible');
  await expect(dialog.getByLabel('Provider API key', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Provider organization', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('Provider API key', { exact: true }).fill('synthetic-provider-fixture');
  await dialog.getByLabel('Provider endpoint', { exact: true }).fill('https://provider.example/api/v1/chat/completions');
  await expect(dialog).toContainText('Enter the API base URL');
  await expect(dialog.getByRole('button', { name: 'Save provider connection', exact: true })).toBeDisabled();
  await dialog.getByLabel('Provider endpoint', { exact: true }).fill('https://provider.example/api/v1');
  await dialog.getByRole('button', { name: 'Save provider connection', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saves.at(-1)).toMatchObject({ route: '/fixture/provider', input: { provider: 'openai-compatible', baseUrl: 'https://provider.example/api/v1', organization: null, project: null } });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  console.log('Saved provider UI: both API types, visible selector, destination locks, manual credentials, invalid endpoint rejection and 320/390/768/1280 layouts passed; all actions synthetic, zero provider requests.');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
