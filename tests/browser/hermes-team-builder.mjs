import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Actual editor with synthetic server actions; checks partial creation success across retries.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-team-builder-'));
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
export const createBot = async form => { window.fixtureCreates.push(form); return {id:'already-created-team'}; };
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
const converted = location.pathname === '/converted';
const initial = {name:'Fixture Team',avatar:null,description:null,instructions:'',boundaries:'',appId:converted?'fixture-native':'fixture-hermes',visibility:'org',groupIds:[],userIds:[],maxSteps:10,starters:[],tools:[],delegateIds:[]};
createRoot(document.getElementById('root')).render(<BotBuilder botId={converted?'converted-team':undefined} initial={initial} apps={[{id:'fixture-hermes',name:'Fixture Hermes',supportsTools:true,agentServer:true},{id:'fixture-native',name:'Fixture native',supportsTools:true}]} groups={[]} users={[]} tools={[]} delegates={[]} knowledge={[]} newChatId="fixture-preview" isAdmin teamConfig={{enabled:converted,modelPolicy:'admin_provided',maintainerIds:['admin'],expectedVersion:7}} teamMaintainers={[{id:'admin',name:'Fixture admin'},{id:'admin2',name:'Second admin'}]} teamModelOptions={[{value:'admin_provided',available:true}]}/>);
`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src'), 'next/navigation': navigation, sonner, ...aliases }, plugins: [{ name: 'fixture-components', setup(build) { build.onResolve({filter:/^\.\//}, args => localStubs.has(args.path) && args.importer.endsWith('/bot-builder.tsx') ? {path:stubs} : undefined); } }] });
const updates = []; let rejectNext = true;
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (!req.url.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  res.setHeader('Content-Type', 'application/json');
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  updates.push({method:req.method,path:req.url,body:JSON.parse(Buffer.concat(bytes).toString())});
  if (rejectNext) { rejectNext=false; res.statusCode=503; res.end(JSON.stringify({error:'Synthetic Team settings outage.'})); }
  else res.end(JSON.stringify({version:updates.at(-1).body.expectedVersion+1}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', {name:'configure',exact:true}).click();
  await page.getByRole('checkbox', {name:'Share a Hermes Team Bot',exact:false}).check();
  const save = page.getByRole('button', {name:'Create',exact:true});
  await save.click();
  await expect.poll(() => page.evaluate(() => window.fixtureError)).toBe('Bot configuration saved, but Team Bot settings need attention: Synthetic Team settings outage.');
  expect(await page.evaluate(() => window.fixtureCreates.length)).toBe(1);
  expect(await page.evaluate(() => window.fixtureNavigation)).toBeUndefined();
  await expect(save).toBeEnabled(); await save.click();
  await expect.poll(() => page.evaluate(() => window.fixtureNavigation)).toBe('/bots/already-created-team/edit');
  expect(await page.evaluate(() => window.fixtureCreates.length)).toBe(1);
  expect((await page.evaluate(() => window.fixtureUpdates)).map(update => update.id)).toEqual(['already-created-team']);
  expect(updates).toEqual(Array.from({length:2}, () => ({method:'PUT',path:'/api/bots/already-created-team/team',body:{enabled:true,maintainerIds:['admin'],modelPolicy:{mode:'admin_provided'},expectedVersion:7}})));
  await expect(save).toBeEnabled(); await save.click();
  await expect.poll(() => page.evaluate(() => window.fixtureUpdates.length)).toBe(2);
  expect(updates).toHaveLength(2); // Successful settings are the new comparison baseline.
  await page.getByRole('checkbox', {name:'Maintainer: Second admin',exact:true}).check();
  await expect(save).toBeEnabled(); await save.click();
  await expect.poll(() => updates.length).toBe(3);
  expect(updates[2].body).toEqual({enabled:true,maintainerIds:['admin','admin2'],modelPolicy:{mode:'admin_provided'},expectedVersion:8});
  await expect(save).toBeEnabled(); await save.click();
  await expect.poll(() => page.evaluate(() => window.fixtureUpdates.length)).toBe(4);
  expect(updates).toHaveLength(3);
  await page.goto(`http://127.0.0.1:${server.address().port}/converted`);
  const enable = page.getByRole('checkbox', {name:'Share a Hermes Team Bot',exact:false});
  await expect(enable).toBeVisible(); await expect(enable).toBeChecked();
  await enable.uncheck(); await page.getByRole('button', {name:'Update',exact:true}).click();
  await expect.poll(() => updates.length).toBe(4);
  expect(updates[3]).toEqual({method:'PUT',path:'/api/bots/converted-team/team',body:{enabled:false,maintainerIds:['admin'],modelPolicy:{mode:'admin_provided'},expectedVersion:7}});
  expect(await page.evaluate(() => window.fixtureCreates.length)).toBe(0);
  expect(errors).toEqual([]);
  console.log('PASS: actual bot editor Team PUT 503 retry creates once; successful version advances sequential edits without remount or repeated settings writes; converted native-engine Team settings remain available; strict policy payload; synthetic actions/HTTP only.');
} finally { await browser.close(); server.close(); await rm(dir, {recursive:true,force:true}); }
