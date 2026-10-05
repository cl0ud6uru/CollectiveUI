import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-browser-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client'; import { NativeWorkspace } from '${root}/src/components/hermes/native-workspace'; createRoot(document.getElementById('root')!).render(<NativeWorkspace connectionId="fixture" profiles={[{name:'default'}]} saved={[{id:'session',storedId:'stored',title:'Fixture chat',profile:'default',status:'idle'}]} allowed={true} initialSession="session" initialError=""/>);`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: {'@': path.join(root, 'src')}, plugins: [{name:'fixture-link',setup(build){build.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`,loader:'jsx',resolveDir:root}));}}] });
let allowed = true; let running = false; let prompts = []; let queued = ''; const received = []; let uploadCount = 0;
const server = createServer(async (req,res) => {
 res.setHeader('Content-Type', 'application/json');
 const url = new URL(req.url, 'http://localhost');
 if (url.pathname === '/bundle.js') { res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents); return; }
 if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script src="/bundle.js"></script>');return; }
 if (req.method === 'GET') {
  if (url.searchParams.get('operation') === 'browse') res.end(JSON.stringify({sessions:[{id:'stored',title:'Fixture chat'}],linked:[{id:'session',storedId:'stored',title:'Fixture chat',profile:'default',status:running?'running':'idle'}]}));
  else res.end(JSON.stringify({id:'session',title:'Fixture chat',profile:'default',running,uncertain:false,connection:'connected',messages:[{id:'message',role:'assistant',text:'Recovered native history'}],partial:running?'Live native response':'',tools:[],prompts,model:'Fixture model',provider:'Fixture',usage:{context_used:100,context_max:1000},queued,admissionAllowed:allowed}));
  return;
 }
 const bytes = []; for await (const chunk of req) bytes.push(chunk); const body = Buffer.concat(bytes);
 let input;
 if (req.headers['content-type'].startsWith('multipart/')) {
  const data = await new Response(body,{headers:{'Content-Type':req.headers['content-type']}}).formData(); input = JSON.parse(data.get('request')); uploadCount = data.getAll('files').length;
 } else input = JSON.parse(body.toString());
 received.push(input);
 if (input.operation === 'submit') { running=true;prompts=[{id:'approval',method:'approval',title:'Allow fixture command?',command:'synthetic command',choices:[],questions:[]}]; }
 if (input.operation === 'answer') { if (input.requestId === 'approval') prompts=[{id:'clarify',method:'clarify',title:'clarify',command:'',choices:[],questions:[{id:'q1',question:'Choose a fixture answer',choices:['One','Two']}]}]; else if (input.requestId==='clarify') prompts=[{id:'secret',method:'secret',title:'Fixture protected value',command:'',choices:[],questions:[]}]; else prompts=[]; }
 if (input.operation === 'queue') queued=input.text;
 if (input.operation === 'stop') running=false;
 res.end(JSON.stringify({accepted:true,answered:true}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({headless:true});
try {
 const page = await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/hermes/fixture?session=session`);
 await expect(page.getByText('Recovered native history')).toBeVisible();
 await page.getByRole('textbox',{name:'Message Hermes'}).fill('Analyze fixture attachment');
 await page.getByLabel('Attach files to Hermes').setInputFiles({name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic test content')});
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByRole('button',{name:'Allow once'})).toBeVisible();
 await page.getByRole('button',{name:'Allow once'}).click();
 await page.getByLabel('Choose a fixture answer').fill('One');
 await page.getByRole('button',{name:'Answer Hermes'}).click();
 const secret=page.getByLabel('Protected value for Hermes');await secret.fill('synthetic-secret');await page.getByRole('button',{name:'Answer Hermes'}).click();
 await expect(page.getByText('Fixture protected value')).toHaveCount(0);
 await page.getByRole('textbox',{name:'Message Hermes'}).fill('Correction'); await page.getByRole('button',{name:'Steer current turn'}).click();
 await page.getByRole('textbox',{name:'Message Hermes'}).fill('Next message'); await page.getByRole('button',{name:'Queue next message'}).click();
 await expect(page.getByText('Queued: Next message')).toBeVisible();
 allowed=false; await expect(page.getByRole('textbox',{name:'Message Hermes'})).toBeDisabled();
 await page.getByRole('button',{name:'Stop',exact:true}).click();
 expect(uploadCount).toBe(1);expect(received.map(r=>r.operation)).toEqual(['submit','answer','answer','answer','steer','queue','stop']);
 expect(received.find(r=>r.requestId==='clarify').answer).toEqual({answers:{q1:'One'}});
 expect(await page.locator('body').textContent()).not.toContain('synthetic-secret'); expect(errors).toEqual([]);
 console.log('PASS: history, live response, attachment, approval, clarification, protected prompt, steering, queue, admin disablement, stop; no browser errors.');
} finally { await browser.close();server.close();await rm(dir,{recursive:true,force:true}); }
