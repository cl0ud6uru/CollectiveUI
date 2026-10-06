import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Actual chat boundary, synthetic authorized own-member previews and aggregate admin status. No runtime/model calls.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild'); const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'); const tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-team-updates-ui-'));
const entry = path.join(dir, 'entry.tsx'); const navigation = path.join(dir, 'navigation.ts');
await writeFile(navigation, 'export const useRouter = () => ({push:path=>{window.fixtureNavigation=path;}});');
await writeFile(entry, `import React,{useState} from 'react';import{createRoot}from'${root}/node_modules/react-dom/client';import{HermesTeamChatControls}from'${root}/src/components/chat/hermes-team-chat-controls';function App(){const[busy,setBusy]=useState(false);window.fixtureBusy=setBusy;return <HermesTeamChatControls botId="fixture-team" conversationId="fixture-chat" started busy={busy}/>;}createRoot(document.getElementById('root')).render(<App/>);`);
const bundle = await build({entryPoints:[entry],write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src'),'next/navigation':navigation}});
const css = await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
const hash = content => createHash('sha256').update(content).digest('hex');
const resource = (packageId,content) => ({path:`${packageId}/SKILL.md`,packageId,kind:'skill',encoding:'utf8',content,sha256:hash(content),size:Buffer.byteLength(content)});
const conflict = (packageId,member,team) => ({packageId,recorded:true,expectedMemberHash:hash(member??'deleted'),expectedTeamHash:hash(team??'removed'),memberResources:member===null?[]:[resource(packageId,member)],teamResources:team===null?[]:[resource(packageId,team)]});
const gets=[];const requests=[];const receipts=new Map();
const view={enabled:true,mode:'member',canMaintain:false,state:'connection_needed',installedRevision:3,publishedRevision:3,conflictCount:2};
let supported=true;let previewFailure=false;let failResolve=true;let staleResolve=false;let pending=null;let partialCancel=false;
let memberConflicts=[conflict('skills/deleted',null,'Team replacement'),conflict('skills/modified','<script>window.fixtureExecuted=true</script> My private correction',null)];
const updateResult=(input,status='complete')=>({status,installedRevision:input.targetRevision??view.publishedRevision,conflictCount:memberConflicts.length,requestId:input.requestId});
const preview = targetRevision => ({installedRevision:view.installedRevision,targetRevision:targetRevision??view.publishedRevision,publishedRevision:view.publishedRevision,state:view.state,nativeUpdatesSupported:supported,
 ...(pending?{pendingRequestId:pending.input.requestId,pendingRequest:pending}:{}),changes:memberConflicts.map(item=>({packageId:item.packageId,action:'conflict',reason:item.memberResources.length?'member-modified':'member-deleted'})),conflicts:memberConflicts});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}
 if(!url.pathname.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');return;}
 res.setHeader('Content-Type','application/json');
 if(req.method==='GET'){
  gets.push(url.pathname+url.search);
  if(url.pathname.endsWith('/updates')){
   if(view.mode==='admin'){res.statusCode=403;res.end(JSON.stringify({error:'Private member preview must not be requested from Admin mode.'}));return;}
   if(previewFailure){res.statusCode=503;res.end(JSON.stringify({error:'Native member updates are unavailable on this connection.'}));return;}
   res.end(JSON.stringify(preview(url.searchParams.has('targetRevision')?Number(url.searchParams.get('targetRevision')):undefined)));return;
  }
  if(url.pathname.endsWith('/publish')){res.end(JSON.stringify({publishedRevision:view.publishedRevision,nativeUpdatesSupported:false,profileCount:4,states:{ready:2,connection_needed:1,needs_attention:1},conflictCount:3,conflictedProfileCount:1,updatesNeeded:2}));return;}
  if(url.pathname.endsWith('/capture')){res.end(JSON.stringify({available:false,reason:'Native capture is unavailable.',selection:{skillPackages:[],includeRole:true,documents:[]}}));return;}
  res.end(JSON.stringify(view));return;
 }
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());requests.push({path:url.pathname,input});
 if(url.pathname.endsWith('/resolve')){
  if(staleResolve){staleResolve=false;memberConflicts=memberConflicts.map(item=>item.packageId===input.packageId?conflict(item.packageId,'New private correction',item.teamResources[0]?.content??null):item);res.statusCode=409;res.end(JSON.stringify({error:'Your member skill changed. Review its current content.'}));return;}
  const existing=receipts.get(input.requestId);if(existing){res.end(JSON.stringify(existing));return;}
  if(pending && JSON.stringify(pending.input)!==JSON.stringify(input)){res.statusCode=409;res.end(JSON.stringify({error:'Resume the original pending request.'}));return;}
  memberConflicts=memberConflicts.filter(item=>item.packageId!==input.packageId);view.conflictCount=memberConflicts.length;const result=updateResult(input);receipts.set(input.requestId,result);pending=null;view.state='connection_needed';
  if(failResolve){failResolve=false;res.statusCode=503;res.end(JSON.stringify({error:'Resolution result was not confirmed. Retry the same request.'}));return;}
  res.end(JSON.stringify(result));return;
 }
 if(url.pathname.endsWith('/cancel')){
  if(partialCancel){res.statusCode=409;res.end(JSON.stringify({error:'Native recovery is required. Resume the original request.'}));return;}
  pending=null;view.state='connection_needed';res.end(JSON.stringify({...updateResult(input,'cancelled'),installedRevision:view.installedRevision}));return;
 }
 if(url.pathname.endsWith('/updates')||url.pathname.endsWith('/rollback')){
  if(pending && JSON.stringify(pending.input)!==JSON.stringify(input)){res.statusCode=409;res.end(JSON.stringify({error:'Resume the original pending request.'}));return;}
  const result=updateResult(input);view.installedRevision=result.installedRevision;pending=null;view.state='ready';res.end(JSON.stringify(result));return;
 }
 res.statusCode=404;res.end('{}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',error=>errors.push(error.message));const url=`http://127.0.0.1:${server.address().port}`;
 await page.goto(url);await page.getByRole('button',{name:'Review 2 updates'}).click();const sheet=page.getByRole('dialog',{name:'Review team updates'});await expect(sheet).toBeVisible();
 const deleted=sheet.getByRole('region',{name:'Update deleted'});await expect(deleted.getByText('You deleted this item. Keep my version preserves that choice.')).toBeVisible();await deleted.getByRole('button',{name:'Keep my version'}).evaluate(button=>{button.click();button.click();});
 await expect(sheet.getByRole('alert')).toHaveText('Resolution result was not confirmed. Retry the same request.');expect(requests.filter(item=>item.path.endsWith('/resolve'))).toHaveLength(1);await expect(sheet.getByRole('button',{name:'Use team version'}).first()).toBeDisabled();
 await sheet.getByRole('button',{name:'Resume same update'}).click();await expect(deleted).toHaveCount(0);const first=requests.filter(item=>item.path.endsWith('/resolve'));expect(first).toHaveLength(2);expect(first[0]).toEqual(first[1]);expect(first[0].input).toEqual({expectedInstalledRevision:3,targetRevision:3,packageId:'skills/deleted',choice:'keep-member',expectedMemberHash:hash('deleted'),expectedTeamHash:hash('Team replacement'),requestId:first[0].input.requestId});
 const modified=sheet.getByRole('region',{name:'Update modified'});await modified.getByText('Preview your version').click();await modified.getByText('skills/modified/SKILL.md',{exact:true}).click();await expect(modified.getByText('<script>window.fixtureExecuted=true</script> My private correction',{exact:true})).toBeVisible();expect(await page.evaluate(()=>window.fixtureExecuted)).toBeUndefined();
 staleResolve=true;await modified.getByRole('button',{name:'Use team version'}).click();await expect(sheet.getByRole('alert')).toHaveText('Your member skill changed. Review its current content.');await expect(sheet.getByRole('button',{name:'Resume same update'})).toHaveCount(0);await sheet.getByRole('button',{name:'Refresh review'}).click();await modified.getByRole('button',{name:'Use team version'}).click();await expect(modified).toHaveCount(0);const resolves=requests.filter(item=>item.path.endsWith('/resolve'));expect(resolves.at(-1).input.expectedMemberHash).toBe(hash('New private correction'));expect(resolves.at(-1).input.requestId).not.toBe(resolves.at(-2).input.requestId);
 await sheet.getByText('Restore an earlier team version',{exact:true}).click();await sheet.getByLabel('Team version to restore').fill('1');await sheet.getByRole('button',{name:'Preview restore'}).click();await expect(sheet.getByText('Restoring your private bot to team version 1. Review the changes before applying them.')).toBeVisible();expect(gets.at(-1)).toContain('/updates?targetRevision=1');await sheet.getByRole('button',{name:'Restore my team version'}).click();expect(requests.at(-1)).toMatchObject({path:'/api/bots/fixture-team/team/updates/rollback',input:{expectedInstalledRevision:3,targetRevision:1}});await sheet.getByRole('button',{name:'Done'}).click();
 // Reload recovery uses the server's original strict resolve payload rather than a newer private preview.
 view.installedRevision=3;view.conflictCount=1;view.state='needs_attention';memberConflicts=[conflict('skills/pending','Private current','Team current')];pending={kind:'resolve',input:{expectedInstalledRevision:3,targetRevision:3,packageId:'skills/pending',choice:'use-team',expectedMemberHash:hash('Original reviewed private'),expectedTeamHash:hash('Original reviewed team'),requestId:randomUUID()}};partialCancel=true;
 await page.reload();await page.getByRole('button',{name:'Review 1 update'}).click();await sheet.getByRole('button',{name:'Cancel untouched update'}).click();await expect(sheet.getByRole('alert')).toHaveText('Native recovery is required. Resume the original request.');await sheet.getByRole('button',{name:'Refresh review'}).click();const original=structuredClone(pending.input);await sheet.getByRole('button',{name:'Resume same update'}).click();expect(requests.at(-1).input).toEqual(original);await expect(sheet.getByText('Your team resources are current. Your personal learning stays in place.')).toBeVisible();await sheet.getByRole('button',{name:'Done'}).click();
 pending={kind:'update',input:{expectedInstalledRevision:3,targetRevision:3,requestId:randomUUID()}};partialCancel=false;view.state='needs_attention';await page.reload();await page.getByRole('button',{name:'Team updates',exact:true}).click();const cancelId=pending.input.requestId;await sheet.getByRole('button',{name:'Cancel untouched update'}).click();expect(requests.at(-1)).toMatchObject({path:'/api/bots/fixture-team/team/updates/cancel',input:{requestId:cancelId}});await expect(sheet.getByText('The untouched update was cancelled. Your existing content is preserved.')).toBeVisible();await sheet.getByRole('button',{name:'Done'}).click();
 previewFailure=true;await page.getByRole('button',{name:'Team updates',exact:true}).click();await expect(sheet.getByRole('alert')).toHaveText('Native member updates are unavailable on this connection.');await expect(sheet.getByText('Your content is preserved. Ask an admin to check native member update support, then review again.')).toBeVisible();await sheet.getByRole('button',{name:'Done'}).click();previewFailure=false;
 // A capability flag is mandatory: unsupported inventory success does not trigger a native write.
 supported=false;view.installedRevision=2;view.publishedRevision=3;view.state='ready';const writesBefore=requests.length;await page.reload();await expect(page.getByRole('button',{name:'Review team update'})).toBeVisible();await expect.poll(()=>gets.filter(item=>item.endsWith('/updates')).length).toBeGreaterThan(5);expect(requests).toHaveLength(writesBefore);
 supported=true;view.state='connection_needed';view.installedRevision=2;await page.reload();await expect.poll(()=>requests.length).toBe(writesBefore+1);expect(requests.at(-1)).toMatchObject({path:'/api/bots/fixture-team/team/updates',input:{expectedInstalledRevision:2,targetRevision:3}});await expect(page.getByRole('button',{name:'Team updates',exact:true})).toBeVisible();
 view.mode='admin';view.canMaintain=true;view.state='connection_needed';const privateGets=gets.filter(item=>item.includes('/updates')).length;await page.reload();await page.getByRole('button',{name:'Team status',exact:true}).click();const status=page.getByRole('dialog',{name:'Team status'});await expect(status.getByRole('region',{name:'Team rollout status'})).toBeVisible();await expect(status.getByText('Members review their own conflicts. Their skill content stays private.')).toBeVisible();await expect(status.getByText('Member installation is not supported by this connection yet. Published versions remain available for review.')).toBeVisible();expect(gets.filter(item=>item.includes('/updates'))).toHaveLength(privateGets);expect(await status.textContent()).not.toContain('Private current');await status.getByRole('button',{name:'Done'}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();const publish=page.getByRole('dialog',{name:'Publish changes'});await expect(publish.getByRole('region',{name:'Team rollout status'})).toBeVisible();
 for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});expect(await publish.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 expect(errors).toEqual([]);console.log('PASS: real own-member previews; modified/deleted packages; exact hashes/revisions/UUID receipt retries; stale refresh; private restore; pending original resolution and cancellation; idle capability-gated update; unsupported native state; aggregate-only admin rollout; escaped skill text; mobile layout. No model/runtime calls.');
}finally{await browser.close();server.close();await rm(dir,{recursive:true,force:true});}
