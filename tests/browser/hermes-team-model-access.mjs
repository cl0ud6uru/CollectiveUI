import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(root,'package.json'));
const {build}=require('esbuild'),{chromium,expect}=require('@playwright/test'),postcss=require('postcss'),tailwind=require('@tailwindcss/postcss');
const dir=await mkdtemp(path.join(tmpdir(),'team-model-access-')),entry=path.join(dir,'entry.tsx'),navigation=path.join(dir,'navigation.ts');
await writeFile(navigation,`export const useRouter=()=>({push:path=>{window.fixtureNavigation=path;}});`);
await writeFile(entry,`
import React,{useState} from 'react';import {createRoot} from '${root}/node_modules/react-dom/client';import {HermesTeamChatControls} from '${root}/src/components/chat/hermes-team-chat-controls';
function App(){const [context,setContext]=useState({botId:'team',conversationId:'member-one',started:true,busy:false});window.fixtureContext=setContext;return <HermesTeamChatControls {...context}/>;}createRoot(document.getElementById('root')).render(<App/>);
`);
const bundle=await build({entryPoints:[entry],write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src'),'next/navigation':navigation}});
const css=await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
const model=(mode='member',policy='admin_default_personal_allowed')=>({mode,modelChoice:'default',definitionVersion:7,modelPolicyMode:policy,personalAllowed:policy!=='admin_provided',personalRequired:policy==='personal_required',modelAccessAvailable:false,modelAccessReason:'Model access is unavailable until your admin verifies a supported connection.',personalConnection:{state:'unavailable',message:'Personal model connection is unavailable in this build.'},connectAvailable:false,connectReason:'Your admin needs to verify ChatGPT setup before it is available.'});
const models={'member-one':model(),'admin-one':model('admin'),'server-member':model(),'server-admin':model('admin')};
let initial=model(),holdReadId='',releaseRead,holdPut=false,releasePut,holdOpen=false,releaseOpen,putFailure=0,commitFailure=false,readFailure=0,statusFailure=0;
const requests=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}
 if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script></html>');return;}
 res.setHeader('Content-Type','application/json');const url=new URL(req.url,'http://localhost'),match=url.pathname.match(/^\/api\/conversations\/([^/]+)\/team\/model$/);
 if(req.method==='GET'){
  if(url.pathname.endsWith('/connections')){res.end(JSON.stringify({connections:[]}));return;}
  requests.push({method:'GET',path:url.pathname,query:url.search});
  if(match){
   const id=decodeURIComponent(match[1]),{mode,...view}=models[id]??model();void mode;const body=JSON.stringify(view);
   if(holdReadId===id){holdReadId='';await new Promise(resolve=>{releaseRead=resolve;});}
   if(readFailure){res.statusCode=readFailure;res.end(JSON.stringify({error:'This private model context is no longer available.'}));}else res.end(body);return;
  }
  if(statusFailure){res.statusCode=statusFailure;res.end(JSON.stringify({error:'Team status is temporarily unavailable.'}));return;}
  const row=models[url.searchParams.get('conversationId')]??initial;
  res.end(JSON.stringify({enabled:true,mode:row.mode,canMaintain:true,state:'connection_needed',installedRevision:0,publishedRevision:0,conflictCount:0,modelAccessAvailable:false,modelAccessReason:row.modelAccessReason,modelPolicyMode:row.modelPolicyMode,personalAllowed:row.personalAllowed,personalRequired:row.personalRequired}));return;
 }
 const bytes=[];for await(const chunk of req)bytes.push(chunk);const body=JSON.parse(Buffer.concat(bytes).toString());requests.push({method:req.method,path:url.pathname,body});
 if(req.method==='POST'&&url.pathname==='/api/bots/team/team/open'){
  if(holdOpen)await new Promise(resolve=>{releaseOpen=resolve;});
  res.end(JSON.stringify({conversationId:body.mode==='admin'?'server-admin':'server-member',state:'connection_needed'}));return;
 }
 if(req.method==='PUT'&&match){
  if(holdPut)await new Promise(resolve=>{releasePut=resolve;});
  const row=models[decodeURIComponent(match[1])];
  if(!row||body.expectedChoice!==row.modelChoice||body.expectedDefinitionVersion!==row.definitionVersion){res.statusCode=409;res.end(JSON.stringify({error:'The model choice or Team policy changed. Reload before saving.'}));return;}
  if(!putFailure||commitFailure)row.modelChoice=body.modelChoice;
  if(putFailure){res.statusCode=putFailure;res.end(JSON.stringify({error:putFailure===409?'Finish active work before changing the model connection.':'Model choice could not be confirmed. Refresh before trying again.'}));}else res.end(JSON.stringify({modelChoice:row.modelChoice}));return;
 }
 res.statusCode=503;res.end(JSON.stringify({error:'Unsupported synthetic operation.'}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 const panel=page.getByRole('region',{name:'Team Bot model access'}),choice=panel.getByRole('combobox',{name:'Model for this chat'}),save=panel.getByRole('button',{name:'Save model choice'}),refresh=panel.getByRole('button',{name:'Refresh model settings'}),mode=page.getByRole('switch',{name:'Admin mode'});
 const choose=async value=>{await choice.click();await page.getByRole('option',{name:value==='personal'?'My ChatGPT':'Admin-provided model',exact:true}).click();};
 await expect(choice).toContainText('Admin-provided model');await expect(save).toBeDisabled();expect(requests.some(req=>req.path==='/api/conversations/member-one/team/model')).toBe(true);
 await choose('personal');await expect(panel.getByRole('button',{name:'Connect ChatGPT'})).toBeDisabled();await expect(panel.getByText(models['member-one'].connectReason,{exact:true})).toBeVisible();
 for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(save).toBeVisible();}
 holdReadId='member-one';releaseRead=undefined;await expect.poll(()=>typeof releaseRead,{timeout:7000}).toBe('function');const oldRead=releaseRead;
 holdPut=true;await save.click();await expect(mode).toBeDisabled();await expect(save).toHaveCount(0);await expect.poll(()=>requests.filter(req=>req.method==='PUT').length).toBe(1);
 expect(requests.find(req=>req.method==='PUT')).toEqual({method:'PUT',path:'/api/conversations/member-one/team/model',body:{modelChoice:'personal',expectedChoice:'default',expectedDefinitionVersion:7}});
 releasePut();holdPut=false;await expect(choice).toContainText('My ChatGPT');await expect(panel.getByText('Model choice saved for this chat.',{exact:true})).toBeVisible();oldRead();await expect(choice).toContainText('My ChatGPT');await expect(mode).toBeEnabled();
 await expect(panel.getByText('Model access verified.',{exact:true})).toHaveCount(0);

 // Lost response: the committed preference is learned from the next authorized read, never resent automatically.
 await choose('default');putFailure=503;commitFailure=true;await save.click();await expect(panel.getByRole('alert')).toHaveText('Model choice could not be confirmed. Refresh before trying again.');
 await expect(choice).toHaveCount(0);const writes=requests.filter(req=>req.method==='PUT').length;putFailure=0;commitFailure=false;await refresh.click();await expect(choice).toContainText('Admin-provided model');await expect(save).toBeDisabled();expect(requests.filter(req=>req.method==='PUT')).toHaveLength(writes);

 await choose('personal');models['member-one'].definitionVersion=8;await save.click();await expect(panel.getByRole('alert')).toHaveText('The model choice or Team policy changed. Reload before saving.');await expect(choice).toHaveCount(0);
 await refresh.click();await expect(choice).toContainText('Admin-provided model');await choose('personal');putFailure=409;await save.click();await expect(panel.getByRole('alert')).toHaveText('Finish active work before changing the model connection.');await expect(choice).toHaveCount(0);putFailure=0;await refresh.click();await expect(choice).toBeVisible();

 // A parent status outage unmounts model controls. Its busy claim must be released on recovery.
 holdPut=true;releasePut=undefined;await choose('personal');await save.click();await expect.poll(()=>typeof releasePut).toBe('function');const outagePut=releasePut;
 statusFailure=503;await expect(page.getByRole('region',{name:'Hermes Team Bot status'}).getByRole('alert')).toHaveText('Team status is temporarily unavailable.',{timeout:7000});
 const outageResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().endsWith('/member-one/team/model'));outagePut();await (await outageResponse).finished();holdPut=false;
 statusFailure=0;await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(choice).toContainText('My ChatGPT');await expect(mode).toBeEnabled();

 // An older unmounted save finishing after a newer same-context claim cannot release that newer claim.
 holdPut=true;releasePut=undefined;await choose('default');await save.click();await expect.poll(()=>typeof releasePut).toBe('function');const abandonedPut=releasePut;
 statusFailure=503;await expect(page.getByRole('region',{name:'Hermes Team Bot status'}).getByRole('alert')).toHaveText('Team status is temporarily unavailable.',{timeout:7000});
 statusFailure=0;await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(choice).toContainText('My ChatGPT');await expect(mode).toBeEnabled();
 releasePut=undefined;await choose('default');await save.click();await expect.poll(()=>typeof releasePut).toBe('function');const currentPut=releasePut;await expect(mode).toBeDisabled();
 const abandonedResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().endsWith('/member-one/team/model'));abandonedPut();await (await abandonedResponse).finished();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expect(mode).toBeDisabled();await expect(panel.getByRole('button',{name:'Saving model choice…'})).toBeDisabled();
 currentPut();holdPut=false;await expect(panel.getByRole('alert')).toHaveText('The model choice or Team policy changed. Reload before saving.');await expect(mode).toBeEnabled();await refresh.click();await expect(choice).toContainText('Admin-provided model');

 // Even an in-flight write for the old private conversation cannot navigate or change Admin mode.
 holdPut=true;releasePut=undefined;await choose('personal');await save.click();await expect.poll(()=>typeof releasePut).toBe('function');const oldPut=releasePut;
 await page.evaluate(()=>{window.fixtureNavigation=undefined;window.fixtureContext({botId:'team',conversationId:'admin-one',started:true,busy:false});});
 await expect(choice).toContainText('Admin-provided model');oldPut();holdPut=false;await expect(choice).toContainText('Admin-provided model');expect(await page.evaluate(()=>window.fixtureNavigation)).toBeUndefined();expect(models['admin-one'].modelChoice).toBe('default');
 await choose('personal');await save.click();await expect(choice).toContainText('My ChatGPT');expect(requests.filter(req=>req.method==='PUT').at(-1).path).toBe('/api/conversations/admin-one/team/model');expect(models['member-one'].modelChoice).toBe('personal');

 // New member chat: the temporary browser ID is never sent to the model API; open precedes CAS save.
 holdOpen=true;releaseOpen=undefined;await page.evaluate(()=>{window.fixtureNavigation=undefined;window.fixtureContext({botId:'team',conversationId:'temporary-browser-id',started:false,busy:false});});
 await expect(choice).toContainText('Admin-provided model');await choose('personal');const open=panel.getByRole('button',{name:'Open private chat'});await open.click();await expect(mode).toBeDisabled();await expect(panel.getByRole('button',{name:'Saving model choice…'})).toBeDisabled();await expect.poll(()=>typeof releaseOpen).toBe('function');
 releaseOpen();holdOpen=false;await expect.poll(()=>page.evaluate(()=>window.fixtureNavigation)).toBe('/c/server-member');
 const initialWrite=requests.filter(req=>req.method==='PUT').at(-1);expect(initialWrite).toEqual({method:'PUT',path:'/api/conversations/server-member/team/model',body:{modelChoice:'personal',expectedChoice:'default',expectedDefinitionVersion:7}});
 expect(requests.some(req=>req.path.includes('temporary-browser-id'))).toBe(false);

 // Required personal and admin-provided policies show fixed sources, with no alternate fallback selector.
 models['member-one']=model('member','personal_required');await page.evaluate(()=>window.fixtureContext({botId:'team',conversationId:'member-one',started:true,busy:false}));
 await expect(panel.getByText('Your ChatGPT connection is required for this bot’s replies and learning.',{exact:true})).toBeVisible();await expect(choice).toHaveCount(0);await expect(panel.getByRole('button',{name:'Connect ChatGPT'})).toBeDisabled();await expect(panel.getByText(/Current model: Your ChatGPT\./)).toBeVisible();
 models['admin-one']=model('admin','admin_provided');await page.evaluate(()=>window.fixtureContext({botId:'team',conversationId:'admin-one',started:true,busy:false}));
 await expect(panel.getByText('This bot uses the model provided by your admin.',{exact:true})).toBeVisible();await expect(choice).toHaveCount(0);await expect(panel.getByRole('button',{name:'Connect ChatGPT'})).toHaveCount(0);
 models['admin-one'].modelChoice='personal';await refresh.click();await expect(panel.getByRole('button',{name:'Use admin-provided model'})).toBeVisible();await expect(panel.getByRole('button',{name:'Connect ChatGPT'})).toHaveCount(0);
 await panel.getByRole('button',{name:'Use admin-provided model'}).click();await expect(panel.getByRole('button',{name:'Use admin-provided model'})).toHaveCount(0);expect(requests.filter(req=>req.method==='PUT').at(-1).body).toEqual({modelChoice:'default',expectedChoice:'personal',expectedDefinitionVersion:7});

 // Active work disables local preference changes; authorization loss discards the old model controls.
 models['admin-one']=model('admin');await refresh.click();await expect(choice).toBeVisible();await page.evaluate(()=>window.fixtureContext({botId:'team',conversationId:'admin-one',started:true,busy:true}));await expect(choice).toBeDisabled();await expect(save).toBeDisabled();
 await page.evaluate(()=>window.fixtureContext({botId:'team',conversationId:'admin-one',started:true,busy:false}));
 for(const status of [401,403,404]){readFailure=status;await refresh.click();await expect(panel.getByRole('alert')).toHaveText('This private model context is no longer available.');await expect(choice).toHaveCount(0);readFailure=0;await refresh.click();await expect(choice).toBeVisible();}
 await expect(panel.getByRole('textbox')).toHaveCount(0);expect(requests.filter(req=>req.method==='PUT').every(req=>Object.keys(req.body).sort().join(',')==='expectedChoice,expectedDefinitionVersion,modelChoice')).toBe(true);expect(errors).toEqual([]);
 console.log('PASS Team model policy UI: fixed/admin/required policies, optional private CAS choice in both modes, same-profile active guard, uncertain response recovery, stale policy refresh, same-context status outage recovery and exact busy claim release ordering, server-created initial context, no temporary IDs, old mode response/write discard, disabled unverified connect/no credential inputs, 320–1280px actual CSS; synthetic HTTP only');
}finally{if(releaseRead)releaseRead();if(releasePut)releasePut();if(releaseOpen)releaseOpen();await browser.close();server.close();await rm(dir,{recursive:true,force:true});}
