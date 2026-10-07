import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Actual provider, sidebar, rail and send refresh; synthetic local snapshots, no account or inference.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'bot-recent-use-'));
const entry = path.join(dir, 'entry.tsx');
const navigationBundle = await build({ entryPoints: [path.join(root, 'src/lib/bots/navigation.ts')], write: false, bundle: true, platform: 'node', format: 'cjs' });
const navigationModule = { exports: {} };
new Function('module', 'exports', navigationBundle.outputFiles[0].text)(navigationModule, navigationModule.exports);
const { orderBots, changeBotNavigation, canMoveNavigationBot } = navigationModule.exports;
const names = { p2: 'Research', p1: 'Planning', a: 'Writing', b: 'Engineering', c: 'Design', d: 'Finance', e: 'Support', f: 'New bot' };
const initialOrder = Object.keys(names);
const users = Object.fromEntries(['alice', 'bob'].map(user => [user, { order: [...initialOrder], bots: initialOrder.map(id => ({ kind: 'bot', id, name: names[id], icon: null, description: null, pinned: id.startsWith('p'), hidden: false, lastSentAt: null })) }]));
let clock = Date.parse('2026-10-07T12:00:00Z');
const snapshot = user => orderBots(users[user].bots, users[user].order);
await writeFile(entry, `
import React, { useState } from 'react';
import { createRoot } from '${root}/node_modules/react-dom/client';
import { Tooltip } from 'radix-ui';
import { ShellProvider, useShell } from '${root}/src/components/chat/shell-context';
import { BotSection } from '${root}/src/components/sidebar/bot-section';
import { AvatarRail } from '${root}/src/components/sidebar/avatar-rail';
import { chatSendFetch } from '${root}/src/lib/chat/send-fetch';
const userId = new URLSearchParams(location.search).get('user') || 'alice';
const get = async () => (await fetch('/snapshot?user=' + userId)).json();
function Surface() {
  const shell = useShell(); const [active, setActive] = useState(''); const [notice, setNotice] = useState('');
  window.fixtureOpen = href => { const bot = new URL(href, location.href).searchParams.get('bot'); if (bot) { setActive(bot); shell.setCurrentConversation({id:'chat',title:'Synthetic chat',botId:bot,appId:null,source:'chat',pinned:false,folderId:null,updatedAt:'2026-10-07'}); } };
  window.fixtureActivity = () => { shell.setBotLive('f', { preview:'Background delegated result',lastAt:'2026-10-08T00:00:00Z' }); shell.setChatStatus('background','f','working'); };
  const send = async fail => { const response = await chatSendFetch(() => window.fixtureRefresh())('/send?user=' + userId, {method:'POST',body:JSON.stringify({botId:active,fail,message:{role:'user',parts:[{type:'text',text:'Synthetic send'}]}})}); setNotice(response.ok ? 'Message accepted' : 'Message rejected'); };
  return <div className="flex h-screen bg-bg text-fg">
    {shell.sidebarOpen ? <nav className="w-[260px] shrink-0 overflow-y-auto bg-sidebar p-2"><div className="flex h-14 items-center justify-between px-2"><strong>CollectiveUI</strong><button aria-label="Close sidebar" onClick={() => shell.setSidebarOpen(false)}>Close</button></div><BotSection bots={shell.bots} activeBotId={active} onNavigate={() => {}}/></nav> : <AvatarRail/>}
    <main className="flex flex-1 flex-col p-6"><h1 className="text-2xl font-semibold">{names[active] || 'Choose a bot'}</h1><p className="mt-2 text-sm text-muted">Private synthetic browser fixture</p><div className="mt-auto flex flex-wrap gap-2"><button className="rounded-lg bg-accent px-4 py-2 text-white" disabled={!active} onClick={() => send(false)}>Send message</button><button className="rounded-lg border border-border px-4 py-2" disabled={!active} onClick={() => send(true)}>Reject send</button><button className="rounded-lg border border-border px-4 py-2" onClick={() => window.fixtureActivity()}>Background activity</button></div><p role="status" className="mt-2 h-6 text-sm">{notice}</p></main>
  </div>;
}
const names = ${JSON.stringify(names)};
function App({initial}) {
  const [bots, setBots] = useState(initial);
  window.fixtureRefresh = async () => setBots(await get());
  window.fixtureSave = async change => { const response = await fetch('/navigation?user=' + userId,{method:'POST',body:JSON.stringify(change)}); const result = await response.json(); await window.fixtureRefresh(); return result; };
  return <Tooltip.Provider><ShellProvider bots={bots} apps={[]} folders={[]} conversations={[]} inboxUnread={0} user={{id:userId,name:userId,email:userId+'@test.invalid',isAdmin:false,canCreateBots:false}} branding={{appName:'CollectiveUI',welcomeText:'',logoEmoji:''}}><Surface/></ShellProvider></Tooltip.Provider>;
}
get().then(initial => createRoot(document.getElementById('root')).render(<App initial={initial}/>));
`);
const stubs = {
  'next/navigation': `const router={refresh:()=>window.fixtureRefresh(),push:href=>window.fixtureOpen(href)};export const useRouter=()=>router;export const usePathname=()=>'/c/chat';`,
  'next/link': `import React from 'react';export default function Link({href,prefetch,onClick,children,...props}){return <a href={href} {...props} onClick={e=>{e.preventDefault();onClick?.(e);window.fixtureOpen?.(href)}}>{children}</a>}`,
  '@/app/(chat)/actions': `export const refreshBotStatuses=async()=>null;`,
  '@/app/(chat)/bots/navigation-actions': `export const updateBotNavigation=change=>window.fixtureSave(change);`,
  '@/app/(chat)/bots/actions': `export const duplicateBot=async()=>{throw new Error('Not supported in fixture')};`,
  '@/components/chat/start-side-chat': `export const StartSideChat=()=>null;`,
  './sign-out': `export const signOutAction=async()=>{};`,
};
const bundle = await build({ entryPoints: [entry], outfile: path.join(dir, 'bundle.js'), write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') }, plugins: [{ name: 'synthetic-app-boundaries', setup(build) {
  build.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'tsx', resolveDir: root }));
} }] });
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); const user = url.searchParams.get('user') || 'alice';
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles.find(file => file.path.endsWith('.js')).contents); return; }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css + (bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '')); return; }
  if (url.pathname === '/snapshot') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(snapshot(user))); return; }
  if (url.pathname === '/api/chat/recent-tasks') { res.end('[]'); return; }
  if (['/send', '/navigation'].includes(url.pathname)) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/send') {
      if (body.fail) { res.writeHead(400); res.end(JSON.stringify({error:'Synthetic unsaved send'})); return; }
      users[user].bots = users[user].bots.map(bot => bot.id === body.botId ? { ...bot, lastSentAt: new Date(++clock).toISOString() } : bot);
    } else {
      const ordered = snapshot(user);
      if (body.kind === 'move' && !canMoveNavigationBot(ordered.find(b => b.id === body.botId), ordered.find(b => b.id === body.targetId))) { res.end(JSON.stringify({error:'Invalid move'})); return; }
      const next = changeBotNavigation(ordered, body); users[user].bots = next; users[user].order = next.map(b => b.id);
    }
    res.end('{}'); return;
  }
  res.setHeader('Content-Type', 'text/html'); res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const expanded = () => page.locator('[data-navigation-bot]').evaluateAll(rows => rows.map(row => row.dataset.navigationBot));
  const rail = () => page.locator('[data-rail-bot]').evaluateAll(rows => rows.map(row => row.dataset.railBot));
  const expectOrder = (fn, ids) => expect.poll(fn).toEqual(ids);
  await page.goto(base);
  await expectOrder(expanded, ['p2','p1','a','b','c','d','e']);
  await page.locator('[data-navigation-bot="b"] a').first().click();
  await expectOrder(expanded, ['p2','p1','a','b','c','d','e']); // opening is inert
  await page.getByRole('button', { name: 'Reject send', exact: true }).click();
  await expect(page.getByRole('status').last()).toHaveText('Message rejected');
  await expectOrder(expanded, ['p2','p1','a','b','c','d','e']);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expectOrder(expanded, ['p2','p1','b','a','c','d','e']);
  await page.getByRole('button', { name: 'Background activity', exact: true }).click();
  await expectOrder(expanded, ['p2','p1','b','a','c','d','e']);
  await page.reload(); await expectOrder(expanded, ['p2','p1','b','a','c','d','e']);
  // Real keyboard menu moves pins and appends/unpins a never-used bot.
  await page.getByRole('button', { name: 'Reorder Planning', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  await expectOrder(expanded, ['p1','p2','b','a','c','d','e']);
  await page.getByRole('button', { name: 'Reorder Design', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  await expectOrder(expanded, ['p1','p2','c','b','a','d','e','f']);
  await page.getByRole('button', { name: 'Reorder Design', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
  await expectOrder(expanded, ['p1','p2','b','c','a','d','e']);
  await expect(page.getByRole('button', { name: 'Reorder Engineering', exact: true })).toBeEnabled();
  await page.locator('[data-navigation-bot="b"] a').first().click();
  const screenshotDir = process.env.BOT_RECENT_USE_SCREENSHOT_DIR;
  if (screenshotDir) { await mkdir(screenshotDir, {recursive:true}); await page.screenshot({path:path.join(screenshotDir,'expanded.png')}); }
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
  await expectOrder(rail, ['p1','p2','b','c','a','d']);
  await page.locator('[data-rail-bot="a"]').click();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expectOrder(rail, ['p1','p2','a','b','c','d']);
  await page.getByRole('button', { name: 'Background activity', exact: true }).click();
  await expectOrder(rail, ['p1','p2','a','b','c','d']);
  if (screenshotDir) await page.screenshot({path:path.join(screenshotDir,'collapsed.png')});
  await page.reload(); await expectOrder(rail, ['p1','p2','a','b','c','d']);
  await page.getByRole('button', { name: /All bots, \d+ more/ }).click();
  await expect(page.getByRole('textbox', {name:'Find a bot'})).toBeFocused();
  await page.getByRole('textbox', {name:'Find a bot'}).fill('New bot');
  await expect(page.getByRole('link', {name:/New bot Idle/})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await page.setViewportSize({width:390,height:844});
  await expectOrder(expanded, ['p1','p2','a','b','c','d','e']);
  if (screenshotDir) await page.screenshot({path:path.join(screenshotDir,'mobile.png')});
  await page.setViewportSize({width:1280,height:900}); await page.goto(base+'/?user=bob');
  await expectOrder(expanded, ['p2','p1','a','b','c','d','e']);
  expect(errors).toEqual([]);
  console.log('Bot recent-use browser checks passed: expanded/collapsed, open, accepted/rejected send, reload, background, pin moves, pin/unpin, overflow, mobile and user isolation.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, {recursive:true,force:true}); }
