import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Render the production sidebar and shell with synthetic data, without accounts or model calls.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'sidebar-roster-design-'));
const shots = process.env.SIDEBAR_ROSTER_SCREENSHOT_DIR ?? path.join(root, 'docs/screenshots/sidebar-roster');
await mkdir(shots, { recursive: true });
const entry = path.join(dir, 'entry.tsx');
const names = ['LloydGPT', 'Action1 Ops Agent', 'Gemma 4', 'Audit Bot', 'IT Ticket Bot', 'Hermes'];
const previews = ['Yep—today’s big conversation...', 'Workspace ready', 'Good morning! I’m here...', 'Yep—that gives us...', '2 tickets submitted...', 'I’m currently running...'];
const bots = names.map((name, i) => ({ kind: 'bot', id: `bot-${i}`, name, icon: ['blob:circle:blue','blob:hexagon:blue','blob:ghost:grey','blob:triangle:yellow','blob:circle:teal','blob:hexagon:teal'][i], description: null, preview: previews[i], coordinator: i === 0, pinned: i === 0, lastAt: new Date(Date.now() - i * 60000).toISOString() }));
const conversation = (id, title, more = {}) => ({ id, title, botId: null, appId: null, source: 'chat', pinned: false, folderId: null, updatedAt: new Date(Date.now()-(Number(id.split('-').at(-1))||0)*60000).toISOString(), ...more });
const conversations = [conversation('audit-home', 'Audit Bot', { isBotHome: true, botId: 'bot-3' }), conversation('group', 'IT Group', { isGroup: true, memberBotIds: ['bot-2','bot-3','bot-4'] }), ...['Today’s weather forecast', 'Today’s ticket status', 'Action1 investigation', 'Greeting title'].map((title, i) => conversation(`recent-${i}`, title))];
await writeFile(entry, `
import React from 'react';
import { createRoot } from '${root}/node_modules/react-dom/client';
import { Tooltip } from 'radix-ui';
import { ShellProvider, useShell } from '${root}/src/components/chat/shell-context';
import { ChatShell } from '${root}/src/components/chat/chat-shell';
function Controls() { const shell=useShell(); return <><button onClick={()=>shell.setMobileOpen(true)}>Open sidebar</button>{shell.searchOpen && <div role="dialog" aria-label="Search chats"><button onClick={()=>shell.setSearchOpen(false)}>Close search</button></div>}<p>Private synthetic sidebar fixture</p></>; }
const initial={bots:${JSON.stringify(bots)},conversations:${JSON.stringify(conversations)},apps:[],folders:[],inboxUnread:2,user:{id:'fixture',name:'Jason Hartley',email:'jhartley@lloydmc.com',isAdmin:true,canCreateBots:true},branding:{appName:'LloydGPT',welcomeText:'',logoEmoji:''}};
createRoot(document.getElementById('root')).render(<Tooltip.Provider><ShellProvider {...initial}><ChatShell><Controls/></ChatShell></ShellProvider></Tooltip.Provider>);
`);
const noAction = 'async()=>{}';
const actions = Object.fromEntries(['archiveConversation','createFolder','deleteConversation','deleteFolder','moveConversationToFolder','renameConversation','renameFolder','setConversationPinned','refreshBotStatuses'].map(name=>[name,noAction]));
const stubs = {
 'next/navigation': `export const usePathname=()=>'/c/audit-home';export const useRouter=()=>({refresh:()=>{},push:href=>{window.fixtureNavigation=href;}});`,
 'next/link': `import React from 'react';export default function Link({href,prefetch,onClick,children,...props}){return <a href={href} {...props} onClick={e=>{e.preventDefault();onClick?.(e);window.fixtureNavigation=href;}}>{children}</a>;}`,
 '@/app/(chat)/actions': Object.entries(actions).map(([name,value])=>`export const ${name}=${value};`).join(''),
 '@/app/(chat)/bots/navigation-actions': 'export const updateBotNavigation=async()=>({});',
 '@/app/(chat)/bots/actions': 'export const duplicateBot=async()=>({id:"copy"});',
 '@/components/chat/start-side-chat': 'export const StartSideChat=()=>null;',
 '@/components/bots/new-group-dialog': 'import React from "react";export const NewGroupDialog=({trigger})=>trigger;',
 './search-dialog': 'export const SearchDialog=()=>null;',
 './sign-out': 'export const signOutAction=async()=>{};',
};
const bundle = await build({ entryPoints:[entry],outfile:path.join(dir,'bundle.js'),write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src')},plugins:[{name:'synthetic-boundaries',setup(build){build.onResolve({filter:/.*/},args=>stubs[args.path]?{path:args.path,namespace:'fixture'}:undefined);build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'tsx',resolveDir:root}));}}] });
const css = await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
const server=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles.find(file=>file.path.endsWith('.js')).contents);return;}if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end('[]');return;}res.setHeader('Content-Type','text/html');res.end('<html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const nav=page.getByRole('navigation',{name:'Main navigation'});
 await expect(nav).toBeVisible();await expect(nav.locator('[data-navigation-bot]')).toHaveCount(6);
 await expect(nav.locator('[data-navigation-bot="bot-0"] [aria-label="Default coordinator"]')).toBeVisible();
 await expect(nav.locator('[data-navigation-bot="bot-0"]')).not.toContainText('Default coordinator');
 const star=nav.locator('[aria-label="Default coordinator"]');await star.focus();await expect(page.getByRole('tooltip')).toHaveText('Default coordinator');await page.keyboard.press('Escape');await star.blur();
 await expect(nav.locator('#sidebar-projects')).toBeHidden();
 await nav.getByRole('button',{name:'Projects',exact:true}).click();await expect(nav.getByText('No projects yet')).toBeVisible();await nav.getByRole('button',{name:'Projects',exact:true}).click();
 await nav.getByRole('button',{name:'Groups',exact:true}).click();await expect(nav.getByRole('link',{name:'IT Group'})).toBeHidden();await nav.getByRole('button',{name:'Groups',exact:true}).click();
 await expect(nav.locator('#sidebar-recent a')).toHaveCount(2);
 await nav.getByRole('button',{name:'See all history'}).click();await expect(nav.locator('#sidebar-recent a')).toHaveCount(4);await nav.getByRole('button',{name:'Show less history'}).click();
 await nav.getByRole('button',{name:'Search chats',exact:true}).click();await expect(page.getByRole('dialog',{name:'Search chats'})).toBeVisible();await page.getByRole('button',{name:'Close search'}).click();
 await nav.getByRole('link',{name:'Browse bots',exact:true}).click();expect(await page.evaluate(()=>window.fixtureNavigation)).toBe('/bots');
 await expect(nav.getByRole('link',{name:'Hermes',exact:true})).toHaveCount(0);
 await nav.getByRole('link',{name:'Inbox',exact:false}).click();expect(await page.evaluate(()=>window.fixtureNavigation)).toBe('/inbox');
 await nav.getByRole('button',{name:'Jason Hartley',exact:false}).click();await expect(page.getByRole('menuitem',{name:'Admin panel'})).toBeVisible();await page.keyboard.press('Escape');
 await nav.evaluate(el=>el.querySelector('.overflow-y-auto').scrollTop=0);await page.mouse.move(700,20);await nav.screenshot({path:path.join(shots,'desktop.png')});
 for(const width of [320,390]) {await page.setViewportSize({width,height:844});await page.getByRole('button',{name:'Open sidebar',exact:true}).click();const drawer=page.getByRole('navigation',{name:'Main navigation'}).filter({visible:true});await expect(drawer).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(drawer.getByRole('link',{name:'Inbox',exact:false})).toBeInViewport();await drawer.screenshot({path:path.join(shots,`mobile-${width}.png`)});await drawer.locator('[data-navigation-bot="bot-3"] a').click();await expect(drawer).toBeHidden();}
 expect(errors).toEqual([]);
 console.log('PASS: actual Sidebar/ChatShell; coordinator star and keyboard tooltip; Groups/Projects toggle; complete history reachable; Search opens; utility links; profile admin menu; 320px/390px mobile drawer closes on navigation; footer remains visible; no page errors.');
} finally {await browser.close();server.close();await rm(dir,{recursive:true,force:true});}
