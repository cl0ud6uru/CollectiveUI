import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real GLB loader and renderer, synthetic morphs and transcripts. No microphone or paid provider.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'collective-avatar-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
import {VoiceAvatar} from '@/components/chat/voice-avatar';import {VoiceBridge} from '@/lib/voice/bridge';import {AvatarFace,AvatarMotion} from '@/lib/voice/avatar-animation';
import {Mesh,SphereGeometry,MeshStandardMaterial,Float32BufferAttribute,Group,AnimationClip,QuaternionKeyframeTrack,Quaternion,Euler} from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
const faceUpdate=AvatarFace.prototype.update;AvatarFace.prototype.update=function(...args){faceUpdate.apply(this,args);window.pose={reaction:args[0],capabilities:this.capabilities,weights:this.bindings.map(b=>({index:b.index,value:b.value,smile:b.smile>0,concerned:b.concerned>0}))};window.avatarFrames=(window.avatarFrames||0)+1};
const motionUpdate=AvatarMotion.prototype.update;AvatarMotion.prototype.update=function(...args){motionUpdate.apply(this,args);window.body={clips:['idle','nod','curious','smile','concerned'].filter(name=>this.hasClip(name)),idlePlaying:this.actions.get('idle')?.isRunning(),nodRunning:this.actions.get('nod')?.isRunning(),nodWeight:this.actions.get('nod')?.getEffectiveWeight()||0,nodTime:this.actions.get('nod')?.time,mixerTime:this.mixer.time}};
async function model(rig){const geometry=new SphereGeometry(0.8,24,16);if(rig){geometry.morphTargetsRelative=true;geometry.morphAttributes.position=['browInnerUp','mouthFrown','mouthSmile'].map((name,i)=>{const data=new Float32Array(geometry.attributes.position.count*3);for(let j=0;j<data.length;j+=3)data[j+1]=geometry.attributes.position.getX(j/3)*(i===1?-0.12:0.08);const a=new Float32BufferAttribute(data,3);a.name=name;return a})}const head=new Mesh(geometry,new MeshStandardMaterial({color:0xb7d7eb,roughness:0.6}));head.name='Head';head.updateMorphTargets();const scene=new Group();scene.add(head);const q=a=>new Quaternion().setFromEuler(new Euler(a,0,0)).toArray();const clips=rig?['idle','nod','concerned'].map(name=>new AnimationClip(name,1,[new QuaternionKeyframeTrack('Head.quaternion',[0,1],[...q(0),...q(name==='idle'?0:0.12)])])):[];const bytes=await new GLTFExporter().parseAsync(scene,{binary:true,animations:clips});return URL.createObjectURL(new Blob([bytes],{type:'model/gltf-binary'}))}
function App(){const [url,setUrl]=useState(null),[reaction,setReaction]=useState('neutral'),[revision,setRevision]=useState(0),[visible,setVisible]=useState(true),[size,setSize]=useState({width:500,height:500});const react=r=>{setReaction(r);setRevision(v=>v+1)};useEffect(()=>{let mounted=true;model(true).then(url=>{if(mounted)setUrl(url)});const bridge=new VoiceBridge({conversationId:'conversation01',sessionId:'fixture01',reactions:true,send:()=>{throw Error('Partial transcripts must not send bot events')},changed:()=>{},transcript:()=>{},reaction:react,notice:()=>{},approval:()=>{throw Error('Reactions cannot approve')}});window.emit=e=>bridge.receive(e);window.change=react;window.show=setVisible;window.resize=(width,height)=>setSize({width,height});window.load=async rig=>setUrl(await model(rig));window.missing=()=>setUrl('/avatars/missing.glb');window.restore=()=>setUrl('/avatars/borg.glb');return()=>{mounted=false;bridge.dispose()}},[]);return <div style={{height:size.height,width:size.width}}><VoiceAvatar reaction={reaction} reactionRevision={revision} audio={null} modelUrl={url} active={true} visible={visible}/></div>};createRoot(document.getElementById('root')).render(<App/>);`);
const bundle = await build({ entryPoints: [entry], outfile: path.join(dir, 'bundle.js'), write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') } });
const requests = [];
const borg = process.env.VOICE_AVATAR_MODEL_PATH ? await readFile(process.env.VOICE_AVATAR_MODEL_PATH) : null;
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (req.url === '/avatars/borg.glb' && borg) { res.setHeader('Content-Type', 'model/gltf-binary'); res.end(borg); return; }
  if (req.url.startsWith('/avatars/')) { res.writeHead(404); res.end(); return; }
  if (req.url === '/api/voice/reaction') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    res.setHeader('Content-Type', 'application/json');
    // Delay while many deltas arrive; this must still react before assistant output.
    setTimeout(() => res.end(JSON.stringify({ revision: body.revision, reaction: 'concerned', confidence: 0.95 })), 120);
    return;
  }
  res.setHeader('Content-Type', 'text/html'); res.end('<html><head><style>html,body{margin:0;background:#152334}.h-full{height:100%}.w-full{width:100%}.relative{position:relative}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(base);
  await expect.poll(() => page.evaluate(() => window.pose?.capabilities.concerned)).toBe(true);
  const weight = index => page.evaluate(i => window.pose?.weights.find(b => b.index === i)?.value ?? 0, index);
  await page.evaluate(() => {
    const input = (id, delta, start) => window.emit({ type: 'session.input_transcript.delta', event_id: id, delta, start_ms: start, end_ms: start + 5 });
    input('sad', 'My friend died', 0);
    setTimeout(() => { for (let i = 0; i < 20; i++) input('tiny' + i, ' x', 10 + i * 5); }, 40);
  });
  await expect.poll(() => weight(1)).toBeGreaterThan(0.55);
  expect(requests[0].context).toContain('Latest partial utterance (user;');
  expect(requests[0].context).toContain('My friend died');
  const screenshots = process.env.VOICE_AVATAR_SCREENSHOT_DIR;
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, 'synthetic-concerned.png') }); }
  // No three-second idle reset of the face.
  await page.waitForTimeout(3200); expect(await weight(1)).toBeGreaterThan(0.6);
  await page.evaluate(() => window.change('neutral'));
  await expect.poll(() => weight(1)).toBeLessThan(0.01);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.evaluate(() => window.change('concerned'));
  await expect.poll(() => weight(1)).toBeGreaterThan(0.6);
  await page.evaluate(() => window.show(false)); await page.waitForTimeout(100);
  const pausedFrames = await page.evaluate(() => window.avatarFrames); await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.avatarFrames)).toBe(pausedFrames);
  await page.evaluate(() => { window.change('smile'); window.show(true); });
  await expect.poll(() => weight(2)).toBeGreaterThan(0.55);
  await page.evaluate(() => window.load(false));
  await expect.poll(() => page.evaluate(() => window.pose?.capabilities.concerned)).toBe(false);
  await page.evaluate(() => window.missing());
  await expect(page.getByRole('status')).toHaveText('Avatar model unavailable. Using the placeholder.');
  await expect(page.locator('canvas')).toBeVisible();
  if (borg) {
    await page.evaluate(() => { window.change('concerned'); window.restore(); });
    await expect.poll(() => page.evaluate(() => window.pose?.capabilities.concerned)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.pose.weights.some(b => b.value > 0.6))).toBe(true);
    await expect(page.getByRole('status')).toHaveCount(0);
    if (screenshots) {
      await page.screenshot({ path: path.join(screenshots, 'borg-concerned.png') });
      await page.evaluate(() => window.change('neutral')); await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(screenshots, 'borg-neutral.png') });
      await page.evaluate(() => window.change('smile'));
      await expect.poll(() => page.evaluate(() => window.pose.weights.some(b => b.smile && b.value > 0.55))).toBe(true);
      await page.screenshot({ path: path.join(screenshots, 'borg-smile.png') });
      await page.evaluate(() => window.change('neutral')); await page.waitForTimeout(1500);
    }
    // Use the actual tall mobile canvas so the camera must update its horizontal fit on resize.
    await page.setViewportSize({ width: 390, height: 650 });
    await page.evaluate(() => window.resize(390, 650));
    await expect.poll(() => page.locator('canvas').evaluate(canvas => [canvas.clientWidth, canvas.clientHeight])).toEqual([390, 650]);
    await page.evaluate(() => window.change('concerned'));
    await expect.poll(() => page.evaluate(() => window.pose.weights.some(b => b.concerned && b.value > 0.6))).toBe(true);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'borg-mobile-concerned.png') });
    await page.evaluate(() => window.change('neutral')); await page.waitForTimeout(1500);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'borg-mobile-neutral.png') });
    await page.evaluate(() => window.change('smile'));
    await expect.poll(() => page.evaluate(() => window.pose.weights.some(b => b.smile && b.value > 0.55))).toBe(true);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'borg-mobile-smile.png') });
    await page.setViewportSize({ width: 600, height: 600 });
    await page.evaluate(() => { window.resize(500, 500); window.change('neutral'); });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.body.clips)).toEqual(['idle', 'nod', 'curious', 'smile', 'concerned']);
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.evaluate(() => window.change('nod'));
    await expect.poll(() => page.evaluate(() => window.body.idlePlaying && window.body.nodRunning && window.body.nodWeight > 0.8)).toBe(true);
    try { await expect.poll(() => page.evaluate(() => window.body.idlePlaying && window.body.nodWeight < 0.01), { timeout: 6000 }).toBe(true); }
    catch (error) { console.log('Fixture clip timing:', await page.evaluate(() => ({ ...window.body, frames: window.avatarFrames, reaction: window.pose.reaction }))); throw error; }
  }
  expect(errors).toEqual([]);
  console.log('Avatar browser checks passed: mid-story face, GLB morphs, hold/release, reduced motion, minimize/resume, missing rig/model' + (borg ? ', local Borg model' : '') + '.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
}
