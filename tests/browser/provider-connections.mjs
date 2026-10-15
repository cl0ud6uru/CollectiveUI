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
let browser, server, releaseCatalog;
let catalogMode = "success";
let catalogRequests = 0;
const saves = [], externalRequests = [], errors = [];
try {
  const entry = path.join(dir, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import{createRoot}from'${root}/node_modules/react-dom/client';
    import{AppsAdmin}from'${root}/src/components/admin/apps-admin';import{ProviderConnectionsAdmin}from'${root}/src/components/admin/provider-connections-admin';
    const connections=[
      {id:'openai',name:'Saved Responses',provider:'openai',baseUrl:null,organization:'org-fixture',project:'project-fixture',enabled:true},
      {id:'compatible',name:'Saved Chat Completions',provider:'openai-compatible',baseUrl:'https://provider.example/api/v1',organization:null,project:null,enabled:true},
      {id:'openrouter',name:'Saved OpenRouter',provider:'openrouter',baseUrl:'https://openrouter.ai/api/v1',organization:null,project:null,enabled:true},
      {id:'disabled',name:'Disabled credential',provider:'openai-compatible',baseUrl:'https://disabled.example/v1',organization:null,project:null,enabled:false},
      {id:'disabled-other',name:'Other disabled credential',provider:'openai-compatible',baseUrl:'https://other-disabled.example/v1',organization:null,project:null,enabled:false},
      {id:'disabled-router',name:'Disabled OpenRouter credential',provider:'openrouter',baseUrl:'https://openrouter.ai/api/v1',organization:null,project:null,enabled:false},
      {id:'legacy-bad',name:'Legacy operation endpoint',provider:'openai',baseUrl:'https://openrouter.ai/api/v1/chat/completions',organization:null,project:null,enabled:true}
    ];
    const defaults={description:null,icon:null,config:{},hasKey:false,systemPrompt:null,temperature:null,maxTokens:null,supportsVision:false,supportsTools:true,embeddingModel:null,isPublic:true,enabled:true,sortOrder:0,groupIds:[]};
    const apps=[
      {...defaults,id:'retained-compatible',name:'Retained compatible model',provider:'openai-compatible',providerConnectionId:'disabled',baseUrl:'https://disabled.example/v1',model:'fixture/model'},
      {...defaults,id:'retained-router',name:'Retained OpenRouter model',provider:'openrouter',providerConnectionId:'disabled-router',baseUrl:'https://openrouter.ai/api/v1',model:'vendor/vision'},
      {...defaults,id:'enabled-model',name:'Enabled connection model',provider:'openai-compatible',providerConnectionId:'compatible',baseUrl:'https://provider.example/api/v1',model:'fixture/model'},
    ];createRoot(document.getElementById('root')).render(<><ProviderConnectionsAdmin connections={connections.map(c=>({...c,createdBy:'fixture',updatedAt:'2026-01-01',creatorName:'Synthetic admin',models:[]}))}/><AppsAdmin apps={apps} groups={[{id:'audience',name:'Engineering'}]} connections={connections} chatgptEnabled={false}/></>);`);
  const fixtures = {
    'next/navigation': `export const useRouter=()=>({refresh(){}});`,
    'next/link': `import React from 'react';export default function Link(p){return React.createElement('a',p);}`,
    '@/app/admin/actions': `export async function saveApp(input){await fetch('/fixture/model',{method:'POST',body:JSON.stringify(input)});return{id:'fixture-model'};}export async function deleteApp(){throw Error('Unused fixture action');}export async function testAppConnection(input){return fetch('/fixture/test',{method:'POST',body:JSON.stringify(input)}).then(r=>r.json());}`,
    '@/app/admin/model-catalog-actions': `export async function listOpenRouterModels(){return fetch('/fixture/catalog').then(r=>r.json());}`,
    '@/app/admin/provider-actions': `export async function saveProviderConnection(input){await fetch('/fixture/provider',{method:'POST',body:JSON.stringify(input)});}export async function deleteProviderConnection(){throw Error('Unused fixture action');}export async function migrateAppProviderConnection(){throw Error('Unused fixture action');}`,
  };
  const bundle = await build({ entryPoints: [entry], outfile: path.join(dir, 'bundle.js'), bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') }, plugins: [{ name: 'synthetic-actions', setup(b) {
    b.onResolve({ filter: /^(next\/(navigation|link)|@\/app\/admin\/(actions|provider-actions|model-catalog-actions))$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path], loader: 'js', resolveDir: root }));
  } }] });
  const css = await require('postcss')([require('@tailwindcss/postcss')({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });
  server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles.find(file => file.path.endsWith('.js')).contents); return; }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css + (bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '')); return; }
    if (req.url === '/fixture/catalog') {
      catalogRequests++;
      if (catalogMode === 'loading') await new Promise(resolve => { releaseCatalog = resolve; });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(catalogMode === 'error' ? {ok:false,error:'OpenRouter’s model catalog is unavailable. Retry, or enter a model ID manually.'} : {ok:true,models:catalogMode === 'empty' ? [] : [
        {id:'vendor/reasoner',name:'Fixture Reasoner',supportsTools:true,supportsVision:false},
        {id:'vendor/vision',name:'Fixture Vision with a deliberately long catalog display name that should remain usable on narrow mobile screens',supportsTools:false,supportsVision:true},
      ]})); return;
    }
    if (req.url === '/fixture/test') { for await (const chunk of req) void chunk; res.end(JSON.stringify({ok:true,models:[],note:'OpenRouter credential verified. Model access and generation have not been tested.'})); return; }
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
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({width,height:1000});
    await page.goto(base);
    await page.getByRole('button',{name:'Add model connection',exact:true}).click();
    dialog = page.getByRole('dialog');
    await choose('Saved provider connection','openrouter');
    await expect(dialog.getByRole('combobox',{name:'Provider API type',exact:true})).toContainText('OpenRouter');
    await expect(dialog.getByRole('combobox',{name:'OpenRouter model',exact:true})).toBeEnabled();
    await dialog.getByLabel('Name',{exact:true}).fill('OpenRouter fixture');
    await expect(dialog.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
    await expect(dialog).toContainText('Choose a model or enter its ID to save');
    await dialog.getByLabel('Search OpenRouter models',{exact:true}).fill('vision');
    await dialog.getByRole('combobox',{name:'OpenRouter model',exact:true}).click();
    expect(await page.getByRole('listbox').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})).toBe(true);
    await page.getByRole('option').first().press('End');
    await expect(page.locator('[role=option][data-value="vendor/vision"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toContainText('Selected model ID: vendor/vision');
    await expect(dialog.locator('label').filter({hasText:'Supports tool calling'}).getByRole('switch')).not.toBeChecked();
    await expect(dialog.locator('label').filter({hasText:'Supports images'}).getByRole('switch')).toBeChecked();
    await dialog.getByRole('button',{name:'Test saved connection',exact:true}).click();
    await expect(dialog).toContainText('generation have not been tested');
    const bounds = await dialog.evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,viewport:innerWidth,width:e.clientWidth,scroll:e.scrollWidth,overflow:[...e.querySelectorAll('*')].filter(c=>c.getBoundingClientRect().right>r.right).slice(0,8).map(c=>({tag:c.tagName,text:c.textContent?.slice(0,180),width:c.getBoundingClientRect().width}))};});
    if (!(bounds.left>=0&&bounds.right<=width&&bounds.scroll<=bounds.width)) console.log(bounds);
    expect(bounds.left>=0&&bounds.right<=width&&bounds.scroll<=bounds.width).toBe(true);
    if (process.env.PROVIDER_CONNECTION_SCREENSHOTS && (width === 390 || width === 1280)) {
      await dialog.getByRole('combobox',{name:'OpenRouter model',exact:true}).evaluate(e=>e.scrollIntoView({block:'center'}));
      await page.screenshot({path:path.join(process.env.PROVIDER_CONNECTION_SCREENSHOTS,`openrouter-${width}.png`),fullPage:false});
    }
    await dialog.getByRole('button',{name:'Save',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    expect(saves.at(-1)).toMatchObject({route:'/fixture/model',input:{provider:'openrouter',providerConnectionId:'openrouter',baseUrl:'https://openrouter.ai/api/v1',model:'vendor/vision',supportsTools:false,supportsVision:true,credentials:{}}});
  }
  for (const mode of ['loading','error','empty']) {
    catalogMode = mode;
    await page.goto(base);
    await page.getByRole('button',{name:'Add model connection',exact:true}).click();
    dialog = page.getByRole('dialog');
    await choose('Saved provider connection','openrouter');
    if (mode === 'loading') {
      await expect(dialog).toContainText('Loading OpenRouter models');
      await expect(dialog.getByRole('combobox',{name:'OpenRouter model',exact:true})).toBeDisabled();
      await expect.poll(()=>!!releaseCatalog).toBe(true);
      releaseCatalog(); releaseCatalog = undefined;
      await expect(dialog.getByRole('combobox',{name:'OpenRouter model',exact:true})).toBeEnabled();
      await dialog.getByLabel('Search OpenRouter models',{exact:true}).fill('no-such-model');
      await expect(dialog).toContainText('No matching models');
      await dialog.getByRole('button',{name:'Enter model ID manually',exact:true}).click();
    } else await expect(dialog).toContainText(mode === 'error' ? 'catalog is unavailable' : 'No chat models were returned');
    await dialog.getByLabel('Name',{exact:true}).fill('Manual fixture');
    await dialog.getByLabel('Model',{exact:true}).fill('vendor/manual-model');
    await expect(dialog.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
    if (mode === 'error') {
      catalogMode = 'success';
      await dialog.getByRole('button',{name:'Reload models',exact:true}).click();
      await expect(dialog.getByRole('combobox',{name:'OpenRouter model',exact:true})).toBeEnabled();
      await expect(dialog).toContainText('vendor/manual-model (manual ID)');
    }
    await dialog.getByRole('button',{name:'Save',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    expect(saves.at(-1)).toMatchObject({route:'/fixture/model',input:{provider:'openrouter',model:'vendor/manual-model'}});
  }
  catalogMode = 'success';
  await page.goto(base);
  await page.getByRole('button',{name:'Add provider connection',exact:true}).click();
  dialog = page.getByRole('dialog');
  await choose('Provider API type','openrouter');
  await expect(dialog.getByLabel('Provider endpoint',{exact:true})).toHaveValue('https://openrouter.ai/api/v1');
  await expect(dialog.getByLabel('Provider organization',{exact:true})).toHaveCount(0);
  await dialog.getByLabel('Connection name',{exact:true}).fill('OpenRouter credentials');
  await dialog.getByLabel('Provider API key',{exact:true}).fill('synthetic-browser-fixture');
  await dialog.getByRole('button',{name:'Save provider connection',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(saves.at(-1)).toMatchObject({route:'/fixture/provider',input:{provider:'openrouter',baseUrl:'https://openrouter.ai/api/v1',organization:null,project:null}});
  for (const retained of [
    {id:'retained-compatible',name:'Retained compatible model',connectionId:'disabled'},
    {id:'retained-router',name:'Retained OpenRouter model',connectionId:'disabled-router'},
  ]) {
    await page.goto(base);
    await page.getByRole('button',{name:`Edit ${retained.name}`,exact:true}).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button',{name:'Test saved connection',exact:true})).toBeDisabled();
    await expect(dialog.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
    await expect(dialog).toContainText('You can still save changes');
    await choose('Saved provider connection','compatible');
    await choose('Saved provider connection',retained.connectionId);
    await expect(dialog.getByRole('button',{name:'Test saved connection',exact:true})).toBeDisabled();
    await dialog.getByLabel('Name',{exact:true}).fill(`${retained.name} edited`);
    await dialog.getByRole('switch',{name:'Enabled',exact:true}).click();
    await dialog.getByRole('switch',{name:'Available to everyone',exact:true}).click();
    await dialog.getByRole('button',{name:'Engineering',exact:true}).click();
    await expect(dialog.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
    await dialog.getByRole('button',{name:'Save',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    expect(saves.at(-1)).toMatchObject({route:'/fixture/model',input:{id:retained.id,name:`${retained.name} edited`,providerConnectionId:retained.connectionId,enabled:false,isPublic:false,groupIds:['audience'],credentials:{}}});
  }
  for (const existing of [false,true]) {
    await page.goto(base);
    await page.getByRole('button',{name:existing?'Edit Enabled connection model':'Add model connection',exact:true}).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox',{name:'Saved provider connection',exact:true}).click();
    for (const id of ['disabled','disabled-other','disabled-router']) await expect(page.locator(`[role=option][data-value="${id}"]`)).toBeDisabled();
    await page.keyboard.press('Escape');
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  }
  expect(catalogRequests).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  console.log('Saved provider UI: OpenRouter catalog search/selection, read-only test feedback, loading/retry/empty/manual fallback, retained disabled-connection edits and new/different attachment guards, all API types, destination locks, manual credentials, invalid endpoint rejection and 320/390/768/1280 layouts passed; all actions synthetic, zero provider requests.');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
