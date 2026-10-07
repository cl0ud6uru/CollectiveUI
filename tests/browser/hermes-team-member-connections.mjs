import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(root,'package.json'));
const {build}=require('esbuild'),{chromium,expect}=require('@playwright/test');
const postcss=require('postcss'),tailwind=require('@tailwindcss/postcss');
const dir=await mkdtemp(path.join(tmpdir(),'team-member-connections-'));
const entry=path.join(dir,'entry.tsx');
await writeFile(entry,`
import React,{useState} from 'react';import {createRoot} from '${root}/node_modules/react-dom/client';
import {HermesTeamMemberConnections} from '${root}/src/components/chat/hermes-team-member-connections';
window.connectCalls=[];
function App(){const [context,setContext]=useState('member-chat'),[actions,setActions]=useState([]);window.fixtureContext=setContext;window.fixtureActions=setActions;
return <HermesTeamMemberConnections botId="team" contextKey={context} supportedAuthActions={actions} onConnect={async input=>{window.connectCalls.push(input);}}/>;}
createRoot(document.getElementById('root')).render(<App/>);
`);
const bundle=await build({entryPoints:[entry],write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src')}});
const css=await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
const base={capabilityId:'inbox',name:'Your inbox',status:'connection_needed',revision:0,available:false,reason:'Connecting your own account is awaiting verification.',setup:{kind:'unavailable'}};
let rows=[{...base}],denyList=false,holdList=false,releaseList,holdDelete=false,releaseDelete,deleteFailure=0;
const requests=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}
 if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script></html>');return;}
 res.setHeader('Content-Type','application/json');
 if(req.method==='GET'){
  requests.push({method:'GET',url:req.url});const body=JSON.stringify({connections:rows});
  if(holdList)await new Promise(resolve=>{releaseList=resolve;});
  if(denyList){res.statusCode=403;res.end(JSON.stringify({error:'Your Team access was removed.'}));}else res.end(body);
  return;
 }
 const bytes=[];for await(const chunk of req)bytes.push(chunk);const body=JSON.parse(Buffer.concat(bytes).toString());requests.push({method:req.method,url:req.url,body});
 if(holdDelete)await new Promise(resolve=>{releaseDelete=resolve;});
 if(deleteFailure){res.statusCode=deleteFailure;res.end(JSON.stringify({error:deleteFailure===401?'Unauthorized':'Your connection changed. Refresh before disconnecting.'}));return;}
 rows=rows.map(row=>row.id==='own-account'?{...row,status:'revoked',revision:row.revision+1}:row);
 res.end(JSON.stringify({id:'own-account',status:'revoked',revision:3}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await expect(page.getByText('Connection needed',{exact:true})).toBeVisible();
 expect(requests[0]).toEqual({method:'GET',url:'/api/bots/team/team/connections'});
 await expect(page.getByRole('button',{name:'Connect',exact:true})).toBeDisabled();
 await expect(page.getByText(`${base.reason} Ask your administrator to verify this account connection before setup is available.`,{exact:true})).toBeVisible();
 await expect(page.getByRole('textbox')).toHaveCount(0);await expect(page.getByRole('combobox')).toHaveCount(0);
 expect(requests.some(request=>request.method==='PUT'||request.method==='POST')).toBe(false);

 rows=[{...base,id:'own-account',status:'connected',revision:2,expiresAt:'2026-10-30T12:00:00Z',name:`Inbox ${'long-private-account-name'.repeat(9)}`}];
 await page.getByRole('button',{name:'Refresh connections'}).click();
 await expect(page.getByText('Connection saved',{exact:true})).toBeVisible();
 await expect(page.getByText('Saved access does not confirm that this feature or model access is available.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Reconnect',exact:true})).toBeDisabled();
 for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.getByRole('button',{name:'Disconnect saved access'})).toBeVisible();}
 const beforePoll=requests.filter(request=>request.method==='GET').length;holdList=true;releaseList=undefined;
 await expect.poll(()=>requests.filter(request=>request.method==='GET').length,{timeout:7000}).toBeGreaterThan(beforePoll);
 await expect.poll(()=>typeof releaseList).toBe('function');const staleSavedReply=releaseList;
 holdDelete=true;await page.getByRole('button',{name:'Disconnect saved access'}).click();
 await expect(page.getByRole('button',{name:'Disconnect saved access'})).toBeDisabled();
 await expect.poll(()=>requests.filter(request=>request.method==='DELETE').length).toBe(1);
 expect(requests.find(request=>request.method==='DELETE')).toEqual({method:'DELETE',url:'/api/hermes-team/member-connections/own-account',body:{expectedRevision:2}});
 releaseDelete();holdDelete=false;await expect(page.getByText('Disconnected',{exact:true})).toBeVisible();
 holdList=false;staleSavedReply();await expect(page.getByText('Connection saved',{exact:true})).toHaveCount(0);
 await expect(page.getByText('Saved access disconnected. Your chat history is preserved. This does not revoke access at the outside service.',{exact:true})).toBeVisible();

 rows=[{...base,id:'own-account',status:'expired',revision:2}];await page.getByRole('button',{name:'Refresh connections'}).click();
 await expect(page.getByText('Connection expired',{exact:true})).toBeVisible();deleteFailure=409;
 await page.getByRole('button',{name:'Disconnect saved access'}).click();await expect(page.getByRole('alert')).toHaveText('Your connection changed. Refresh before disconnecting.');
 await expect(page.getByRole('button',{name:'Disconnect saved access'})).toHaveCount(0);
 deleteFailure=0;await page.getByRole('button',{name:'Refresh connections'}).click();await expect(page.getByText('Connection expired',{exact:true})).toBeVisible();
 deleteFailure=401;await page.getByRole('button',{name:'Disconnect saved access'}).click();await expect(page.getByRole('alert')).toHaveText('Unauthorized');
 await expect(page.getByRole('button',{name:'Disconnect saved access'})).toHaveCount(0);
 deleteFailure=0;await page.getByRole('button',{name:'Refresh connections'}).click();await expect(page.getByText('Connection expired',{exact:true})).toBeVisible();

 holdList=true;releaseList=undefined;await page.getByRole('button',{name:'Refresh connections'}).click();await expect.poll(()=>typeof releaseList).toBe('function');const oldRelease=releaseList;
 holdList=false;rows=[{...base,name:'Maintainer inbox'}];await page.evaluate(()=>window.fixtureContext('admin-chat'));
 await expect(page.getByRole('region',{name:'Connection for Maintainer inbox'})).toBeVisible();oldRelease();
 await expect(page.getByText('Connection expired',{exact:true})).toHaveCount(0);
 denyList=true;await page.getByRole('button',{name:'Refresh connections'}).click();await expect(page.getByRole('alert')).toHaveText('Your Team access was removed.');
 await expect(page.getByRole('region',{name:'Connection for Maintainer inbox'})).toHaveCount(0);denyList=false;

 rows=[{...base,available:true,setup:{kind:'verified_action',actionId:'synthetic-only'}}];await page.getByRole('button',{name:'Refresh connections'}).click();
 await expect(page.getByRole('button',{name:'Connect',exact:true})).toBeDisabled();
 await page.evaluate(()=>window.fixtureActions(['synthetic-only']));await page.getByRole('button',{name:'Connect',exact:true}).click();
 expect(await page.evaluate(()=>window.connectCalls)).toEqual([{capabilityId:'inbox',actionId:'synthetic-only'}]);
 rows=[];await page.getByRole('button',{name:'Refresh connections'}).click();await expect(page.getByRole('region',{name:'Your Team Bot connections',exact:true})).toHaveCount(0);
 expect(errors).toEqual([]);
 console.log('PASS required member connections: fixed list, disabled setup/no credential fields, honest saved status, exact owner revision disconnect, stale rejection, separate mode responses, explicit verified-action catalog, 320–1280px actual CSS; synthetic HTTP only');
}finally{if(releaseList)releaseList();if(releaseDelete)releaseDelete();await browser.close();server.close();await rm(dir,{recursive:true,force:true});}
