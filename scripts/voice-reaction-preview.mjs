import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const value = flag => process.argv[process.argv.indexOf(flag) + 1];
const modelPath = process.argv.includes('--model') ? path.resolve(value('--model')) : null;
const port = process.argv.includes('--port') ? Number(value('--port')) : 4317;
const model = modelPath ? await readFile(modelPath) : null;
const alternate = process.argv.includes("--alternate-model") ? await readFile(path.resolve(value("--alternate-model"))) : null;
const result = await build({entryPoints:[path.join(root,'dev/voice-reaction-preview.tsx')],bundle:true,write:false,outdir:path.join(root,'.reaction-preview-build'),format:'iife',jsx:'automatic',alias:{'@':path.join(root,'src')},define:{'process.env.NODE_ENV':'"production"'}});
const javascript = result.outputFiles.find(file => file.path.endsWith('.js'));
if (!javascript) throw new Error('Reaction preview JavaScript bundle was not generated.');
const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Borg Hermes · Reaction Studio</title><style>
*{box-sizing:border-box}body{margin:0;background:#09131d;color:#e0edf4;font:15px system-ui}main{max-width:1320px;margin:auto;padding:32px}header{margin-bottom:28px}.eyebrow{font-size:11px;letter-spacing:.16em;color:#80b9bd}h1{font-weight:550;letter-spacing:-.045em;font-size:38px;margin:8px 0}p,footer{color:#a0b2bf;line-height:1.6}.studio{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(330px,1fr);gap:24px}.stage{background:radial-gradient(ellipse at 50% 35%,#213649,#101e2b 65%);border:1px solid #294052;border-radius:24px;overflow:hidden;position:relative}.avatar{width:100%;height:640px}.relative{position:relative}.h-full{height:100%}.w-full{width:100%}canvas{display:block}.caption{position:absolute;bottom:20px;left:24px;right:24px;display:flex;align-items:center;gap:10px}.caption span:last-child{margin-left:auto;color:#9bb8be;font-size:12px}.dot{width:7px;height:7px;background:#a9eee0;border-radius:50%}.controls{padding:20px;background:#111f2c;border:1px solid #294052;border-radius:24px}button,select{color:inherit;font:inherit;border:1px solid #334b5d;border-radius:10px;background:#172b3b;padding:11px;cursor:pointer}select{width:100%;margin:8px 0 16px}button:hover,button[aria-pressed=true]{background:#295366;border-color:#79b9c1}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #a3e9de;outline-offset:3px}.faces{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:16px}.motions{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;margin-bottom:20px}.faces button,.motions button{font-size:13px;padding:9px}label{display:block;margin:13px 0;color:#bcd0dc;font-size:13px}output{float:right;color:#a3e9de}input[type=range]{display:block;width:100%;accent-color:#a3e9de;margin-top:10px}.actions{display:flex;gap:8px;margin-top:22px}.primary{background:#a3e9de;color:#13262d;border-color:#a3e9de}.check{display:flex;align-items:center;gap:8px;line-height:1.4}.check input{accent-color:#a3e9de}details{border-top:1px solid #294052;margin-top:18px;padding-top:16px;font-size:12px}summary{cursor:pointer}pre{max-height:260px;overflow:auto;background:#07121c;padding:12px;font-size:11px}footer{font-size:12px;margin-top:20px}.absolute{position:absolute}.bottom-2{bottom:8px}.text-center{text-align:center}.inset-x-4{left:16px;right:16px}@media(max-width:760px){main{padding:18px}h1{font-size:30px}.studio{grid-template-columns:1fr}.avatar{height:500px}.caption{left:16px;right:16px}.caption span:last-child{display:none}.controls{padding:16px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style><style>${css}</style></head><body><div id="root"></div><script>window.reactionModels=${JSON.stringify(alternate ? [{label:"Verified v3 preview",url:"/avatars/preview.glb"},{label:"Experimental v4 preview · not live",url:"/avatars/alternate.glb"}] : undefined)};</script><script src="/bundle.js"></script></body></html>`;
const server = createServer((req,res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.url === '/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(javascript.contents);return;}
  if(req.url === '/avatars/alternate.glb' && alternate){res.setHeader('Content-Type','model/gltf-binary');res.end(alternate);return;}
  if(req.url === '/avatars/preview.glb' && model){res.setHeader('Content-Type','model/gltf-binary');res.end(model);return;}
  if(req.url !== '/'){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/html');res.end(html);
});
server.listen(port,'127.0.0.1',()=>console.log(`Reaction studio: http://127.0.0.1:${server.address().port} (${model ? 'local GLB loaded' : 'choose a local GLB under Model capabilities'})`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
