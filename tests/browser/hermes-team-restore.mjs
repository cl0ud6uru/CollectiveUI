import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Actual Admin sheet restores only immutable shared release resources, with no native capture or member API.
const root=fileURLToPath(new URL('../../',import.meta.url));const require=createRequire(path.join(root,'package.json'));
const {build}=require('esbuild');const {chromium,expect}=require('@playwright/test');const postcss=require('postcss');const tailwind=require('@tailwindcss/postcss');
const dir=await mkdtemp(path.join(tmpdir(),'hermes-team-restore-ui-'));const entry=path.join(dir,'entry.tsx');const navigation=path.join(dir,'navigation.ts');
await writeFile(navigation,'export const useRouter=()=>({push:path=>{window.fixtureNavigation=path;}});');
await writeFile(entry,`import React from'react';import{createRoot}from'${root}/node_modules/react-dom/client';import{HermesTeamChatControls}from'${root}/src/components/chat/hermes-team-chat-controls';createRoot(document.getElementById('root')).render(<HermesTeamChatControls botId="fixture-team" conversationId="fixture-admin" started busy={false}/>);`);
const bundle=await build({entryPoints:[entry],write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src'),'next/navigation':navigation}});
const css=await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
const sha=content=>createHash('sha256').update(content).digest('hex');
const resource=(packageId,path,content,kind='skill')=>({path,packageId,content,kind,encoding:'utf8',sha256:sha(content),size:Buffer.byteLength(content)});
const change=(packageId,before,after)=>({packageId,change:before.length&&!after.length?'removed':before.length?'changed':'added',beforeHash:sha(JSON.stringify(before)),afterHash:sha(JSON.stringify(after)),previousResources:before,capturedResources:after});
const view={enabled:true,mode:'admin',canMaintain:true,state:'connection_needed',installedRevision:null,publishedRevision:4,conflictCount:0};
const gets=[];const captures=[];const publishes=[];const receipts=new Map();let sequence=0;let failPublish=true;let stalePublish=false;let holdStatus=false;const heldStatuses=[];
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}
 if(!url.pathname.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');return;}
 res.setHeader('Content-Type','application/json');
 if(req.method==='GET'&&url.pathname.endsWith('/connections')){res.end(JSON.stringify({connections:[]}));return;}
 if(req.method==='GET'){
  gets.push(url.pathname);
  if(url.pathname.endsWith('/revisions')){res.end(JSON.stringify({revisions:[{revision:view.publishedRevision,releaseNote:'Latest shared procedure',publishedAt:'2026-10-06T20:00:00Z',manifestHash:sha('latest')},{revision:1,releaseNote:'Original shared procedure',publishedAt:'2026-10-06T19:00:00Z',manifestHash:sha('original')}]}));return;}
  if(url.pathname.endsWith('/publish')){res.end(JSON.stringify({publishedRevision:view.publishedRevision,nativeUpdatesSupported:false,profileCount:2,states:{connection_needed:2},conflictCount:1,conflictedProfileCount:1,updatesNeeded:2}));return;}
  if(url.pathname.endsWith('/capture')){res.statusCode=503;res.end(JSON.stringify({error:'Native capture is unavailable. Shared published versions can still be reviewed.'}));return;}
  if(holdStatus)await new Promise(resolve=>heldStatuses.push(resolve));
  res.end(JSON.stringify(view));return;
 }
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
 if(url.pathname.endsWith('/rollback/capture')){
  captures.push(input);res.statusCode=201;res.end(JSON.stringify({snapshotId:`restore-${++sequence}`,expectedRevision:input.expectedRevision,definitionVersion:8,manifestHash:sha('restore'),expiresAt:'2099-10-06T00:00:00Z',changes:[
   change('skills/procedure',[resource('skills/procedure','skills/procedure/SKILL.md','Latest shared procedure')],[resource('skills/procedure','skills/procedure/SKILL.md','Original shared procedure'),resource('skills/procedure','skills/procedure/scripts/helper.py','print("restored shared helper")')]),
   change('skills/later',[resource('skills/later','skills/later/SKILL.md','Shared skill added after version 1')],[]),
   change('SOUL.md',[resource('SOUL.md','SOUL.md','Latest shared role','role')],[resource('SOUL.md','SOUL.md','Original shared role','role')])
  ]}));return;
 }
 if(url.pathname.endsWith('/publish')){
  publishes.push(input);
  if(stalePublish){stalePublish=false;view.publishedRevision++;res.statusCode=409;res.end(JSON.stringify({error:'The Team Bot changed. Capture and review its changes again.'}));return;}
  const result=receipts.get(input.requestId)??{revision:input.expectedRevision+1,requestId:input.requestId};receipts.set(input.requestId,result);view.publishedRevision=result.revision;
  if(failPublish){failPublish=false;res.statusCode=503;res.end(JSON.stringify({error:'Restore publication was not confirmed. Retry the same request.'}));return;}
  res.end(JSON.stringify(result));return;
 }
 res.statusCode=404;res.end(JSON.stringify({error:'Unexpected route'}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Publish changes',exact:true}).click();const sheet=page.getByRole('dialog',{name:'Publish changes'});await expect(sheet).toBeVisible();await expect(sheet.getByText('Native capture is unavailable. Shared published versions can still be reviewed.')).toBeVisible();await sheet.getByText('Restore a published team version',{exact:true}).click();const version=sheet.getByLabel('Published team version to restore');await version.selectOption('1');await expect(version.getByRole('option')).toHaveCount(2);await expect(version.getByRole('option',{name:'Version 0'})).toHaveCount(0);await sheet.getByRole('button',{name:'Review selected version'}).click();await expect.poll(()=>captures[0]).toEqual({targetRevision:1,expectedRevision:4});await expect(sheet.getByText('Reviewing shared resources from team version 1. Publish only the changes you select as a new team version.')).toBeVisible();await sheet.getByText('skills/procedure/SKILL.md',{exact:false}).click();await expect(sheet.getByText('Latest shared procedure',{exact:true})).toBeVisible();await expect(sheet.getByText('Original shared procedure',{exact:true})).toBeVisible();await sheet.getByText('skills/procedure/scripts/helper.py',{exact:false}).click();await expect(sheet.getByText('print("restored shared helper")',{exact:true})).toBeVisible();
 for(const name of ['procedure','later'])await sheet.getByRole('checkbox',{name:`Publish ${name}`,exact:true}).check();await sheet.getByLabel('Team release note').fill('Restore the selected original shared procedure.');
 for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});expect(await sheet.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await sheet.getByRole('button',{name:'Publish 2 items',exact:true}).click();await expect(sheet.getByRole('alert')).toHaveText('Restore publication was not confirmed. Retry the same request.');await expect(sheet.getByLabel('Team release note')).toBeDisabled();await sheet.getByRole('button',{name:'Retry publish'}).click();await expect(sheet).toHaveCount(0);expect(publishes[0]).toEqual(publishes[1]);expect(publishes[0]).toEqual({snapshotId:'restore-1',expectedRevision:4,selectedKeys:['skills/procedure'],removalKeys:['skills/later'],releaseNote:'Restore the selected original shared procedure.',requestId:publishes[0].requestId});await expect(page.getByText('Published team version 5.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Publish changes',exact:true}).click();
 await sheet.getByText('Restore a published team version',{exact:true}).click();
 await version.selectOption('1');await sheet.getByRole('button',{name:'Review selected version'}).click();
 await sheet.getByRole('checkbox',{name:'Publish procedure',exact:true}).check();
 await sheet.getByLabel('Team release note').fill('Stale shared restore fixture');
 stalePublish=true;await sheet.getByRole('button',{name:'Publish 1 item',exact:true}).click();
 await expect(sheet.getByRole('alert')).toHaveText('The Team Bot changed. Capture and review its changes again.');
 // Hold the fresh status response: a browser click does not wait for the recapture's HTTP round trips.
 holdStatus=true;const capturesBeforeRecapture=captures.length;
 await sheet.getByRole('button',{name:'Review again'}).click();
 await expect.poll(()=>heldStatuses.length).toBeGreaterThan(0);
 expect(captures).toHaveLength(capturesBeforeRecapture);
 await expect(sheet.getByRole('button',{name:'Review again'})).toBeDisabled();
 holdStatus=false;for(const release of heldStatuses.splice(0))release();
 await expect.poll(()=>captures.at(-1)).toEqual({targetRevision:1,expectedRevision:6});
 await expect(sheet.getByRole('checkbox',{name:'Publish procedure',exact:true})).not.toBeChecked();
 await expect(sheet.getByLabel('Team release note')).toHaveValue('');
 expect(gets.some(route=>route.includes('/updates'))).toBe(false);expect(captures).toHaveLength(3);expect(errors).toEqual([]);
 console.log('PASS: shared immutable revision inventory; native capture unavailable with restore still accessible; exact historical before/after package review; selected/removal keys; new monotonic version publication; stable receipt retry; stale restore recapture waits for a fresh server version; no private member preview or native/model calls; mobile layouts.');
}finally{holdStatus=false;for(const release of heldStatuses.splice(0))release();await browser.close();server.close();await rm(dir,{recursive:true,force:true});}
