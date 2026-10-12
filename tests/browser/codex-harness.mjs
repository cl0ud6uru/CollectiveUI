import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Actual editor, synthetic server actions, no runtime connection or inference.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'codex-harness-builder-'));
const entry = path.join(dir, 'entry.tsx');
const navigation = path.join(dir, 'navigation.ts');
const stubs = path.join(dir, 'stubs.tsx');
const sonner = path.join(dir, 'sonner.ts');
await writeFile(navigation, `export const useRouter = () => ({ push: path => { window.fixtureNavigation = path; }, refresh: () => {} });`);
await writeFile(sonner, `export const toast = { error: value => {window.fixtureError=value;}, success: value => {window.fixtureSuccess=value;} };`);
await writeFile(stubs, `
const Empty = () => null;
export {Empty as Chat,Empty as BuilderAvatar,Empty as BotDeleteButton,Empty as BotPetSettings,Empty as PetChoices,Empty as BotAvatar,Empty as ServiceGrantEditor};
export const randomBlob = () => 'fixture-avatar';
export const SEARCH_COST_NOTICE = '';
export const createBot = async form => { window.fixtureCreates.push(form); return {id:'created-codex-bot'}; };
export const updateBot = async (id,form) => { window.fixtureUpdates.push({id,form}); };
export const createPersonalHermesBot = async () => { throw new Error('Personal Hermes creation is not part of this fixture.'); };
export const draftBotFromDescription = async () => ({ok:false,error:'Not used'});
export const addKnowledgeFile = async () => {}; export const removeKnowledgeFile = async () => {};
`);
const aliases = Object.fromEntries([
  '@/app/(chat)/bots/actions', '@/app/(chat)/settings/hermes-actions', '@/components/chat/chat',
  '@/components/pets/bot-pet', '@/components/pets/pet-choices', '@/lib/native-search-policy',
].map(source => [source, stubs]));
const localStubs = new Set(['./builder-avatar', './bot-delete-button', './bot-avatar', './service-grant-editor']);
await writeFile(entry, `
import React from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client';
import { BotBuilder } from '${root}/src/components/bots/bot-builder';
window.fixtureCreates=[]; window.fixtureUpdates=[];
const existing = location.pathname === '/existing';
const initial = {name:'Example Bot',avatar:null,description:null,instructions:'',boundaries:'',appId:'fixture-native',visibility:'org',groupIds:[],userIds:[],maxSteps:10,starters:[],tools:[{key:'memory',approval:'auto'}],delegateIds:[],delegatorIds:[]};
createRoot(document.getElementById('root')).render(<BotBuilder botId={existing?'existing-native':undefined} initial={initial} apps={[{id:'fixture-hermes',name:'Fixture Hermes',supportsTools:true,agentServer:true},{id:'fixture-native',name:'Fixture native',supportsTools:true}]} groups={[]} users={[]} tools={[]} delegates={[]} knowledge={[]} newChatId="fixture-preview" codexRuntimeStatus={{api:'No verified API runtime assigned to you.',chatgpt_subscription:'No authorized subscription runtime assigned to you.'}}/>);
`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src'), 'next/navigation': navigation, sonner, ...aliases }, plugins: [{ name: 'fixture-components', setup(build) { build.onResolve({filter:/^\.\//}, args => localStubs.has(args.path) && args.importer.endsWith('/bot-builder.tsx') ? {path:stubs} : undefined); } }] });
const css = await require('postcss')([require('@tailwindcss/postcss')({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'), {from:path.join(root,'src/app/globals.css')});
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (req.url === '/style.css') { res.setHeader('Content-Type','text/css'); res.end(css.css); return; }
  res.setHeader('Content-Type', 'text/html'); res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({width,height:1000});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', {name:'configure',exact:true}).click();
    await page.getByLabel('Bot engine', {exact:true}).click();
    await page.getByRole('option', {name:'Codex · personal agent',exact:true}).click();
    await expect(page.getByLabel('Model connection', {exact:true})).toHaveCount(0);
    await expect(page.getByLabel('Codex funding')).toContainText('My authorized ChatGPT subscription runtime');
    await expect(page.getByText('No authorized subscription runtime assigned to you.', {exact:true})).toBeVisible();
    await page.getByLabel('Codex funding').click();
    await page.getByRole('option', {name:'My API-funded runtime',exact:true}).click();
    await expect(page.getByText('No verified API runtime assigned to you.', {exact:true})).toBeVisible();
    await page.getByLabel('Codex funding').click();
    await page.getByRole('option', {name:'My authorized ChatGPT subscription runtime',exact:true}).click();
    await expect(page.getByText('No authorized subscription runtime assigned to you.', {exact:true})).toBeVisible();
    await page.getByLabel('Codex model').fill('fixture-model');
    await page.getByLabel('Reasoning effort').click();
    await page.getByRole('option', {name:'high',exact:true}).click();
    await expect(page.getByText(/Sharing this bot does not share your account/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', {name:'Create',exact:true}).click();
    await expect.poll(() => page.evaluate(() => window.fixtureCreates.length)).toBe(1);
    const saved = await page.evaluate(() => window.fixtureCreates[0]);
    expect(saved.codex).toEqual({funding:'chatgpt_subscription',model:'fixture-model',effort:'high'});
    expect(saved.appId).toBe(''); expect(saved.tools).toEqual([]); expect(saved.delegateIds).toEqual([]);
    expect(saved.executionMode).toBe('caller'); expect(saved.visibility).toBe('org');
    if (process.env.CODEX_HARNESS_SCREENSHOT && width === 390) await page.screenshot({path:process.env.CODEX_HARNESS_SCREENSHOT,fullPage:true});
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/existing`);
  await page.getByLabel('Bot engine', {exact:true}).click();
  await expect(page.getByRole('option', {name:/Codex.*create a new bot/})).toHaveAttribute('aria-disabled','true');
  expect(errors).toEqual([]);
  console.log('PASS Codex actual bot editor: explicit engine/funding/model/effort, caller mode, cleared native tools, unavailable-runtime state, no existing-bot conversion, 320/390/768/1280 layouts. Synthetic actions only.');
} finally { await browser.close(); server.close(); await rm(dir, {recursive:true,force:true}); }
