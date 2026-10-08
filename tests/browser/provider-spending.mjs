import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));const require=createRequire(path.join(root,'package.json'));
const {build}=require('esbuild');const {chromium,expect}=require('@playwright/test');
const dir=await mkdtemp(path.join(tmpdir(),'provider-spending-'));let browser,server;
try{
 const entry=path.join(dir,'entry.tsx');
 const fixture=`const now=new Date();const limit={status:'known',amount:100,currency:'USD',enforcement:'enforcing'};const snapshot={organization:'org-one',month:now.toISOString().slice(0,7),start:1,through:now.getTime()/1000,refreshedAt:location.pathname==='/stale'?'2020-01-01':now.toISOString(),costsStatus:'known',amounts:[{currency:'USD',value:95}],daily:[1,2,3].map(day=>({start:Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),day)/1000,end:Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),day+1)/1000,amounts:[{currency:'USD',value:day*10}]})),breakdownStatus:location.pathname==='/permissions'?'permission_denied':'known',projects:[{id:'proj-one',amounts:[{currency:'USD',value:2}]},{id:'proj-two',amounts:[{currency:'USD',value:93}]}],organizationLimit:limit,projectLimits:{'proj-one':{...limit,amount:50},'proj-two':{...limit,amount:200}}};const accounts=[{id:'one',name:'Fixture billing',organization:'org-one',enabled:true,showHealthBar:false,snapshot,lastAttemptAt:null,lastError:null},{id:'two',name:'Other account',organization:'org-two',enabled:false,showHealthBar:false,snapshot:null,lastAttemptAt:null,lastError:null}];`;
 await writeFile(entry,`import React from 'react';import{createRoot}from'${root}/node_modules/react-dom/client';import{SpendingDashboard}from'${root}/src/components/admin/spending-dashboard';${fixture}createRoot(document.getElementById('root')).render(<SpendingDashboard initial={location.pathname==='/empty'?[]:accounts}/>);`);
 const bundle=await build({entryPoints:[entry],bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src')},plugins:[{name:'fixture-actions',setup(b){b.onResolve({filter:/spending\/actions$/},()=>({path:'actions',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export async function saveBillingConfiguration(input){const {adminKey,...safe}=input;await fetch('/save',{method:'POST',body:JSON.stringify(input)});return {...safe,id:input.id??'new',snapshot:null,lastAttemptAt:null,lastError:null};}`,loader:'js'}));}}]});
 const css=await require('postcss')([require('@tailwindcss/postcss')({base:root})]).process(await readFile(path.join(root,'src/app/globals.css'),'utf8'),{from:path.join(root,'src/app/globals.css')});
 let failRefresh=false;const saves=[];
 server=createServer(async(req,res)=>{
  if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);return;}
  if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return;}
  if(req.url==='/save'){const chunks=[];for await(const c of req)chunks.push(c);saves.push(JSON.parse(Buffer.concat(chunks)));res.end('{}');return;}
  if(req.url==='/api/admin/spending/refresh'){res.statusCode=failRefresh?403:500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:failRefresh?'Admin only':'Fixture refresh failed'}));return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main style="padding:16px;max-width:1100px;margin:auto"><div id="root"></div></main><script src="/bundle.js"></script>');
 });
 await new Promise(resolve=>server.listen(process.argv.includes('--serve')?4198:0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 if(process.argv.includes('--serve')){console.log(`Synthetic provider dashboard preview: ${base}`);await new Promise(resolve=>process.on('SIGINT',resolve));}
 else{
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:960});await page.goto(base);await page.getByRole('combobox',{name:'Spending scope'}).selectOption('proj-one');
  await expect(page.getByText('Parent organization limit',{exact:true})).toBeVisible();await expect(page.getByText('USD 5.00',{exact:true})).toBeVisible();
  await expect(page.getByText('USD 48.00',{exact:true})).not.toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(width===390||width===1280){const out=path.join(root,'docs/screenshots/provider-spending');await mkdir(out,{recursive:true});await page.screenshot({path:path.join(out,`dashboard-${width}.png`),fullPage:true});}
  await page.getByRole('combobox',{name:'Billing account'}).selectOption('two');await expect(page.getByText('Provider spending is disabled.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Refresh provider data'})).toBeDisabled();
 }
 await page.goto(`${base}/stale`);await expect(page.getByText('Stale snapshot.',{exact:false})).toBeVisible();await expect(page.getByText('Unknown',{exact:true})).toBeVisible();
 await page.goto(`${base}/permissions`);await expect(page.getByText('Project breakdown permission denied.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Refresh provider data'}).click();await expect(page.getByRole('alert')).toHaveText('Fixture refresh failed');
 await page.goto(`${base}/empty`);await page.getByText('Billing configuration',{exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'Enable provider spending reads'})).not.toBeChecked();await expect(page.getByRole('checkbox',{name:'Show admin spending bar beside model selection'})).not.toBeChecked();
 await page.getByRole('textbox',{name:'Account label'}).fill('Fixture account');await page.getByRole('textbox',{name:'Organization ID'}).fill('org-fixture');await page.getByLabel('Separate API Platform Admin billing key',{exact:true}).fill('sk-admin-synthetic');
 await page.getByRole('button',{name:'Save billing configuration'}).click();await expect(page.getByText('Billing configuration saved.',{exact:true})).toBeVisible();expect(saves.at(-1)).toMatchObject({enabled:false,showHealthBar:false});await expect(page.getByLabel('Separate API Platform Admin billing key',{exact:true}).first()).toHaveValue('');
 expect(errors).toEqual([]);console.log('Provider dashboard: 320/390/768/1280 layouts, parent allowance, multiple accounts, stale/permissions, failed refresh, default-off key form and key clearing passed.');
 }
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
