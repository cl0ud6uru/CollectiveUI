import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'starter-attachments-'));
const entry = path.join(dir, 'entry.tsx');
const chat = await readFile(path.join(root, 'src/components/chat/chat.tsx'), 'utf8');
assert.ok(chat.includes('onClick={() => void composerRef.current?.submit(s)}'), 'Starters must use the composer submission path');
await writeFile(entry, `
import React, {useRef} from 'react';
import {createRoot} from '${root}/node_modules/react-dom/client';
import {Composer} from '${root}/src/components/chat/composer';
window.sent=[]; window.accept=true; window.notifications=[];
function Fixture(){const ref=useRef(null);return <><Composer ref={ref} onSend={(text,files)=>{window.sent.push({text,files});return window.accept;}} onStop={()=>{}} busy={false}/><button onClick={()=>void ref.current?.submit('Analyze my Excel workbook and create a summary with a chart.')}>Analyze workbook</button></>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
const stubs = {
 '@/components/bots/bot-avatar': 'export const BotAvatar=()=>null;',
 '@/components/ui/tooltip': 'export const Tip=({children})=>children;',
 './voice-control': 'export const VoiceControl=()=>null;',
 'sonner': 'export const toast={error:t=>window.notifications.push(t),info:t=>window.notifications.push(t)};',
};
const bundle=await build({entryPoints:[entry],outfile:path.join(dir,'bundle.js'),write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src')},plugins:[{name:'fixture',setup(b){b.onResolve({filter:/.*/},a=>stubs[a.path]?{path:a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:stubs[a.path],loader:'tsx',resolveDir:root}));}}]});
const server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);}else{res.setHeader('Content-Type','text/html');res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 let release;let counter=0;
 await page.route('**/api/files',async route=>{const id=String(++counter);await new Promise(r=>{release=r;});await route.fulfill({json:{id,url:'/api/files/'+id,filename:'workbook.xlsx',mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}});});
 const input=page.locator('input[type=file]');
 const file={name:'workbook.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('synthetic workbook')};
 await page.locator('textarea').evaluate(el=>{
   const transfer=new DataTransfer();
   transfer.items.add(new File(['synthetic workbook'],'workbook.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
   el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
 });
 await expect.poll(()=>!!release).toBe(true);
 await page.getByRole('button',{name:'Analyze workbook',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.sent.length),0,'Starter must wait for upload');
 assert.match(await page.evaluate(()=>window.notifications.at(-1)),/finish uploading/);
 release();
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Analyze workbook',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.sent.length)).toBe(1);
 const first=await page.evaluate(()=>window.sent[0]);
 assert.equal(first.text,'Analyze my Excel workbook and create a summary with a chart.');assert.equal(first.files[0].url,'/api/files/1');
 assert.equal(await page.locator('button[aria-label^="Remove"]').count(),0,'Accepted attachment clears');
 await page.getByRole('button',{name:'Analyze workbook',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.sent.length)).toBe(2);
 assert.deepEqual(await page.evaluate(()=>window.sent[1].files),[],'Starter without files still sends');
 release=null;
 await input.setInputFiles(file);await expect.poll(()=>!!release).toBe(true);release();
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
 await page.locator('textarea').fill('Draft to preserve');
 await page.evaluate(()=>window.accept=false);
 await page.getByRole('button',{name:'Analyze workbook',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.sent.length)).toBe(3);
 await expect(page.locator('textarea')).toHaveValue('Draft to preserve');
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
 await page.evaluate(()=>window.accept=true);
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.sent.length)).toBe(4);
 assert.equal(await page.evaluate(()=>window.sent[3].text),'Draft to preserve');
 assert.equal(await page.evaluate(()=>window.sent[3].files[0].url),'/api/files/2');
 await expect(page.locator('textarea')).toHaveValue('');
 assert.deepEqual(errors,[]);
 console.log('Browser passed: starter includes file, blocks incomplete uploads, clears accepted files, sends without files, preserves rejected draft/files, and normal send retains files.');
}finally{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
