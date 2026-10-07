import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real Next navigation and production UI, with synthetic account/service boundaries.
// No database, login, runtime provisioning or external requests.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const fixture = await mkdtemp(path.join(tmpdir(), 'hermes-settings-next-'));
const evidence = process.env.HERMES_NAV_EVIDENCE_DIR ?? path.join(tmpdir(), 'hermes-nav-evidence');
await mkdir(evidence, { recursive: true });
const write = async (name, contents) => {
  const target = path.join(fixture, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
};
await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
await write('package.json', JSON.stringify({ private: true, type: 'module' }));
await write('stubs.tsx', `
export const Empty = () => null;
export { Empty as WorkspacePanel, Empty as StartTargetSelect, Empty as SearchDialog, Empty as NewGroupDialog, Empty as StartSideChat };
export const ChatGPTConnection = () => <section className="h-[850px] rounded-xl border border-border p-4">Synthetic connected account before Hermes</section>;
const forbidden = async () => { throw new Error('Unexpected fixture mutation'); };
export { forbidden as archiveConversation, forbidden as clearMemories, forbidden as deleteAllConversations, forbidden as deleteMemory, forbidden as revokeToolGrant, forbidden as saveMemory, forbidden as setMemoryPinned, forbidden as updatePrefs, forbidden as createFolder, forbidden as deleteConversation, forbidden as deleteFolder, forbidden as moveConversationToFolder, forbidden as renameConversation, forbidden as renameFolder, forbidden as setConversationPinned, forbidden as duplicateBot, forbidden as updateBotNavigation, forbidden as signOutAction, forbidden as signIntoRemoteHermes, forbidden as loadRemoteHermesProfiles, forbidden as enablePersonalHermes, forbidden as finishPersonalHermes, forbidden as linkPersonalHermesBot, forbidden as stopPersonalHermes };
export const refreshBotStatuses = async () => null;
export const personalHermesStatus = async () => ({ phase:'disabled', bindings:[], unlinked:[] });
export const requirePagePrincipal = async () => ({ user:{id:'synthetic-owner'} });
export const getSetting = async () => ({ enabled:true });
export const listRemoteConnections = async () => [{id:'fixture',name:'Saved remote',baseUrl:'https://example.test'}];
export const db = { select:() => ({ from:() => ({ innerJoin:() => ({ where:() => ({ orderBy:() => ({ limit:async () => [{id:'session',title:'Existing remote chat',profile:'default',connectionId:'fixture',connectionName:'Saved remote',status:'idle'}] }) }) }) }) }) };
`);
const boundaries = [
  '@/app/(chat)/actions', '@/app/(chat)/bots/actions', '@/app/(chat)/bots/navigation-actions',
  '@/app/(chat)/settings/hermes-actions', '@/app/(chat)/settings/remote-hermes-actions',
  '@/components/settings/chatgpt-connection', '@/components/settings/workspace-panel',
  '@/components/start-target-select', '@/components/chat/search-dialog', '@/components/chat/start-side-chat',
  '@/components/bots/new-group-dialog', './sign-out', '@/lib/session', '@/lib/settings',
  '@/lib/remote-hermes/store', '@/db',
];
await write('next.config.mjs', `
export default {
  experimental:{externalDir:true},
  webpack(config) {
    Object.assign(config.resolve.alias, ${JSON.stringify(Object.fromEntries(boundaries.map(name => [name + '$', path.join(fixture, 'stubs.tsx')])))}, {'@':${JSON.stringify(path.join(root, 'src'))}});
    return config;
  },
};
`);
await write('postcss.config.mjs', `export default {plugins:{'@tailwindcss/postcss':{base:${JSON.stringify(root)}}}};`);
await write('app/layout.tsx', `
import '${root}/src/app/globals.css';
import Providers from './providers';
export default function Layout({children}) { return <html lang="en" suppressHydrationWarning><body><Providers>{children}</Providers></body></html>; }
`);
await write('app/providers.tsx', `
'use client';
import {Tooltip} from 'radix-ui';
import {ThemeProvider} from 'next-themes';
import {ShellProvider} from '${root}/src/components/chat/shell-context';
import {ChatShell} from '${root}/src/components/chat/chat-shell';
export default function Providers({children}) {
  return <ThemeProvider attribute="class"><Tooltip.Provider><ShellProvider bots={[]} apps={[]} folders={[]} conversations={[]} inboxUnread={0} user={{id:'synthetic-owner',name:'Synthetic owner',email:'owner@example.test',isAdmin:false,canCreateBots:false}} branding={{appName:'CollectiveUI',welcomeText:'',logoEmoji:''}}><ChatShell>{children}</ChatShell></ShellProvider></Tooltip.Provider></ThemeProvider>;
}
`);
await write('app/hermes/page.tsx', `export {default} from '${root}/src/app/(chat)/hermes/page';`);
await write('app/page.tsx', `
import Link from 'next/link';
import {PageFrame} from '${root}/src/components/page-frame';
export default function Home() { return <PageFrame title="Navigation fixture"><Link href="/hermes">Existing Hermes link</Link></PageFrame>; }
`);
await write('app/settings/page.tsx', `
'use client';
import {useSearchParams} from 'next/navigation';
import {PageFrame} from '${root}/src/components/page-frame';
import {SettingsView} from '${root}/src/components/settings-view';
import {PersonalHermes} from '${root}/src/components/settings/personal-hermes';
import {RemoteHermes} from '${root}/src/components/settings/remote-hermes';
export default function Settings() {
  const unavailable = useSearchParams().get('unavailable') === '1';
  return <PageFrame title="Settings"><SettingsView prefs={{}} apps={[]} bots={[]} memories={[]} archived={[]} grants={[]} user={{name:'Synthetic owner',upn:'owner@example.test',authSource:'local'}} chatgpt={unavailable ? null : {allowed:true,pending:null,connection:null}} workspace={null} security={<h2>Security fixture</h2>} hermes={unavailable ? null : <><PersonalHermes canCreate={false}/><RemoteHermes allowed={true} initial={[{id:'fixture',name:'Saved remote',baseUrl:'https://example.test'}]}/><div className="h-[850px]" aria-hidden="true"/></>}/></PageFrame>;
}
`);
const portServer = createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const base = `http://127.0.0.1:${port}`;
const logPath = path.join(evidence, 'next-fixture.log');
const log = openSync(logPath, 'w');
const next = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '-H', '127.0.0.1', '-p', String(port)], {
  cwd:fixture, env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}, stdio:['ignore', log, log],
});
let browser;
try {
  const readyUntil = Date.now() + 90_000;
  while (true) {
    if (next.exitCode !== null) throw new Error(`Next fixture exited with ${next.exitCode}; see ${logPath}`);
    try { if ((await fetch(base)).ok) break; } catch { /* Wait for the local dev server. */ }
    if (Date.now() > readyUntil) throw new Error(`Next fixture did not become ready; see ${logPath}`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors = [], unexpectedApi = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname === '/api/chat/recent-tasks') return route.fulfill({contentType:'application/json',body:'[]'});
    if (url.pathname.startsWith('/api/')) { unexpectedApi.push(url.pathname); return route.abort(); }
    return route.continue();
  });
  const sections = () => page.getByRole('navigation', {name:'Settings sections'});
  const currentAccounts = () => sections().getByRole('button', {name:'Connected accounts',exact:true});
  const remoteTitle = () => page.getByRole('heading', {name:'Remote Hermes',exact:true});
  const expectTarget = async () => {
    await expect(currentAccounts()).toHaveAttribute('aria-current','page');
    await expect(remoteTitle()).toBeFocused();
    await expect(remoteTitle()).toBeInViewport();
    const top = await remoteTitle().evaluate(el => el.getBoundingClientRect().top);
    expect(top).toBeGreaterThanOrEqual(56);
    expect(top).toBeLessThan(120);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  };
  await page.goto(base + '/hermes');
  await expect(page.getByRole('heading', {name:'Hermes',exact:true})).toBeVisible();
  await expect(page.getByRole('link', {name:'Hermes',exact:true})).toHaveCount(0);
  await expect(page.getByRole('link', {name:'Existing remote chat'})).toHaveAttribute('href','/hermes/fixture?session=session');
  await page.getByRole('button', {name:'Close sidebar',exact:true}).click();
  const rail = page.getByRole('navigation', {name:'Collapsed sidebar'});
  await expect(rail.getByRole('link', {name:'Hermes',exact:true})).toHaveCount(0);
  await expect(rail.getByRole('link', {name:'Settings',exact:true})).toBeVisible();
  await rail.getByRole('button', {name:'Open sidebar',exact:true}).click();
  await page.getByRole('link', {name:'Manage Hermes connections',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(base + '/settings?tab=connected-accounts&section=remote-hermes');
  await expectTarget();
  await page.screenshot({path:path.join(evidence,'desktop.png')});
  // Next's native-history integration must update the mounted SettingsView.
  await sections().getByRole('button', {name:'General',exact:true}).click();
  await expect(page).toHaveURL(base + '/settings');
  await expect(remoteTitle()).toHaveCount(0);
  await page.goBack();
  await expectTarget();
  await page.goForward();
  await expect(sections().getByRole('button', {name:'General',exact:true})).toHaveAttribute('aria-current','page');
  await expect(remoteTitle()).toHaveCount(0);
  for (const width of [320,390,768,1280]) {
    await page.setViewportSize({width,height:844});
    await page.goto(base + '/settings?tab=connected-accounts&section=remote-hermes');
    await expectTarget();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await currentAccounts().evaluate(el => {
      const parent = el.parentElement.getBoundingClientRect(), item = el.getBoundingClientRect();
      return item.left >= parent.left - 1 && item.right <= parent.right + 1;
    })).toBe(true);
    if (width === 390) await page.screenshot({path:path.join(evidence,'mobile.png')});
    await page.reload();
    await expectTarget();
  }
  await page.goto(base + '/settings?tab=connected-accounts&section=personal-hermes');
  const personal = page.locator('details').filter({has:page.locator('#personal-hermes-title')}).first();
  await expect(personal).toHaveAttribute('open','');
  await expect(page.locator('#personal-hermes-title')).toBeFocused();
  await expect(page.locator('#personal-hermes-title')).toBeInViewport();
  await sections().getByRole('button', {name:'Security',exact:true}).click();
  await expect(page).toHaveURL(base + '/settings?tab=security');
  await page.goBack();
  await expect(personal).toHaveAttribute('open','');
  await expect(page.locator('#personal-hermes-title')).toBeFocused();
  await page.goto(base + '/settings?tab=connected-accounts&section=remote-hermes&unavailable=1');
  await expect(sections().getByRole('button', {name:'General',exact:true})).toHaveAttribute('aria-current','page');
  await expect(currentAccounts()).toHaveCount(0);
  await expect(remoteTitle()).toHaveCount(0);
  // Real mobile drawer and account menu must retain the ordinary Settings entry.
  await page.setViewportSize({width:390,height:844});
  await page.goto(base + '/hermes');
  await page.getByRole('button', {name:'Open sidebar',exact:true}).click();
  await expect(page.getByRole('link', {name:'Hermes',exact:true})).toHaveCount(0);
  await page.getByRole('button', {name:/Synthetic owner/}).click();
  await page.getByRole('menuitem', {name:'Settings',exact:true}).click();
  await expect(page).toHaveURL(base + '/settings');
  await expect(page.getByRole('button', {name:'Close sidebar',exact:true})).toHaveCount(0);
  await sections().getByRole('button', {name:'Connected accounts',exact:true}).click();
  await expect(remoteTitle()).toBeVisible();
  await page.goto(base + '/settings?tab=connected-accounts&section=unknown');
  await expect(currentAccounts()).toHaveAttribute('aria-current','page');
  expect(errors).toEqual([]);
  expect(unexpectedApi).toEqual([]);
  console.log('PASS: actual Next router, Manage link, keyboard focus, section scroll, reload, Back/Forward, personal deep link, unavailable/unknown section, expanded/rail/mobile Settings navigation, 320–1280px actual CSS; synthetic services only.');
  console.log(`Evidence: ${evidence}`);
} finally {
  await browser?.close();
  next.kill('SIGTERM');
  await new Promise(resolve => { if (next.exitCode !== null) resolve(); else next.once('exit',resolve); });
  closeSync(log);
  await rm(fixture, {recursive:true,force:true});
}
