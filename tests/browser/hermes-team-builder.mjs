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
export const saveBotFromBuilder = async (id,form) => {
  window.fixtureSaveAttempts.push({id,form});
  if (window.fixtureSaveError) { const error=window.fixtureSaveError; window.fixtureSaveError=null; return {ok:false,error}; }
  if (id) { await updateBot(id,form); return {ok:true,id}; }
  return {ok:true,...await createBot(form)};
};
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
window.fixtureCreates=[]; window.fixtureUpdates=[]; window.fixtureSaveAttempts=[];
const converted = location.pathname.startsWith('/converted');
const audience = location.pathname.startsWith('/audience');
const convertedDisabled = location.pathname === '/converted-disabled';
const retainPolicy = location.pathname === '/converted-policy';
const modelRoutes = {adminRouteId:'saved-admin-route',personalRouteId:'saved-personal-route'};
const toolPolicy = {capabilities:[{capabilityId:'saved-inbox',connectionMode:'disabled',resourceIds:['saved-resource'],effect:'read',requireApproval:true}]};
const initial = {name:'Fixture Team',avatar:null,description:null,instructions:'',boundaries:'',appId:converted||audience?'fixture-native':'fixture-hermes',visibility:'org',groupIds:[],userIds:[],maxSteps:10,starters:[],tools:[],delegateIds:[]};
createRoot(document.getElementById('root')).render(<BotBuilder botId={converted?'converted-team':location.pathname==='/audience-edit'?'audience-bot':undefined} initial={initial} apps={[{id:'fixture-hermes',name:'Fixture Hermes',supportsTools:true,agentServer:true},{id:'fixture-native',name:'Fixture native',supportsTools:true}]} groups={[{id:'audience-group',name:'Fixture audience'}]} users={[]} tools={[]} delegates={[]} knowledge={[]} newChatId="fixture-preview" isAdmin teamConfig={{enabled:converted&&!convertedDisabled,modelPolicy:'admin_provided',maintainerIds:['admin'],expectedVersion:7,modelRoutes:retainPolicy?modelRoutes:undefined,toolPolicy:retainPolicy?toolPolicy:undefined}} teamMaintainers={[{id:'admin',name:'Fixture admin'},{id:'admin2',name:'Second admin'}]} teamModelOptions={retainPolicy?[]:[{value:'admin_provided',available:true}]}/>);
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
  await expect(page.getByRole('alert')).toHaveText('Bot configuration saved, but Team Bot settings need attention: Synthetic Team settings outage.');
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
  await page.goto(`http://127.0.0.1:${server.address().port}/converted-disabled`);
  const reenable = page.getByRole('checkbox', {name:'Share a Hermes Team Bot',exact:false});
  await expect(reenable).toBeVisible(); await expect(reenable).not.toBeChecked();
  await reenable.check(); await page.getByRole('button', {name:'Update',exact:true}).click();
  await expect.poll(() => updates.length).toBe(5);
  expect(updates[4]).toEqual({method:'PUT',path:'/api/bots/converted-team/team',body:{enabled:true,maintainerIds:['admin'],modelPolicy:{mode:'admin_provided'},expectedVersion:7}});
  await page.goto(`http://127.0.0.1:${server.address().port}/converted-policy`);
  await expect(page.getByLabel('Team Bot model access')).toHaveCount(0);
  await expect(page.getByText('Team tool connections are unavailable until a native adapter is verified.')).toBeVisible();
  await expect(page.getByText('Saved connection rules are preserved. Connection changes are unavailable in this version.')).toBeVisible();
  await page.getByRole('checkbox', {name:'Maintainer: Second admin',exact:true}).check();
  await page.getByRole('button', {name:'Update',exact:true}).click();
  await expect.poll(() => updates.length).toBe(6);
  expect(updates[5]).toEqual({method:'PUT',path:'/api/bots/converted-team/team',body:{enabled:true,maintainerIds:['admin','admin2'],modelPolicy:{mode:'admin_provided',adminRouteId:'saved-admin-route',personalRouteId:'saved-personal-route'},expectedVersion:7,toolPolicy:{capabilities:[{capabilityId:'saved-inbox',connectionMode:'disabled',resourceIds:['saved-resource'],effect:'read',requireApproval:true}]}}});
  expect(await page.evaluate(() => window.fixtureCreates.length)).toBe(0);
  for (const mode of ['create','edit']) {
    await page.goto(`http://127.0.0.1:${server.address().port}/audience-${mode}`);
    await page.getByRole('button', {name:'configure',exact:true}).click();
    await page.getByLabel('Who can use it').click();
    await page.locator('[role="option"][data-value="groups"]').click();
    const submit = page.getByRole('button', {name:mode==='create'?'Create':'Update',exact:true});
    await submit.click();
    await expect(page.getByRole('alert')).toHaveText('Select at least one group or individual user under Who can use it.');
    expect(await page.evaluate(() => window.fixtureSaveAttempts)).toEqual([]);
    const group = page.getByRole('button', {name:'Fixture audience',exact:true});
    await expect(group).toHaveAttribute('aria-pressed','false');
    await group.click();
    await expect(group).toHaveAttribute('aria-pressed','true');
    await expect(group.locator('svg')).toHaveCount(1);
    await page.evaluate(() => { window.fixtureSaveError='A selected group is no longer available.'; });
    await submit.click();
    await expect(page.getByRole('alert')).toHaveText('A selected group is no longer available.');
    expect(await page.evaluate(() => [window.fixtureCreates.length,window.fixtureUpdates.length])).toEqual([0,0]);
    expect(await page.evaluate(() => window.fixtureNavigation)).toBeUndefined();
    await expect(submit).toBeEnabled(); await submit.click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.fixtureSuccess)).toBe(mode==='create'?'Bot created':'Bot updated');
    const saved = await page.evaluate(mode => mode==='create'?window.fixtureCreates:window.fixtureUpdates.map(update=>update.form),mode);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({visibility:'groups',groupIds:['audience-group']});
  }
  expect(updates).toHaveLength(6); // Audience errors never write Team settings.
  expect(errors).toEqual([]);
  console.log('PASS: actual bot editor audience validation, selected-group feedback, structured create/update errors and retries; Team PUT 503 retry creates once; sequential versions, converted Team settings and strict policy payload; synthetic actions/HTTP only.');
} finally { await browser.close(); server.close(); await rm(dir, {recursive:true,force:true}); }
