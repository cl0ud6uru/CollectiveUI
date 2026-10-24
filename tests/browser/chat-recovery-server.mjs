// Production Chat/Composer/Message UI; synthetic transcript and loopback-only transport.
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
const root = process.env.COLLECTIVE_UI_SOURCE_ROOT ?? process.cwd(), port = Number(process.env.CHAT_RECOVERY_PORT ?? 3152);
const out = '/tmp/collective-chat-recovery-harness-' + port;
const seedRows=[
{id:'source-question',parentId:null,createdAt:1,feedback:null,message:{id:'source-question',role:'user',parts:[{type:'text',text:'What should the team prepare for launch?'}]}},
{id:'source-answer',parentId:'source-question',createdAt:2,feedback:null,message:{id:'source-answer',role:'assistant',parts:[
{type:'data-speaker',data:{botId:'researcher',name:'Researcher',icon:'🔎'}},{type:'text',text:'Research findings: focus on a small pilot before launch.'},
{type:'data-speaker',data:{botId:'writer',name:'Writer',icon:'✍️'}},{type:'text',text:'First draft: announce the pilot and invite feedback.'},
{type:'data-speaker',data:{botId:'researcher',name:'Researcher',icon:'🔎'}},{type:'text',text:'Revised findings: measure the pilot before expanding.'}]}}
];
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root,
  stdin: { contents: `
import React from 'react'; import { createRoot } from 'react-dom/client'; import { Tooltip } from 'radix-ui';
import { ShellProvider } from '@/components/chat/shell-context'; import { Chat } from '@/components/chat/chat';
const members=[{kind:'bot',id:'researcher',name:'Researcher',icon:'🔎',description:'Synthetic researcher'}, {kind:'bot',id:'writer',name:'Writer',icon:'✍️',description:'Synthetic writer'}];
const target={kind:'app',id:'synthetic-group',name:'Synthetic launch team',icon:null,description:null,members};
const initialRows=${JSON.stringify(seedRows)};
const user={id:'synthetic-user',name:'Demo User',email:null,isAdmin:false,canCreateBots:false};
const branding={appName:'CollectiveUI',welcomeText:'',logoEmoji:'✨'};
const convs=[{id:'synthetic-group',title:target.name,botId:null,appId:null,source:'chat',isGroup:true,memberBotIds:members.map(b=>b.id),pinned:false,folderId:null,updatedAt:'2026-10-11'}];
const params=new URLSearchParams(location.search);
if(params.has('empty')) initialRows.length=0;
if(params.has('approval')) initialRows[1].message.parts=[{type:'tool-synthetic_write',toolCallId:'fixture-tool',state:'approval-requested',input:{value:'synthetic'},approval:{id:'fixture-approval'}}];
if(params.has('branches'))initialRows.push({id:'alternate-answer',parentId:'source-question',createdAt:3,feedback:null,message:{id:'alternate-answer',role:'assistant',parts:[{type:'data-speaker',data:{botId:'writer',name:'Writer'}},{type:'text',text:'Alternate draft version.'}]}});
if(params.has('attachment'))initialRows[0].message.parts=[{type:'file',mediaType:'application/pdf',filename:'synthetic.pdf',url:'/api/files/fixture'}];
createRoot(document.getElementById('root')).render(<Tooltip.Provider><ShellProvider user={user} branding={branding} bots={members} apps={[]} conversations={convs} folders={[]} inboxUnread={0}><div className="h-dvh bg-bg text-fg"><Chat conversationId="synthetic-group" isNew={params.has('empty')} target={target} initialRows={initialRows} initialLeafId={initialRows.at(-1)?.id ?? null} unavailable={params.has('readonly')} /></div></ShellProvider></Tooltip.Provider>);
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
let requests = [], stopRequests = [], active = false, rows = structuredClone(seedRows);
let sendMode = 'stream', stopMode = 'success', snapshotError = false;
const streams = new Set(), delayed = [];
const json = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
const row = (message, parentId) => ({ id: message.id, parentId, createdAt: Date.now(), feedback: null, message });
const closeStreams = () => { for (const res of streams) res.end('data: [DONE]\n\n'); streams.clear(); };
const snapshot = () => ({ conversationId: 'synthetic-group', initialRows: rows, initialLeafId: rows.at(-1)?.id ?? null,
  run: active ? { id: 'fixture-run', status: 'running', segment: 0 } : null, resume: active });
const admit = input => {
  if (input.message.role === 'assistant') rows = rows.map(r => r.id === input.message.id ? { ...r, message: input.message } : r);
  else rows.push(row(input.message, input.parentId));
  active = true;
};
const finish = () => {
  active = false;
  rows = rows.map(r => ({ ...r, message: { ...r.message, parts: r.message.parts.map(p => p.state === 'approval-responded'
    ? { ...p, state: 'output-error', errorText: 'Stopped before it ran.' } : p) } }));
};
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/fixture/state') { json(res, { requests, stopRequests, streams: streams.size, active }); return; }
  if (url.pathname === '/fixture/reset') {
    closeStreams(); for (const done of delayed.splice(0)) done();
    requests = []; stopRequests = []; active = false; rows = url.searchParams.has('empty') ? [] : structuredClone(seedRows);
    if (url.searchParams.has('approval')) rows[1].message.parts = [{ type: 'tool-synthetic_write', toolCallId: 'fixture-tool', state: 'approval-requested', input: { value: 'synthetic' }, approval: { id: 'fixture-approval' } }];
    sendMode = 'stream'; stopMode = 'success'; snapshotError = false; json(res, {}); return;
  }
  if (url.pathname === '/fixture/config') {
    let body = ''; for await (const chunk of req) body += chunk;
    const config = JSON.parse(body); sendMode = config.send ?? sendMode; stopMode = config.stop ?? stopMode; snapshotError = config.snapshotError ?? snapshotError;
    json(res, {}); return;
  }
  if (url.pathname === '/fixture/release') { for (const done of delayed.splice(0, url.searchParams.has('first') ? 1 : delayed.length)) done(); json(res, {}); return; }
  if (url.pathname === '/fixture/finish') { finish(); closeStreams(); json(res, {}); return; }
  if (url.pathname === '/api/chat/synthetic-group/stop') {
    let body = ''; for await (const chunk of req) body += chunk; stopRequests.push(JSON.parse(body));
    if (stopMode === 'fail') { res.statusCode = 503; json(res, { error: 'Synthetic cancellation failure' }); return; }
    if (stopMode === 'noop') { json(res, { cancelled: 0, signalled: 0 }); return; }
    if (stopMode === 'unrelated') { json(res, { cancelled: 1, signalled: 0 }); return; }
    const stop = () => { finish(); json(res, { cancelled: 0, signalled: 1 }); };
    if (stopMode === 'delayed') delayed.push(stop); else stop(); return;
  }
  if (url.pathname === '/api/chat/synthetic-group') {
    if (snapshotError) { res.statusCode = 503; json(res, { error: 'Synthetic snapshot failure' }); }
    else json(res, snapshot()); return;
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    if (sendMode === 'reject') {
      delayed.push(() => { res.statusCode = 409; json(res, { error: 'Synthetic admission rejection', unsavedMessageId: input.message.id }); }); return;
    }
    if (sendMode !== 'unadmitted') admit(input);
    if (sendMode === 'unadmitted' || sendMode === 'queued') { streams.add(res); res.on('close', () => streams.delete(res)); return; }
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
    const id = 'fixture-response-' + requests.length;
    if (sendMode === 'start-only') {
      res.write('data: ' + JSON.stringify({ type: 'start', messageId: id }) + '\n\n');
      streams.add(res); res.on('close', () => streams.delete(res)); return;
    }
    const text = sendMode === 'accept' ? 'Synthetic reply accepted.' : 'Synthetic reply is still running.';
    rows.push(row({ id, role: 'assistant', parts: [{ type: 'text', text }] }, input.message.id));
    for (const part of [{ type: 'start', messageId: id }, { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: text }]) res.write('data: ' + JSON.stringify(part) + '\n\n');
    if (sendMode === 'accept') {
      active = false; res.end('data: ' + JSON.stringify({ type: 'text-end', id: 'text' }) + '\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n');
    } else { streams.add(res); res.on('close', () => streams.delete(res)); }
    return;
  }
  if (url.pathname === '/api/files' && req.method === 'POST') {
    const request = new Request('http://127.0.0.1/api/files', { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
    const data = await request.formData(), file = data.get('file');
    json(res, { id: file.name, filename: file.name, mediaType: file.type, url: '/api/files/' + encodeURIComponent(file.name) }); return;
  }
  if (url.pathname.startsWith('/api/')) {
    json(res, url.pathname.endsWith('/approvals') ? { requests: [] } : url.pathname === '/api/chat/native-search' ? { mode: 'off', reason: 'Synthetic fixture', maxCalls: 2 }
      : url.pathname === '/api/chat/commands' ? { commands: [], skills: [], revision: 0 } : []); return;
  }
  const name = ['/app.js', '/app.css', '/style.css'].includes(url.pathname) ? url.pathname.slice(1) : 'index.html';
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(path.join(out, name)));
}).listen(port, '127.0.0.1', () => console.log('Offline recovery harness http://127.0.0.1:' + port));
