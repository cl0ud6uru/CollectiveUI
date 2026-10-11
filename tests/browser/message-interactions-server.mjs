// Production Chat/Composer/Message UI; synthetic transcript and loopback-only transport.
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
const root = process.env.COLLECTIVE_UI_SOURCE_ROOT ?? process.cwd(), port = Number(process.env.INTERACTIONS_PORT ?? 3140);
const out = '/tmp/collective-message-interactions-harness-' + port;
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root,
  stdin: { contents: `
import React from 'react'; import { createRoot } from 'react-dom/client'; import { Tooltip } from 'radix-ui';
import { ShellProvider } from '@/components/chat/shell-context'; import { Chat } from '@/components/chat/chat';
const members=[{kind:'bot',id:'researcher',name:'Researcher',icon:'🔎',description:'Synthetic researcher'}, {kind:'bot',id:'writer',name:'Writer',icon:'✍️',description:'Synthetic writer'}];
const target={kind:'group',id:'synthetic-group',name:'Synthetic launch team',icon:null,description:null,members};
const initialRows=[
{id:'source-question',parentId:null,createdAt:1,feedback:null,message:{id:'source-question',role:'user',parts:[{type:'text',text:'What should the team prepare for launch?'}]}},
{id:'source-answer',parentId:'source-question',createdAt:2,feedback:null,message:{id:'source-answer',role:'assistant',parts:[
{type:'data-speaker',data:{botId:'researcher',name:'Researcher',icon:'🔎'}},{type:'text',text:'Research findings: focus on a small pilot before launch.'},
{type:'data-speaker',data:{botId:'writer',name:'Writer',icon:'✍️'}},{type:'text',text:'First draft: announce the pilot and invite feedback.'},
{type:'data-speaker',data:{botId:'researcher',name:'Researcher',icon:'🔎'}},{type:'text',text:'Revised findings: measure the pilot before expanding.'}]}}
];
const user={id:'synthetic-user',name:'Demo User',email:null,isAdmin:false,canCreateBots:false};
const branding={appName:'CollectiveUI',welcomeText:'',logoEmoji:'✨'};
const convs=[{id:'synthetic-group',title:target.name,botId:null,appId:null,source:'chat',isGroup:true,memberBotIds:members.map(b=>b.id),pinned:false,folderId:null,updatedAt:'2026-10-11'}];
const params=new URLSearchParams(location.search);
if(params.has('branches'))initialRows.push({id:'alternate-answer',parentId:'source-question',createdAt:3,feedback:null,message:{id:'alternate-answer',role:'assistant',parts:[{type:'data-speaker',data:{botId:'writer',name:'Writer'}},{type:'text',text:'Alternate draft version.'}]}});
if(params.has('attachment'))initialRows[0].message.parts=[{type:'file',mediaType:'application/pdf',filename:'synthetic.pdf',url:'/api/files/fixture'}];
createRoot(document.getElementById('root')).render(<Tooltip.Provider><ShellProvider user={user} branding={branding} bots={members} apps={[]} conversations={convs} folders={[]} inboxUnread={0}><div className="h-dvh bg-bg text-fg"><Chat conversationId="synthetic-group" isNew={false} target={target} initialRows={initialRows} initialLeafId="source-answer" unavailable={params.has('readonly')} /></div></ShellProvider></Tooltip.Provider>);
`, resolveDir: root, loader: 'tsx' },
  bundle: true, outfile: path.join(out, 'app.js'), jsx: 'automatic', define: { 'process.env': '{}', 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name:'offline-boundaries', setup(builder) {
    builder.onResolve({filter:/^(next\/navigation|next\/link)$/},args=>({path:args.path,namespace:'fixture'}));
    builder.onResolve({filter:/^@\/app\/.*actions$/},args=>({path:args.path,namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},async(args)=>{
      if(args.path==='next/link') return {contents:'import React from "react";export default React.forwardRef(({href,prefetch,children,...props},ref)=><a href={href} ref={ref} {...props}>{children}</a>);',loader:'jsx',resolveDir:root};
      if(args.path==='next/navigation') return {contents:'const router={refresh(){},push(){}};export const useRouter=()=>router;export const usePathname=()=>"/c/synthetic-group";export const useSearchParams=()=>new URLSearchParams(location.search);',loader:'js'};
      const source=await readFile(path.join(root,'src',args.path.slice(2)+'.ts'),'utf8');
      const names=[...source.matchAll(/export (?:async )?function (\w+)/g)].map(m=>m[1]);
      return {contents:names.map(name=>`export const ${name}=async()=>${name==='refreshBotStatuses'?'({researcher:null,writer:null})':name==='setConversationLeaf'?'undefined':'{throw Error("Disabled in offline preview")}'};`).join('\n'),loader:'js'};
    });
  }}],
});
const css=await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
await writeFile(path.join(out,'style.css'),css.css);
await writeFile(path.join(out,'index.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CollectiveUI synthetic replies</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
let requests=[], reject=false, failStream=false;
const json=(res,data)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/fixture/requests'){json(res,requests);return;}
  if(url.pathname==='/fixture/reset'){requests=[];reject=url.searchParams.has('reject');failStream=url.searchParams.has('stream-failure');json(res,{});return;}
  if(url.pathname==='/api/chat'&&req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk;
    const input=JSON.parse(body);requests.push(input);
    if(reject){res.statusCode=400;json(res,{error:'Synthetic rejected reply',unsavedMessageId:input.message?.id});return;}
    res.setHeader('Content-Type','text/event-stream');res.setHeader('x-vercel-ai-ui-message-stream','v1');
    if(failStream){
      for(const part of [{type:'start',messageId:'fixture-partial'},{type:'data-speaker',data:{botId:'writer',name:'Writer'}},{type:'text-start',id:'text'},{type:'text-delta',id:'text',delta:'Synthetic partial draft.'},{type:'text-end',id:'text'},{type:'error',errorText:'Synthetic interrupted stream'}])res.write('data: '+JSON.stringify(part)+'\n\n');
      res.end('data: [DONE]\n\n');return;
    }
    for(const part of [{type:'start',messageId:'fixture-response-'+requests.length},{type:'text-start',id:'text'},{type:'text-delta',id:'text',delta:'Synthetic reply accepted.'},{type:'text-end',id:'text'},{type:'finish'}])res.write('data: '+JSON.stringify(part)+'\n\n');
    res.end('data: [DONE]\n\n');return;
  }
  if(url.pathname.startsWith('/api/')){
    json(res,url.pathname.endsWith('/approvals')?{requests:[]}:url.pathname==='/api/chat/native-search'?{mode:'off',reason:'Synthetic fixture',maxCalls:2}:url.pathname==='/api/workspace/status'?{available:false}:url.pathname==='/api/chat/commands'?{commands:[],skills:[],revision:0}:[]);return;
  }
  const name=['/app.js','/app.css','/style.css'].includes(url.pathname)?url.pathname.slice(1):'index.html';
  res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path.join(out,name)));
}).listen(port,'127.0.0.1',()=>console.log('Offline message harness http://127.0.0.1:'+port));
