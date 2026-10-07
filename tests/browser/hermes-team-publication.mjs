import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Actual chat boundary + sheet over synthetic HTTP matching publication service 6ad0da8.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'); const tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-team-publication-ui-'));
const entry = path.join(dir, 'entry.tsx'); const navigation = path.join(dir, 'navigation.ts');
await writeFile(navigation, 'export const useRouter = () => ({ push: path => {window.fixtureNavigation=path;} });');
await writeFile(entry, `import React from 'react'; import {createRoot} from '${root}/node_modules/react-dom/client'; import {HermesTeamChatControls} from '${root}/src/components/chat/hermes-team-chat-controls'; createRoot(document.getElementById('root')).render(<HermesTeamChatControls botId="fixture-team" conversationId="fixture-admin-chat" started busy={false}/>);`);
const bundle = await build({ entryPoints:[entry],write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src'),'next/navigation':navigation} });
const css = await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const resource = (resourcePath, packageId, content, kind='skill',encoding='utf8') => {
  const bytes = encoding === 'base64' ? Buffer.from(content,'base64') : Buffer.from(content);
  return {path:resourcePath,packageId,content,kind,encoding,sha256:sha(bytes),size:bytes.length};
};
const packageHash = files => sha(JSON.stringify([...files].sort((a,b)=>a.path.localeCompare(b.path)).map(file=>[file.path,file.sha256])));
const change = (packageId,previousResources,capturedResources) => ({packageId,change:!previousResources.length?'added':!capturedResources.length?'removed':'changed',beforeHash:packageHash(previousResources),afterHash:packageHash(capturedResources),previousResources,capturedResources});
let draft = 'Reviewed procedure'; let captureCount=0; let inventoryAvailable=true; let inventoryFailure=false; let unstableNextCapture=false;
let failFirstPublish=true; let staleNextPublish=false; let holdPublish=true; let releasePublish;
const receipts = new Map(); const captures = []; const publications = []; const gets = [];
const view = {enabled:true,mode:'admin',canMaintain:true,state:'connection_needed',installedRevision:null,publishedRevision:2,conflictCount:0};
const inventory = () => ({available:inventoryAvailable,reason:inventoryAvailable?undefined:'Native resource review is not supported by this connection yet.',selection:{skillPackages:['procedure'],includeRole:true,documents:['handbook.txt','unselected.txt']}});
function captureReview(selection) {
  const changes = [
    change('skills/procedure',[resource('skills/procedure/SKILL.md','skills/procedure','Previous procedure')],[resource('skills/procedure/SKILL.md','skills/procedure',draft),resource('skills/procedure/scripts/helper.py','skills/procedure','<script>window.fixtureExecuted=true</script>'),resource('skills/procedure/assets/icon.png','skills/procedure','cG5n','skill','base64')]),
    change('skills/old',[resource('skills/old/SKILL.md','skills/old','Old skill')],[]),
    change('SOUL.md',[resource('SOUL.md','SOUL.md','Previous role','role')],[resource('SOUL.md','SOUL.md','Reviewed role','role')]),
    ...selection.documents.map(document=>change(`documents/${document}`,[],[resource(`documents/${document}`,`documents/${document}`,'Reviewed handbook','document')])),
  ];
  return {snapshotId:`snapshot-${++captureCount}`,expectedRevision:view.publishedRevision,definitionVersion:7,manifestHash:sha(JSON.stringify(changes)),expiresAt:'2099-10-06T00:00:00Z',changes};
}
const server = createServer(async(req,res)=>{
  const url = new URL(req.url,'http://localhost');
  if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);return;}
  if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}
  if(!url.pathname.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');return;}
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET'&&url.pathname.endsWith('/connections')){res.end(JSON.stringify({connections:[]}));return;}
  if(req.method==='GET'){gets.push(url.pathname);if(url.pathname.endsWith('/capture')&&inventoryFailure){res.statusCode=503;res.end(JSON.stringify({error:'Native resource inventory is unavailable on this connection.'}));return;}res.end(JSON.stringify(url.pathname.endsWith('/capture')?inventory():url.pathname.endsWith('/revisions')?{revisions:[]}:url.pathname.endsWith('/publish')?{publishedRevision:view.publishedRevision,nativeUpdatesSupported:false,profileCount:2,states:{connection_needed:2},conflictCount:0,conflictedProfileCount:0,updatesNeeded:2}:view));return;}
  const bytes=[];for await(const chunk of req)bytes.push(chunk);const input=JSON.parse(Buffer.concat(bytes).toString());
  if(url.pathname.endsWith('/capture')){
    captures.push(input);
    if(unstableNextCapture){unstableNextCapture=false;res.statusCode=409;res.end(JSON.stringify({error:'Native resource writes have not settled; capture again when idle'}));return;}
    res.statusCode=201;res.end(JSON.stringify(captureReview(input.selection)));return;
  }
  publications.push(input);
  if(holdPublish)await new Promise(resolve=>{releasePublish=resolve;});
  if(staleNextPublish){staleNextPublish=false;view.publishedRevision++;res.statusCode=409;res.end(JSON.stringify({error:'The Team Bot changed. Capture and review its changes again.'}));return;}
  const result=receipts.get(input.requestId)??{revision:input.expectedRevision+1,manifestHash:'a'.repeat(64),requestId:input.requestId};receipts.set(input.requestId,result);view.publishedRevision=result.revision;
  if(failFirstPublish){failFirstPublish=false;res.statusCode=503;res.end(JSON.stringify({error:'Publication result could not be confirmed. Retry the same request.'}));return;}
  res.end(JSON.stringify(result));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const open=page.getByRole('button',{name:'Publish changes',exact:true});await expect(open).toBeEnabled();await open.click();
  const review=page.getByRole('dialog',{name:'Publish changes'});await expect(review).toBeVisible();
  await expect(review.getByRole('checkbox',{name:'Include document handbook.txt'})).not.toBeChecked();
  await review.getByRole('checkbox',{name:'Include document handbook.txt'}).check();await review.getByRole('button',{name:'Capture changes'}).click();
  await expect(review.getByRole('checkbox',{name:'Publish procedure',exact:true})).toBeVisible();
  expect(captures[0]).toEqual({expectedRevision:2,selection:{skillPackages:['procedure'],includeRole:true,documents:['handbook.txt']}});
  await expect(review.getByRole('checkbox',{name:'Publish unselected.txt'})).toHaveCount(0);
  await review.getByText('skills/procedure/SKILL.md',{exact:false}).click();await expect(review.getByText('Previous procedure',{exact:true})).toBeVisible();await expect(review.getByText('Reviewed procedure',{exact:true})).toBeVisible();
  await review.getByText('skills/procedure/scripts/helper.py',{exact:false}).click();await expect(review.getByText('<script>window.fixtureExecuted=true</script>',{exact:true})).toBeVisible();expect(await page.evaluate(()=>window.fixtureExecuted)).toBeUndefined();
  await review.getByText('skills/procedure/assets/icon.png',{exact:false}).click();await expect(review.getByText('Binary asset included in the complete skill package. Its bytes are preserved in this reviewed snapshot.')).toBeVisible();
  for(const name of ['procedure','old','Role instructions','handbook.txt'])await review.getByRole('checkbox',{name:`Publish ${name}`,exact:true}).check();
  await review.getByLabel('Team release note').fill('Teach the procedure and release selected shared resources.');
  await expect(review.getByLabel('Team release note')).toHaveAttribute('maxlength','500');
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});expect(await review.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  if(process.env.HERMES_TEAM_UI_SCREENSHOT){await page.setViewportSize({width:390,height:844});await review.evaluate(element=>{element.scrollTop=0;});await page.screenshot({path:process.env.HERMES_TEAM_UI_SCREENSHOT,fullPage:true});}
  draft='Later unreviewed learning';await expect(review.getByText(draft,{exact:true})).toHaveCount(0);
  await review.getByRole('button',{name:'Publish 4 items',exact:true}).click();await expect.poll(()=>publications.length).toBe(1);
  await review.getByRole('button',{name:'Publish 4 items',exact:true}).evaluate(button=>{button.click();button.click();});expect(publications).toHaveLength(1);
  await expect(review.getByLabel('Team release note')).toBeDisabled();holdPublish=false;releasePublish();
  await expect(review.getByRole('alert')).toHaveText('Publication result could not be confirmed. Retry the same request.');
  await review.getByRole('button',{name:'Retry publish',exact:true}).click();await expect(review).toHaveCount(0);
  expect(publications).toHaveLength(2);expect(publications[0]).toEqual(publications[1]);
  expect(publications[0]).toEqual({snapshotId:'snapshot-1',expectedRevision:2,selectedKeys:['skills/procedure','SOUL.md','documents/handbook.txt'],removalKeys:['skills/old'],releaseNote:'Teach the procedure and release selected shared resources.',requestId:publications[0].requestId});
  expect(publications[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.getByText('Published team version 3.',{exact:true})).toBeVisible();await expect(page.getByText('Team version 3',{exact:true})).toBeVisible();
  await open.click();await review.getByRole('button',{name:'Capture changes'}).click();
  await review.getByRole('checkbox',{name:'Publish procedure',exact:true}).check();await review.getByLabel('Team release note').fill('Stale review fixture');
  staleNextPublish=true;await review.getByRole('button',{name:'Publish 1 item',exact:true}).click();
  await expect(review.getByRole('alert')).toHaveText('The Team Bot changed. Capture and review its changes again.');await expect(review.getByRole('button',{name:'Retry publish'})).toHaveCount(0);
  await review.getByRole('button',{name:'Review again'}).click();await review.getByRole('button',{name:'Capture changes'}).click();
  await expect(review.getByRole('checkbox',{name:'Publish procedure',exact:true})).not.toBeChecked();await expect(review.getByLabel('Team release note')).toHaveValue('');
  expect(captures.at(-1).expectedRevision).toBe(4);await review.getByRole('button',{name:'Cancel',exact:true}).click();
  inventoryAvailable=false;const beforeUnavailable=captures.length;await open.click();
  await expect(review.getByText('Native resource review is not supported by this connection yet.')).toBeVisible();await expect(review.getByRole('button',{name:'Review again'})).toBeVisible();expect(captures).toHaveLength(beforeUnavailable);
  await review.getByRole('button',{name:'Cancel',exact:true}).click();inventoryFailure=true;await open.click();
  await expect(page.getByRole('alert')).toHaveText('Native resource inventory is unavailable on this connection.');await expect(review).toHaveCount(0);expect(captures).toHaveLength(beforeUnavailable);await expect(open).toBeEnabled();
  inventoryFailure=false;inventoryAvailable=true;unstableNextCapture=true;await open.click();await review.getByRole('button',{name:'Capture changes'}).click();
  await expect(review.getByRole('alert')).toHaveText('Native resource writes have not settled; capture again when idle');
  await review.getByRole('button',{name:'Capture changes'}).click();await expect(review.getByRole('checkbox',{name:'Publish procedure',exact:true})).toBeVisible();
  expect(gets.filter(url=>url.endsWith('/team')).length).toBeGreaterThan(3);expect(errors).toEqual([]);
  console.log('PASS: real publication HTTP boundary; safe document inventory; exact whole-package before/after bytes and metadata; selected vs removal keys; fixed snapshot and stable receipt retry; double-click lock; status refresh; stale fresh review; unavailable/unstable native capture; mobile layouts; no model/runtime calls.');
}finally{if(releasePublish)releasePublish();await browser.close();server.close();await rm(dir,{recursive:true,force:true});}
