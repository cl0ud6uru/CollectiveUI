import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(root,'package.json'));
const {build}=require('esbuild'); const {chromium,expect}=require('@playwright/test');
const dir=await mkdtemp(path.join(tmpdir(),'workspace-artifact-browser-'));
let browser; let server;
try {
 const entry=path.join(dir,'entry.tsx');
 await writeFile(entry,`import React from 'react';import {createRoot} from '${root}/node_modules/react-dom/client';import {ToolPartView} from '${root}/src/components/chat/tool-part';const part={type:'tool-workspace_write',toolCallId:'call',state:'output-available',input:{path:'./drawing.svg',content:'fixture'},output:{ok:true,path:'./drawing.svg',downloadUrl:'https://evil.test'}};createRoot(document.getElementById('root')).render(<ToolPartView part={part} onApprove={()=>{}} onDeny={()=>{}}/>);`);
 const bundle=await build({entryPoints:[entry],bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':path.join(root,'src')},plugins:[{name:'fixture',setup(build){build.onResolve({filter:/workspace-actions$/},()=>({path:'actions',namespace:'fixture'}));build.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='link'?`import React from 'react';export default function Link(props){return <a {...props}/>}`:`export async function stopWorkspaceCommand(){return {ok:true}}`,loader:'jsx',resolveDir:root}));}}]});
 const svg='<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>fixture</text></svg>';
 const requests=[];
 server=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);}else if(url.pathname==='/api/workspace/files'){requests.push(url.searchParams.get('path'));res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''drawing.svg",'X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"});res.end(svg);}else{res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script src="/bundle.js"></script>');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})});
 for(const viewport of [{width:1280,height:800},{width:390,height:844}]){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',()=>{throw new Error('SVG executed')});
  await page.goto(`http://127.0.0.1:${server.address().port}/c/fixture`);
  const action=page.getByRole('link',{name:'Download drawing.svg'});await expect(action).toBeVisible();await expect(action).toHaveAttribute('href','/api/workspace/files?path=drawing.svg');
  const downloadPromise=page.waitForEvent('download');await action.click();const download=await downloadPromise;expect(download.suggestedFilename()).toBe('drawing.svg');expect((await readFile(await download.path(),'utf8'))).toBe(svg);expect(page.url()).toContain('/c/fixture');expect(errors).toEqual([]);await page.close();
 }
 expect(requests).toEqual(['drawing.svg','drawing.svg']);console.log('Desktop and mobile artifact downloads passed; SVG bytes saved, conversation preserved.');
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
