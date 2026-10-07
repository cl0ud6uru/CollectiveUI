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
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'team-candidate-approvals-'));
const entry = path.join(dir, 'entry.tsx');
// Both identifiers fit the server's 200-character limit. Review must remain readable on phones.
const resourceId = `document-${'x'.repeat(150)}`;
const action = `update-${'y'.repeat(150)}`;
await writeFile(entry, `
import React, {useState} from 'react';
import {createRoot} from '${root}/node_modules/react-dom/client';
import {HermesTeamCandidateApprovals} from '${root}/src/components/chat/hermes-team-candidate-approvals';
window.calls=[];window.rows=[{id:'admin-write',action:${JSON.stringify(action)},resourceIds:[${JSON.stringify(resourceId)}],input:{text:'Reviewed private input'},expiresAt:'2099-01-01'}];
window.fetch=async(url,options={})=>{
 window.calls.push({url,method:options.method??'GET',body:options.body});
 if(options.method==='PUT')return Response.json(window.fail?{error:'Access removed'}:{id:'admin-write'},{status:window.fail?403:200});
 if(window.hold)return new Promise(resolve=>{window.release=()=>resolve(Response.json({approvals:window.rows}));});
 return Response.json({approvals:window.rows});
};
function App(){const [active,setActive]=useState(false);const [conversation,setConversation]=useState('admin-chat');window.activate=setActive;window.switchConversation=setConversation;
 return <HermesTeamCandidateApprovals active={active} conversationId={conversation}/>;}
createRoot(document.getElementById('root')).render(<App/>);
`);
const bundle=await build({entryPoints:[entry],write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src')}});
const css=await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
const server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}
 res.setHeader('Content-Type','text/html');res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script></html>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);expect(await page.evaluate(()=>window.calls)).toEqual([]);
 await page.evaluate(()=>window.activate(true));await expect(page.getByText('Reviewed private input',{exact:false})).toBeVisible();
 await expect(page.getByText(`Allow ${action}?`,{exact:true})).toBeVisible();
 await expect(page.getByText(`Resources: ${resourceId}`,{exact:true})).toBeVisible();
 await expect(page.getByText('Approve this action once. Unanswered requests expire. Approval does not confirm completion.',{exact:true})).toBeVisible();
 await expect(page.getByText('Allow once resumes this exact action.',{exact:false})).toHaveCount(0);
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await expect(page.getByRole('button',{name:'Allow once',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Deny',exact:true})).toBeVisible();
 }
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Allow once',exact:true}).click();expect(await page.evaluate(()=>JSON.parse(window.calls.find(c=>c.method==='PUT').body))).toEqual({decision:'approved'});
 await page.evaluate(()=>{window.activate(false);window.hold=true;});await expect(page.getByRole('button',{name:'Allow once',exact:true})).toHaveCount(0);
 await page.evaluate(()=>window.activate(true));await expect(page.getByRole('button',{name:'Allow once',exact:true})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>typeof window.release)).toBe('function');
 await page.evaluate(()=>{window.oldRelease=window.release;window.rows=[];window.hold=false;window.switchConversation('member-chat');});
 await expect.poll(()=>page.evaluate(()=>window.calls.some(c=>c.url.includes('member-chat')))).toBe(true);
 await page.evaluate(()=>{window.rows=[{id:'stale-admin',action:'Old admin action',resourceIds:['secret-doc'],input:{text:'old admin input'}}];window.oldRelease();});
 await expect(page.getByText('old admin input',{exact:false})).toHaveCount(0);
 await page.evaluate(()=>{window.activate(false);window.rows=[{id:'member-write',action:'update document',resourceIds:['document-a'],input:{text:'Current member input'}}];});
 await page.evaluate(()=>{window.fail=true;window.activate(true);});await expect(page.getByRole('button',{name:'Deny',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Deny',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('Access removed');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors).toEqual([]);
 console.log('PASS candidate approval cards: disabled gate, private review, exact answer, late mode switch, stale activation, revocation, actual CSS and long accepted action/resource identifiers at 320–1280px');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
