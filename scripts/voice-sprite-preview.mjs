import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
const root = fileURLToPath(new URL('../', import.meta.url));
const index = process.argv.indexOf('--port');
const port = index < 0 ? 4321 : Number(process.argv[index + 1]);
const bundle = await build({ entryPoints: [path.join(root,'dev/voice-sprite-preview.tsx')], outdir: 'sprite-preview', bundle:true, write:false, format:'iife', jsx:'automatic', alias:{'@':path.join(root,'src')}, define:{'process.env.NODE_ENV':'"production"'} });
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).contents;
const native = await readFile(path.join(root,'ios/CollectiveUI/Voice/Resources/voice-engine.html'));
const sprites = new Map(await Promise.all(['hermes','hermes-assimilated','the-queen','nimbus'].map(async name => {
  const directory = path.join(root,`assets/pets/${name}/v2`);
  const manifest = JSON.parse(await readFile(path.join(directory,'pet.json'),'utf8'));
  return [name,await readFile(path.join(directory,manifest.spritesheetPath))];
})));
sprites.set('legacy',await sharp(sprites.get('hermes')).extract({left:0,top:0,width:1536,height:1872}).png().toBuffer());
const invalid = await sharp({create:{width:1,height:1,channels:4,background:'#0000'}}).png().toBuffer();
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CollectiveUI · Sprite voice preview</title><style>${css}
*{box-sizing:border-box}body{margin:0;background:#0b1422;color:#edf3fa;font:15px system-ui}main{max-width:1180px;margin:auto;padding:32px}header span{font-size:11px;letter-spacing:.14em;color:#9fe8d3}h1{font-size:36px;letter-spacing:-.03em;font-weight:550;margin:12px 0}p{color:#a1b1c8;line-height:1.6}.studio{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,1fr);gap:24px}.stage{background:radial-gradient(ellipse at 50% 40%,#22354e,#101c2e 70%);border:1px solid #30415b;border-radius:24px;overflow:hidden}.avatar{height:540px}.caption{display:flex;justify-content:space-between;padding:20px 24px;border-top:1px solid #30415b}.caption span{color:#9fe8d3}.controls{padding:24px;border:1px solid #30415b;border-radius:24px;background:#111e30}label{display:block;font-size:13px}select,button{font:inherit;color:inherit;background:#1c304a;border:1px solid #3f5370;border-radius:10px;padding:10px}select{width:100%;margin:8px 0 18px}button{cursor:pointer}.reactions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.actions{display:flex;gap:8px;margin:20px 0}.check{display:flex;gap:10px;align-items:center;margin:16px 0}.limits{font-size:12px}a{color:#9fe8d3}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #9fe8d3;outline-offset:3px}@media(max-width:760px){main{padding:18px}.studio{grid-template-columns:1fr}h1{font-size:29px}.avatar{height:370px}.controls{padding:18px}.caption{font-size:13px}}.relative{position:relative}.h-full{height:100%}.w-full{width:100%}
</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
const server = createServer((req,res) => {
  res.setHeader('Cache-Control','no-store');
  const url = new URL(req.url,'http://localhost');
  if(url.pathname === '/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return;}
  if(url.pathname === '/native'){res.setHeader('Content-Type','text/html');res.end(native);return;}
  if(url.pathname === '/invalid.png'){res.setHeader('Content-Type','image/png');res.end(invalid);return;}
  const match = /^\/sprites\/([a-z-]+)\.webp$/.exec(url.pathname);
  if(match && sprites.has(match[1])){res.setHeader('Content-Type',['legacy','the-queen'].includes(match[1]) ? 'image/png' : 'image/webp');res.end(sprites.get(match[1]));return;}
  if(url.pathname !== '/'){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/html');res.end(html);
});
server.listen(port,'127.0.0.1',()=>console.log(`Offline sprite preview: http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
