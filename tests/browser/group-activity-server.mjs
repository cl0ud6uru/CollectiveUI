// Offline harness: production shell/sidebars, fictional roster, no bot/provider calls.
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
const root = process.cwd(), out = '/tmp/collective-group-activity-harness';
await mkdir(out, { recursive: true });
await build({
  stdin: { contents: `
import React from 'react'; import { createRoot } from 'react-dom/client'; import { Tooltip } from 'radix-ui';
import { ShellProvider, useShell } from '@/components/chat/shell-context';
import { BotSection } from '@/components/sidebar/bot-section'; import { AvatarRail } from '@/components/sidebar/avatar-rail';
const names=['Navigator','Researcher','Planner','Analyst','Reviewer','Writer','Extra bot','Hidden bot'];
const bots=names.map((name,i)=>({kind:'bot',id:'b'+i,name,icon:['🧭','🔎','📅','📊','📝','✍️','🧩','🎈'][i],description:'Synthetic preview',label:'Local fixture',hidden:i===7,status:null}));
const user={id:'synthetic-user',name:'Demo User',email:null,isAdmin:false,canCreateBots:false};
const branding={appName:'CollectiveUI',welcomeText:'',logoEmoji:'✨'};
const convs=[{id:'group',title:'Synthetic launch team',botId:null,appId:null,source:'chat',isGroup:true,memberBotIds:['b1','b5','b6'],pinned:false,folderId:null,updatedAt:'2026-10-11'}];
function App(){ const shell=useShell(); window.activityFixture={setStatus:(id,status)=>shell.setChatStatus('cached',id,status)};
return <div className="flex h-screen bg-bg text-fg">{shell.sidebarOpen?<nav aria-label="Expanded sidebar" className="w-[260px] shrink-0 bg-sidebar p-2"><div className="flex h-12 items-center justify-between px-3"><strong>CollectiveUI</strong><button aria-label="Close sidebar" onClick={()=>shell.setSidebarOpen(false)}>◀</button></div><BotSection bots={shell.bots} onNavigate={()=>{}} /></nav>:<AvatarRail/>}<main className="flex min-w-0 flex-1 flex-col"><header className="border-b border-border px-6 py-4 font-semibold">Synthetic launch team</header><section className="flex-1 p-6"><p className="max-w-lg rounded-xl bg-sidebar p-4 text-sm">Researcher, Writer and Extra bot are members of this fictional team. Only the bot executing the current reply should show Working.</p><p className="mt-4 text-xs text-muted">Offline preview · synthetic data</p></section><div className="mx-6 mb-6 rounded-2xl border border-border p-4 text-muted">Message the group…</div></main></div>}
createRoot(document.getElementById('root')).render(<Tooltip.Provider><ShellProvider user={user} branding={branding} bots={bots} apps={[]} conversations={convs} folders={[]} inboxUnread={0}><App/></ShellProvider></Tooltip.Provider>);
`, resolveDir: root, loader: 'tsx' },
  bundle: true, outfile: path.join(out, 'app.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{name:'offline-boundaries',setup(builder){
    builder.onResolve({filter:/^(next\/navigation|next\/link|@\/app\/\(chat\)\/actions|@\/app\/\(chat\)\/bots\/(?:navigation-actions|actions))$/},args=>({path:args.path,namespace:'fixture'}));
    builder.onResolve({filter:/sign-out$/},args=>({path:args.path,namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>{
      if(args.path==='next/link') return {contents:'import React from "react";export default React.forwardRef(({href,prefetch,children,...props},ref)=><a href={href} ref={ref} {...props}>{children}</a>);',loader:'jsx',resolveDir:root};
      if(args.path==='next/navigation')return {contents:'export const useRouter=()=>({refresh(){},push(){}});export const usePathname=()=>"/c/group";',loader:'js'};
      return {contents:'export const duplicateBot=async()=>{throw Error("Disabled in offline preview")};export const signOutAction=async()=>{};export const updateBotNavigation=async()=>({});export const createSideChat=async()=>{throw Error("Disabled in offline preview")};',loader:'js'};
    });
  }}],
});
const css=await postcss([tailwind({base:root})]).process(await readFile('src/app/globals.css','utf8'),{from:path.join(root,'src/app/globals.css')});
await writeFile(path.join(out,'style.css'),css.css);
await writeFile(path.join(out,'index.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CollectiveUI synthetic activity</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
let phase='idle';
const snapshot=()=>Object.fromEntries(Array.from({length:8},(_,i)=>['b'+i,
  phase==='research'&&i===1 || phase==='handoff'&&i===5 || phase==='concurrent'&&[1,5,6].includes(i) || phase==='overflow'&&i<7 ? 'working':phase==='approval'&&i===1?'waiting':null]));
createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/fixture/phase'){phase=url.searchParams.get('value')??'idle';res.end('{}');return;}
  if(url.pathname==='/api/chat/bot-statuses'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(snapshot()));return;}
  if(url.pathname==='/api/chat/recent-tasks'){res.setHeader('Content-Type','application/json');res.end('[]');return;}
  const name=url.pathname==='/app.js'?'app.js':url.pathname==='/style.css'?'style.css':'index.html';
  res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path.join(out,name)));
}).listen(3139,'127.0.0.1',()=>console.log('Offline activity harness http://127.0.0.1:3139'));
