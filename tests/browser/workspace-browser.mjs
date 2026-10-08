import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild'), { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'workspace-browser-'));
const shots = path.join(root, 'docs/screenshots/workspace-browser');
await mkdir(shots, { recursive: true });
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `
import React,{useState} from 'react'; import {createRoot} from '${root}/node_modules/react-dom/client';
import {WorkspaceBrowser} from '${root}/src/components/chat/workspace-browser';
import {FolderOpen,MessageSquare,PanelRightOpen} from 'lucide-react';
function App(){const [open,setOpen]=useState(true),[draft,setDraft]=useState('Analyze this report:');return <div style={{display:'flex',height:'100dvh',overflow:'hidden'}}>
<nav className="fixture-sidebar" style={{width:250,flexShrink:0,padding:24,background:'var(--sidebar)',borderRight:'1px solid var(--border)'}}><strong>LloydGPT</strong><p style={{marginTop:30,fontSize:12,color:'var(--muted)'}}>YOUR BOTS</p>{['LloydGPT','Action1 Ops Agent','Gemma 4','IT Ticket Bot'].map((name,i)=><div key={name} style={{display:'flex',alignItems:'center',gap:10,padding:'15px 0',fontSize:13,color:i===1?'var(--fg)':'var(--muted)'}}><MessageSquare size={15}/>{name}</div>)}</nav>
<main className="fixture-chat" style={{flex:1,minWidth:0,display:'flex',flexDirection:'column'}}><header style={{height:56,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px',borderBottom:'1px solid var(--border)'}}><strong style={{fontSize:14}}>Action1 Ops Agent</strong><button aria-label="Open workspace" onClick={()=>setOpen(true)}><PanelRightOpen size={18}/></button></header><div style={{flex:1,padding:'55px 32px',fontSize:14,lineHeight:1.9}}><p style={{color:'var(--muted)',fontSize:12}}>WORKSPACE INTEGRATION</p><p style={{marginTop:25}}>Your inventory report is ready.</p><p style={{marginTop:12,color:'var(--muted)'}}>I compared the endpoint inventory and summarized the patch status. Open the workspace to review the CSV and deployment notes.</p><div style={{display:'flex',alignItems:'center',gap:10,marginTop:28,padding:15,border:'1px solid var(--border)',borderRadius:10}}><FolderOpen size={17}/><span>reports / inventory.csv</span></div></div><div style={{margin:24,padding:14,border:'1px solid var(--border)',borderRadius:16,background:'var(--surface)'}}><textarea aria-label="Message draft" value={draft} onChange={e=>setDraft(e.target.value)} style={{width:'100%',resize:'none',outline:'none',fontSize:13}}/><span style={{fontSize:10,color:'var(--subtle)'}}>Message Action1 Ops Agent</span></div></main>
<WorkspaceBrowser open={open} onClose={()=>setOpen(false)} onInsertPath={p=>setDraft(d=>d+' '+p)} history={[{id:'fixture-bot',command:'python3 summarize_inventory.py',output:'Processed 48 endpoints\\nSaved reports/inventory.csv\\n',running:false}]}/></div>};
createRoot(document.getElementById('root')).render(<App/>);
`);
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, outdir: dir, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') } });
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });
const files = { 'README.md': '# Your workspace\n\nFiles stay here across bot chats.\n', 'reports/inventory.csv': 'hostname,os,patch_status\nDEVLINUX,Ubuntu 24.04,up to date\nLMC-WKS-104,Windows 11,reboot pending\nLMC-WKS-218,Windows 11,up to date\n', 'reports/summary.md': '# Patch review\n\n48 endpoints reviewed.\n2 endpoints need a reboot.\n', 'reports/active.html': '<script>window.previewExecuted=true</script>', 'reports/manual.pdf': null };
const requests = [], errors = [];
let browser, streamStopped = false;
const server = createServer(async (req, res) => {
 const url = new URL(req.url, 'http://localhost');
 if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles.find(f=>f.path.endsWith('.js')).contents); return; }
 if (url.pathname === '/style.css') { res.setHeader('Content-Type','text/css'); res.end(css.css + bundle.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n') + '@media(max-width:1099px){.fixture-sidebar{display:none}}'); return; }
 if (url.pathname.startsWith('/api/')) {
  requests.push(url.pathname + url.search); res.setHeader('Content-Type','application/json');
  if (url.pathname === '/api/workspace/browser') {
   const operation=url.searchParams.get('operation'), p=url.searchParams.get('path') || '.';
   if(operation==='status')res.end(JSON.stringify({allowed:true,configured:true,state:'running',runtime:'runsc'}));
   else if(operation==='list')res.end(JSON.stringify({entries:p==='.'?[{path:'reports',type:'dir',size:0},{path:'README.md',type:'file',size:64}]:p==='reports'?Object.entries(files).filter(([p])=>p.startsWith('reports/')).map(([path,text])=>({path,type:'file',size:text?.length || 4096})):[],truncated:false}));
   else if(operation==='preview') { if(!(p in files)){res.statusCode=404;res.end(JSON.stringify({error:'Workspace file not found'}));}else res.end(JSON.stringify({path:p,text:files[p],size:files[p]?.length || 4096,binary:files[p]===null,truncated:false})); }
   return;
  }
  if(url.pathname==='/api/workspace/terminal') {
   let body='';for await(const chunk of req)body+=chunk; const command=JSON.parse(body).command;
   res.setHeader('Content-Type','application/x-ndjson');res.write(JSON.stringify({type:'start'})+'\n');
   if(command==='sleep 30'){const timer=setInterval(()=>res.write(JSON.stringify({type:'heartbeat'})+'\n'),50);res.on('close',()=>{streamStopped=true;clearInterval(timer)});return;}
   if(command==='large output') {
    res.write(JSON.stringify({type:'output',text:'HEAD-'+ 'x'.repeat(300000)})+'\n');
    res.end(JSON.stringify({type:'exit',code:0,reason:'exited',truncated:false,dropped:{out:0,err:0},limited:{out:0,err:0}})+'\n');return;
   }
   if(command==='gapped output') {
    res.write(JSON.stringify({type:'output',text:'before-gap'})+'\n');
    res.write(JSON.stringify({type:'gap',stream:'out',bytes:100000,source:'daemon'})+'\n');
    res.write(JSON.stringify({type:'output',text:'after-gap'})+'\n');
    res.end(JSON.stringify({type:'exit',code:0,reason:'exited',truncated:true,dropped:{out:100000,err:0},limited:{out:0,err:0}})+'\n');return;
   }
   res.write(JSON.stringify({type:'output',text:'workspace ready\n'})+'\n');res.end(JSON.stringify({type:'exit',code:0,reason:'exit'})+'\n');return;
  }
  if(url.pathname==='/api/workspace/upload'){for await(const chunk of req){}files['uploads/fixture/inventory.csv']='uploaded';res.end(JSON.stringify({path:'uploads/fixture/inventory.csv',bytes:8}));return;}
  if(url.pathname==='/api/workspace/files'){res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${path.basename(url.searchParams.get('path'))}"`);res.end(files[url.searchParams.get('path')] || 'binary fixture');return;}
 }
 res.setHeader('Content-Type','text/html');res.end('<html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(process.argv.includes('--serve')?4197:0,'0.0.0.0',resolve));
const address=`http://127.0.0.1:${server.address().port}`;
try {
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(address);await expect(page.getByRole('heading',{name:'Your files, beside your chat'})).toBeVisible();
 await page.screenshot({path:path.join(shots,'desktop-empty.png')});
 await page.setViewportSize({width:2558,height:1410});await page.screenshot({path:path.join(shots,'reference-viewport-empty.png')});await page.setViewportSize({width:1600,height:1000});
 await page.getByRole('button',{name:'reports',exact:true}).click();await page.getByRole('button',{name:'inventory.csv',exact:true}).click();
 await expect(page.getByLabel('inventory.csv file content')).toContainText('DEVLINUX');
 await page.screenshot({path:path.join(shots,'desktop-files.png')});
 await page.locator('html').evaluate(el=>el.classList.remove('dark'));await page.screenshot({path:path.join(shots,'desktop-light.png')});await page.locator('html').evaluate(el=>el.classList.add('dark'));
 await page.getByRole('tab',{name:'Files',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'Terminal',exact:true})).toHaveAttribute('aria-selected','true');await page.keyboard.press('ArrowLeft');
 for(const width of [1100,1366]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.getByRole('button',{name:'Use in chat'})).toBeInViewport();}await page.setViewportSize({width:1600,height:1000});
 await page.getByRole('button',{name:'summary.md',exact:true}).click();await expect(page.getByRole('tab',{name:'inventory.csv',exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'inventory.csv',exact:true}).click();await expect(page.getByLabel('inventory.csv file content')).toContainText('DEVLINUX');
 await page.getByRole('button',{name:'Use in chat'}).click();await expect(page.getByLabel('Message draft')).toHaveValue('Analyze this report: reports/inventory.csv');
 const download=page.waitForEvent('download');await page.getByRole('link',{name:'Download inventory.csv',exact:true}).click();expect((await download).suggestedFilename()).toBe('inventory.csv');
 await page.getByLabel('Filter workspace files').fill('nothing');await expect(page.getByText('No loaded files match.',{exact:false})).toBeVisible();await page.getByRole('button',{name:'Clear file filter'}).click();
 await page.getByRole('button',{name:'active.html',exact:true}).click();await expect(page.getByLabel('active.html file content')).toContainText('<script>');expect(await page.evaluate(()=>window.previewExecuted)).toBeUndefined();
 await page.getByRole('button',{name:'manual.pdf',exact:true}).click();await expect(page.getByRole('heading',{name:'Download to open this file'})).toBeVisible();
 await page.getByRole('tab',{name:'Terminal',exact:true}).click();await expect(page.getByLabel('Terminal output')).toContainText('Processed 48 endpoints');
 await page.getByLabel('Run your own command').fill("printf 'workspace ready\\n'");await page.getByRole('button',{name:'Run',exact:true}).click();await expect(page.getByLabel('Terminal output')).toContainText('workspace ready');await expect(page.getByText('Exit 0',{exact:true})).toBeVisible();
 await page.screenshot({path:path.join(shots,'desktop-terminal.png')});
 await page.getByLabel('Run your own command').fill('large output');await page.getByRole('button',{name:'Run',exact:true}).click();
 await expect(page.getByText('Showing the most recent 262,144 characters; 37,861 earlier characters removed from this display.',{exact:true})).toBeVisible();
 const largeOutput=page.getByLabel('Terminal output').locator('article').last().locator('pre');
 expect((await largeOutput.textContent()).length).toBe(262144);expect(await largeOutput.textContent()).not.toContain('HEAD-');
 await page.getByLabel('Run your own command').fill('gapped output');await page.getByRole('button',{name:'Run',exact:true}).click();
 await expect(page.getByText('100,000 bytes omitted by the workspace service (stdout: 100000, stderr: 0).',{exact:true})).toBeVisible();
 const gapOutput=await page.getByLabel('Terminal output').locator('article').last().locator('pre').textContent();
 expect(gapOutput.indexOf('before-gap')).toBeLessThan(gapOutput.indexOf('[100000 bytes of stdout omitted'));
 expect(gapOutput.indexOf('[100000 bytes of stdout omitted')).toBeLessThan(gapOutput.indexOf('after-gap'));
 await page.getByLabel('Run your own command').fill('sleep 30');await page.getByRole('button',{name:'Run',exact:true}).click();await page.getByRole('button',{name:'Stop',exact:true}).click();await expect(page.getByText('Stop requested. The workspace is cancelling this command.',{exact:true})).toBeVisible();await expect.poll(()=>streamStopped).toBe(true);
 const separator=page.getByRole('separator',{name:'Resize workspace panel'});await separator.focus();await page.keyboard.press('ArrowLeft');await expect(separator).toHaveAttribute('aria-valuenow','624');
 await page.getByRole('button',{name:'Close workspace',exact:true}).click();await expect(page.getByRole('complementary',{name:'Your workspace'})).toBeHidden();await page.getByRole('button',{name:'Open workspace'}).click();
 await page.getByRole('tab',{name:'Files',exact:true}).click();await page.getByLabel('Choose workspace upload').setInputFiles({name:'inventory.csv',mimeType:'text/csv',buffer:Buffer.from('fixture')});await expect(page.getByText('inventory.csv uploaded. Use its path in your chat.')).toBeVisible();
 for(const width of [390,320]) {
  await page.setViewportSize({width,height:844});await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Refresh workspace'}).click();await page.getByRole('button',{name:'reports',exact:true}).click();await page.getByRole('button',{name:'inventory.csv',exact:true}).click();await expect(page.getByLabel('inventory.csv file content')).toContainText('DEVLINUX');
  await expect(page.getByRole('button',{name:'Use in chat'})).toBeInViewport();await page.screenshot({path:path.join(shots,`mobile-${width}.png`)});
  await page.getByRole('tab',{name:'Terminal',exact:true}).click();await expect(page.getByLabel('Run your own command')).toBeInViewport();await page.getByRole('button',{name:'Close workspace',exact:true}).click();await expect(page.getByRole('dialog')).toBeHidden();await page.getByRole('button',{name:'Open workspace'}).click();await page.getByRole('tab',{name:'Files',exact:true}).click();
 }
 expect(errors).toEqual([]);console.log('PASS: file trees, tabs, inert previews, downloads, uploads, draft preservation, terminal streaming/stop/daemon gaps/client clipping, resizing, 320/390px mobile; no browser errors.');
} finally {
 await browser?.close();
 if(process.argv.includes('--serve')) console.log(`Preview running at ${address} (synthetic data; real components).`);
 else {await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
}
