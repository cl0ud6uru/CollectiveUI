import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(root,'package.json'));
const {build}=require('esbuild'),{chromium,expect}=require('@playwright/test');
const postcss=require('postcss'),tailwind=require('@tailwindcss/postcss');
const dir=await mkdtemp(path.join(tmpdir(),'team-saved-connections-')),entry=path.join(dir,'entry.tsx'),stubs=path.join(dir,'stubs.tsx');
const id=index=>`10000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
let rows=Array.from({length:101},(_,index)=>({id:id(index),name:index===0?`Removed bot account ${'long-private-friendly-name'.repeat(8)}`:`Saved account ${index+1}`,status:index===0?'connected':index===1?'expired':'revoked',revision:2,expiresAt:'2026-10-30T12:00:00Z'}));
const initial={connections:rows.slice(0,100),nextCursor:id(99)};
await writeFile(stubs,`
import React from 'react';export const useRouter=()=>({refresh:()=>{}});export const useSearchParams=()=>new URLSearchParams(location.search);export const useTheme=()=>({theme:'system',setTheme:()=>{}});
const Empty=()=>null;export {Empty as WorkspacePanel,Empty as ChatGPTConnection,Empty as StartTargetSelect};
export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>;}
export const archiveConversation=async()=>{},clearMemories=async()=>{},deleteAllConversations=async()=>{},deleteMemory=async()=>{},revokeToolGrant=async()=>{},saveMemory=async()=>{},setMemoryPinned=async()=>{},updatePrefs=async()=>{};
`);
await writeFile(entry,`
import React,{useState} from 'react';import {createRoot} from '${root}/node_modules/react-dom/client';import {SettingsView} from '${root}/src/components/settings-view';import {HermesTeamSavedConnections} from '${root}/src/components/settings/hermes-team-connections';
function App(){const [show,setShow]=useState(true);window.fixtureShowAccounts=setShow;return <SettingsView prefs={{}} apps={[]} bots={[]} memories={[]} archived={[]} grants={[]} user={{name:'Synthetic owner',upn:'owner@example.test',authSource:'local'}} chatgpt={null} workspace={null} security={null} hermes={null} teamConnections={show?<HermesTeamSavedConnections initial={${JSON.stringify(initial)}}/>:null}/>;}
createRoot(document.getElementById('root')).render(<App/>);
`);
const aliases=Object.fromEntries(['next/navigation','next-themes','next/link','@/app/(chat)/actions','@/components/settings/chatgpt-connection','@/components/settings/workspace-panel','@/components/start-target-select'].map(source=>[source,stubs]));
const bundle=await build({entryPoints:[entry],write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src'),...aliases}});
const css=await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
let holdRead=false,releaseRead,holdDelete=false,releaseDelete,deleteFailure=0,denyList=0;const requests=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}
 if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script></html>');return;}
 res.setHeader('Content-Type','application/json');
 if(req.method==='GET'){
  requests.push({method:'GET',url:req.url});const after=new URL(req.url,'http://localhost').searchParams.get('cursor');const available=after?rows.filter(row=>row.id>after):rows;
  const body=JSON.stringify({connections:available.slice(0,100),nextCursor:available.length>100?available[99].id:null});
  if(holdRead)await new Promise(resolve=>{releaseRead=resolve;});
  if(denyList){res.statusCode=denyList;res.end(JSON.stringify({error:denyList===401?'Unauthorized':'Your account or session changed.'}));}else res.end(body);return;
 }
 const bytes=[];for await(const chunk of req)bytes.push(chunk);const body=JSON.parse(Buffer.concat(bytes).toString());requests.push({method:req.method,url:req.url,body});
 if(holdDelete)await new Promise(resolve=>{releaseDelete=resolve;});
 if(deleteFailure){res.statusCode=deleteFailure;res.end(JSON.stringify({error:deleteFailure===401?'Unauthorized':'Your connection changed. Reload before disconnecting.'}));return;}
 const accountId=decodeURIComponent(req.url.split('/').at(-1));rows=rows.map(row=>row.id===accountId?{...row,status:'revoked',revision:row.revision+1}:row);
 res.end(JSON.stringify({id:accountId,status:'revoked',revision:3}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/settings?tab=connected-accounts`);
 await expect(page.getByRole('button',{name:'Connected accounts',exact:true})).toHaveAttribute('aria-current','page');
 await expect(page.getByText('Connection saved',{exact:true})).toBeVisible();await expect(page.getByText('Connection expired',{exact:true})).toBeVisible();
 await expect(page.getByText('Saved access does not confirm service or model availability.',{exact:true})).toBeVisible();
 await expect(page.getByRole('textbox')).toHaveCount(0);await expect(page.getByRole('combobox')).toHaveCount(0);
 await expect(page.getByRole('button',{name:/^(Connect|Reconnect)$/})).toHaveCount(0);expect(requests).toHaveLength(0);
 await expect(page.getByRole('region',{name:/^Saved connection for/})).toHaveCount(100);
 await page.getByRole('button',{name:'Show more saved connections'}).click();await expect(page.getByRole('region',{name:/^Saved connection for/})).toHaveCount(101);
 expect(requests[0]).toEqual({method:'GET',url:`/api/hermes-team/member-connections?cursor=${id(99)}`});await expect(page.getByRole('button',{name:'Show more saved connections'})).toHaveCount(0);
 for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 const own=page.getByRole('region',{name:`Saved connection for ${rows[0].name}`,exact:true});
 holdDelete=true;await own.getByRole('button',{name:'Disconnect saved access'}).click();await expect(own.getByRole('button',{name:'Disconnect saved access'})).toBeDisabled();
 await expect.poll(()=>requests.filter(request=>request.method==='DELETE').length).toBe(1);expect(requests.at(-1)).toEqual({method:'DELETE',url:`/api/hermes-team/member-connections/${id(0)}`,body:{expectedRevision:2}});
 releaseDelete();holdDelete=false;await expect(own.getByText('Disconnected',{exact:true})).toBeVisible();
 await expect(page.getByText('Saved access disconnected. Your chat history is preserved. This does not revoke access at the outside service.',{exact:true})).toBeVisible();
 const expired=page.getByRole('region',{name:'Saved connection for Saved account 2',exact:true});deleteFailure=409;
 await expired.getByRole('button',{name:'Disconnect saved access'}).click();await expect(page.getByRole('alert')).toHaveText('Your connection changed. Reload before disconnecting.');
 await expect(page.getByRole('region',{name:/^Saved connection for/})).toHaveCount(0);await expect(page.getByRole('button',{name:'Show more saved connections'})).toHaveCount(0);
 deleteFailure=0;await page.getByRole('button',{name:'Refresh saved connections'}).click();await expect(expired.getByText('Connection expired',{exact:true})).toBeVisible();
 deleteFailure=401;await expired.getByRole('button',{name:'Disconnect saved access'}).click();await expect(page.getByRole('alert')).toHaveText('Unauthorized');
 await expect(page.getByRole('region',{name:/^Saved connection for/})).toHaveCount(0);await expect(page.getByRole('button',{name:'Show more saved connections'})).toHaveCount(0);
 deleteFailure=0;await page.getByRole('button',{name:'Refresh saved connections'}).click();await expect(expired.getByText('Connection expired',{exact:true})).toBeVisible();
 holdRead=true;releaseRead=undefined;await page.getByRole('button',{name:'Refresh saved connections'}).click();await expect.poll(()=>typeof releaseRead).toBe('function');const staleReply=releaseRead;
 await expired.getByRole('button',{name:'Disconnect saved access'}).click();await expect(expired.getByText('Disconnected',{exact:true})).toBeVisible();holdRead=false;staleReply();
 await expect(expired.getByText('Connection expired',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Refresh saved connections'})).toBeEnabled();
 denyList=403;await page.getByRole('button',{name:'Refresh saved connections'}).click();await expect(page.getByRole('alert')).toHaveText('Your account or session changed.');
 await expect(page.getByRole('region',{name:/^Saved connection for/})).toHaveCount(0);await expect(page.getByRole('button',{name:'Show more saved connections'})).toHaveCount(0);
 denyList=0;await page.getByRole('button',{name:'Refresh saved connections'}).click();await expect(page.getByRole('region',{name:/^Saved connection for/})).toHaveCount(100);
 denyList=401;await page.getByRole('button',{name:'Refresh saved connections'}).click();await expect(page.getByRole('alert')).toHaveText('Unauthorized');
 await expect(page.getByRole('region',{name:/^Saved connection for/})).toHaveCount(0);await expect(page.getByRole('button',{name:'Show more saved connections'})).toHaveCount(0);
 expect(requests.every(request=>request.url.startsWith('/api/hermes-team/member-connections'))).toBe(true);expect(requests.every(request=>request.method==='GET'||request.method==='DELETE')).toBe(true);
 await page.evaluate(()=>window.fixtureShowAccounts(false));await expect(page.getByRole('button',{name:'Connected accounts',exact:true})).toHaveCount(0);await expect(page.getByRole('region',{name:'Saved Team Bot connections'})).toHaveCount(0);
 expect(errors).toEqual([]);
 console.log('PASS saved Team connections in existing Settings: retained owner cleanup, 100+cursor pages, exact revision DELETE, expired/saved truthful status, double-click and stale 409/403/401, late reads do not restore disconnected accounts, no credential/auth inputs, empty tab omitted, 320–1280px actual CSS; synthetic HTTP only');
}finally{if(releaseRead)releaseRead();if(releaseDelete)releaseDelete();await browser.close();server.close();await rm(dir,{recursive:true,force:true});}
