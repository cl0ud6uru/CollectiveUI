// Offline component harness: real UI, synthetic members, mocked navigation and server action.
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const root = process.cwd();
const out = process.env.GROUP_LEAD_BUILD ?? '/tmp/collective-group-lead-harness';
await mkdir(out, { recursive: true });
const baseline = await readFile(new URL('./fixtures/group-lead-before.tsx', import.meta.url), 'utf8');
await build({
  stdin: { contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { NewGroupDialog } from '@/components/bots/new-group-dialog';
import { GroupHeader } from '@/components/chat/group-header';
import { SpendingHealth } from '@/components/chat/spending-health';
import { NewGroupDialog as BeforeDialog } from 'before-dialog';
import { GroupHeader as BeforeHeader } from 'before-header';
const names = ['Researcher', 'Writer', 'Planner', 'Analyst', 'Navigator', 'Reviewer', 'Seventh bot with a very long descriptive name'];
const bots = names.map((name,index) => ({kind:'bot',id:'synthetic-'+index,name,icon:['🔎','✍️','🧭','📊','🚀','📝','🧩'][index],description:null,label:'Synthetic preview'}));
const before = new URLSearchParams(location.search).has('before');
const Dialog = before ? BeforeDialog : NewGroupDialog;
const Header = before ? BeforeHeader : GroupHeader;
window.groupTest = { calls:[], pushes:[], created:0 };
createRoot(document.getElementById('root')).render(<main className="mx-auto flex h-full max-w-4xl flex-col">
<header className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-1"><div className="flex min-w-0 max-w-full items-center gap-1"><button className="h-9 w-9 shrink-0 md:hidden" aria-label="Open sidebar">☰</button><Header group={{kind:'group',id:'synthetic-group',name:'Launch planning',icon:null,description:null,members:[bots[1],bots[0],bots[2],bots[3],bots[4],bots[5]]}} /></div><div className="ml-auto flex shrink-0 items-center gap-1"><SpendingHealth /><button className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm" aria-label="Share chat"><span className="h-4 w-4">↗</span><span className="hidden sm:inline">Share</span></button><button className="h-9 w-9 md:hidden" aria-label="New chat">＋</button></div></header>
<div className="flex-1 p-6"><p className="mb-4 text-sm text-muted">Synthetic local preview</p><Dialog bots={bots} trigger={<button className="rounded-full bg-fg px-4 py-2 text-bg">New group chat</button>} onCreated={() => { window.groupTest.created += 1; }} /></div>
<div className="m-4 rounded-2xl border border-border p-4 text-muted">Message the group…</div></main>);
`, resolveDir: root, loader: 'tsx' },
  bundle: true, outfile: path.join(out, 'app.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'offline-group-fixtures', setup(builder) {
    builder.onResolve({ filter: /^(next\/navigation|before-dialog|before-header|@\/app\/\(chat\)\/bots\/actions)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
      if (args.path.startsWith('before-')) return { contents: baseline, loader: 'tsx', resolveDir: root };
      if (args.path === 'next/navigation') return { contents: 'export const useRouter = () => ({ push: value => window.groupTest.pushes.push(value) });', loader: 'js' };
      return { contents: `export function createGroupChat(ids,name) { window.groupTest.calls.push({ids,name}); return new Promise((resolve,reject) => { window.groupTest.complete = () => resolve({id:'synthetic-group'}); window.groupTest.fail = () => reject(new Error('Synthetic failure')); }); }`, loader: 'js' };
    });
  }}],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile('src/app/globals.css', 'utf8'), { from: path.join(root, 'src/app/globals.css') });
await writeFile(path.join(out, 'style.css'), css.css);
await writeFile(path.join(out, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CollectiveUI · synthetic group preview</title><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="height:100%"></div><script src="/app.js"></script></body></html>');
createServer(async (req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname;
  if (file === '/api/admin/spending') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ id:'synthetic-billing', name:'Synthetic account', organization:'demo', enabled:true, showHealthBar:true, snapshot:null, lastError:null }]));
    return;
  }
  const name = file === '/app.js' ? 'app.js' : file === '/style.css' ? 'style.css' : 'index.html';
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(path.join(out, name)));
}).listen(3138, '127.0.0.1', () => console.log('Offline group harness: http://127.0.0.1:3138'));
