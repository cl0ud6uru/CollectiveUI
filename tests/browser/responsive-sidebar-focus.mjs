import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Render the production shell and sidebar with synthetic data, without accounts or model calls.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'responsive-sidebar-focus-'));
const entry = path.join(dir, 'entry.tsx');
await import('node:fs/promises').then(({ writeFile }) => writeFile(entry, `
import React from 'react';
import { createRoot } from '${root}/node_modules/react-dom/client';
import { Tooltip } from 'radix-ui';
import { ShellProvider, useShell } from '${root}/src/components/chat/shell-context';
import { ChatShell } from '${root}/src/components/chat/chat-shell';
function Controls() { const shell=useShell(); return <><button id="open" onClick={()=>shell.setMobileOpen(true)}>Open sidebar</button><button id="start-side-chat">Start side chat</button></>; }
const bots=[{kind:'bot',id:'bot-a',name:'Alpha',icon:null,description:'Fixture bot',label:null,pinned:true},{kind:'bot',id:'bot-b',name:'Beta',icon:null,description:'Fixture bot',label:null,pinned:true}];
const conversations=[{id:'chat-fixture',title:'Fixture chat',pinned:false,folderId:null,botId:null,appId:null,source:'chat',updatedAt:'2026-10-15T00:00:00.000Z'}];
const folders=[{id:'folder-fixture',name:'Example project'}];
const initial={bots,conversations,apps:[],folders,inboxUnread:0,user:{id:'fixture',name:'Demo User',email:'demo@example.invalid',isAdmin:false,canCreateBots:true},branding:{appName:'CollectiveUI',welcomeText:'',logoEmoji:''}};
createRoot(document.getElementById('root')).render(<Tooltip.Provider><ShellProvider {...initial}><ChatShell><Controls/></ChatShell></ShellProvider></Tooltip.Provider>);
`));
const noAction = 'async()=>{}';
const actions = Object.fromEntries(['archiveConversation','createFolder','deleteConversation','deleteFolder','moveConversationToFolder','renameConversation','renameFolder','setConversationPinned','refreshBotStatuses'].map(name=>[name,noAction]));
const stubs = {
  'next/navigation': `export const usePathname=()=>'/';export const useRouter=()=>({refresh:()=>{},push:()=>{}});`,
  'next/link': `import React from 'react';export default function Link({href,onClick,children,...props}){return <a href={href} {...props} onClick={e=>{e.preventDefault();onClick?.(e);}}>{children}</a>;}`,
  '@/app/(chat)/actions': Object.entries(actions).map(([name,value])=>`export const ${name}=${value};`).join(''),
  '@/app/(chat)/bots/navigation-actions': 'export const updateBotNavigation=async()=>({});',
  '@/app/(chat)/bots/actions': 'export const duplicateBot=async()=>({id:"copy"});export const createGroupChat=async()=>({id:"group-fixture"});',
  '@/components/chat/start-side-chat': 'export const StartSideChat=()=>null;',
  './sign-out': 'export const signOutAction=async()=>{};',
};
const bundle = await build({ entryPoints:[entry], outfile:path.join(dir,'bundle.js'), write:false, bundle:true, platform:'browser', format:'iife', jsx:'automatic', nodePaths:[path.join(root,'node_modules')], alias:{'@':path.join(root,'src')}, plugins:[{name:'synthetic-boundaries',setup(build){build.onResolve({filter:/.*/},args=>stubs[args.path]?{path:args.path,namespace:'fixture'}:undefined);build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'tsx',resolveDir:root}));}}] });
const css = await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
const server = createServer((req,res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type','application/javascript'); res.end(bundle.outputFiles.find(file=>file.path.endsWith('.js')).contents); return; }
  if (req.url === '/style.css') { res.setHeader('Content-Type','text/css'); res.end(css.css); return; }
  res.setHeader('Content-Type','text/html'); res.end('<html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try {
  const page = await browser.newPage({viewport:{width:590,height:900}});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const opener = page.getByRole('button',{name:'Open sidebar'});
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog',{name:'Main navigation drawer'});
  await expect(dialog).toBeVisible();
  await expect(page.locator('main')).toHaveJSProperty('inert',true);
  const close = dialog.getByRole('button',{name:'Close sidebar'});
  await expect(close).toBeFocused();
  await page.keyboard.press('Control+k');
  const searchDialog = page.getByRole('dialog',{name:'Search chats'});
  await expect(searchDialog).toBeVisible();
  await expect(searchDialog.getByPlaceholder('Search chats and bots...')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(searchDialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(searchDialog).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(page.locator('main')).toHaveJSProperty('inert',true);
  await dialog.getByRole('button',{name:'New group chat'}).click();
  const groupDialog = page.getByRole('dialog',{name:'New group chat'});
  await expect(groupDialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(groupDialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(groupDialog).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(page.locator('main')).toHaveJSProperty('inert',true);
  const chatOptions = dialog.getByRole('button',{name:'Chat options'}).first();
  await chatOptions.click();
  const menu = page.getByRole('menu').first();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem',{name:'Move to project'}).focus();
  await page.keyboard.press('ArrowRight');
  const submenu = page.getByRole('menu').last();
  await expect(submenu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(submenu.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Shift+Tab');
  await expect(submenu.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(page.locator('main')).toHaveJSProperty('inert',true);
  for (let i=0; i<24; i++) {
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    expect(await page.evaluate(()=>document.activeElement?.id)).not.toBe('start-side-chat');
  }
  for (let i=0; i<24; i++) {
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    expect(await page.evaluate(()=>document.activeElement?.id)).not.toBe('start-side-chat');
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'Close sidebar'}).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.setViewportSize({width:1280,height:900});
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('main')).toHaveJSProperty('inert',false);
  await expect(page.locator('#start-side-chat')).toBeVisible();
  await page.locator('#start-side-chat').focus();
  await expect(page.locator('#start-side-chat')).toBeFocused();
  await page.setViewportSize({width:590,height:900});
  await expect(page.locator('main')).toHaveJSProperty('inert',false);
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  console.log('Responsive sidebar containment, nested dialogs/menus, close/focus restoration, and desktop resize recovery passed.');
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
  await rm(dir,{recursive:true,force:true});
}
