import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const sharp = require('sharp');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'agent-browser-viewer-fixture-'));
const entry = path.join(dir, 'entry.tsx');
let mode = 'active';
const sequences = new Map();
let subscribers = 0;
let streamRequests = 0;
let rolloverPending = false;
const activeFixtureStreams = new Set();
let browser;

const fixtureSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560"><rect width="900" height="560" fill="#161920"/><rect width="900" height="42" fill="#242933"/><circle cx="22" cy="21" r="6" fill="#ee6352"/><circle cx="42" cy="21" r="6" fill="#f0b74e"/><circle cx="62" cy="21" r="6" fill="#59bd76"/><rect x="110" y="10" width="640" height="22" rx="10" fill="#353b46"/><text x="450" y="25" fill="#d7dce5" font-family="sans-serif" font-size="10" text-anchor="middle">test.invalid/synthetic-page</text><rect x="70" y="93" width="760" height="390" rx="12" fill="#20252e" stroke="#3a414d"/><text x="450" y="168" fill="#f4f5f7" font-family="sans-serif" font-size="26" font-weight="bold" text-anchor="middle">SYNTHETIC TEST FRAME</text><text x="450" y="208" fill="#a9b1bf" font-family="sans-serif" font-size="15" text-anchor="middle">Fabricated fixture page · not an agent session</text><rect x="300" y="264" width="300" height="46" rx="8" fill="#3e5f8e"/><text x="450" y="293" fill="white" font-family="sans-serif" font-size="14" text-anchor="middle">Fixture action button</text><text x="450" y="383" fill="#858f9f" font-family="sans-serif" font-size="12" text-anchor="middle">No real site, credentials or browser process involved</text></svg>`);
const jpeg = await sharp(fixtureSvg).jpeg({ quality: 74 }).toBuffer();
const jpegB64 = jpeg.toString('base64');
const entryCode = `
import React,{useState} from 'react';
import {createRoot} from '${root}/node_modules/react-dom/client';
import {Eye} from 'lucide-react';
import {AgentBrowserViewer} from '${root}/src/components/chat/agent-browser-viewer';
function App(){const [open,setOpen]=useState(true);const setMode=async value=>fetch('/fixture/mode?value='+value,{method:'POST'});return <div style={{display:'flex',height:'100dvh',overflow:'hidden',background:'var(--bg)',color:'var(--fg)'}}>
<main style={{display:'flex',minWidth:0,flex:1,flexDirection:'column'}}><div role="alert" style={{padding:'9px 14px',background:'#7b2d15',color:'white',fontSize:12,fontWeight:700}}>SYNTHETIC TEST FIXTURE · fabricated frames; never an agent session</div><header style={{display:'flex',height:58,flexShrink:0,alignItems:'center',justifyContent:'space-between',padding:'0 20px',borderBottom:'1px solid var(--border)'}}><div><strong>Research Bot</strong><p style={{fontSize:11,color:'var(--muted)'}}>Browser view consumer fixture</p></div><button aria-label={open?'Hide test browser view':'Show test browser view'} onClick={()=>setOpen(v=>!v)} style={{padding:10,borderRadius:8}}><Eye size={18}/></button></header><section style={{flex:1,padding:28}}><h1 style={{fontSize:20}}>A conversation beside the view</h1><p style={{marginTop:12,color:'var(--muted)',fontSize:13}}>The viewer is separate from the transcript and has no input controls.</p><div style={{display:'flex',gap:8,marginTop:20}}><button onClick={()=>setMode('active')}>Fresh fixture</button><button onClick={()=>setMode('stale')}>Stale fixture</button><button onClick={()=>setMode('idle')}>Idle fixture</button><button onClick={()=>fetch('/fixture/rollover',{method:'POST'})}>Rotate run in this chat</button></div></section></main>
<AgentBrowserViewer open={open} onClose={()=>setOpen(false)} conversationId="fixture-conversation"/></div>};
createRoot(document.getElementById('root')).render(<App/>);
`;
await (await import('node:fs/promises')).writeFile(entry, entryCode);
const moduleCssPath = path.join(root, 'src/components/chat/agent-browser-viewer.module.css');
const moduleCss = await readFile(moduleCssPath, 'utf8');
const classNames = [...new Set([...moduleCss.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)].map(match => match[1]))];
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, outdir: dir, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') }, plugins: [{
  name: 'fixture-css-modules', setup(build) {
    build.onLoad({ filter: /\.module\.css$/ }, async args => ({ contents: `export default ${JSON.stringify(Object.fromEntries(classNames.map(name => [name, name])))}`, loader: 'js' }));
  },
}] });
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });
const requests = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles.find(file => file.path.endsWith('.js')).contents); return; }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css + moduleCss); return; }
  if (url.pathname === '/fixture/mode' && req.method === 'POST') { mode = url.searchParams.get('value') ?? 'active'; res.end('{}'); return; }
  if (url.pathname === '/fixture/rollover' && req.method === 'POST') {
    rolloverPending = true;
    for (const stream of activeFixtureStreams) if (stream.conversationId === 'fixture-conversation') stream.stop();
    res.end('{}'); return;
  }
  if (url.pathname.startsWith('/api/agent-browser/')) {
    requests.push(url.pathname);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Test-Fixture-Only', 'fabricated frame source');
    if (url.pathname.endsWith('/status')) {
      const state = mode === 'idle' ? 'idle' : 'active';
      const lastFrameAt = mode === 'stale' ? new Date(Date.now() - 15_000).toISOString() : new Date().toISOString();
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ state, viewOnly: true, lastFrameAt })); return;
    }
    if (url.pathname.endsWith('/stream')) {
      streamRequests++;
      const conversationId = url.searchParams.get('conversationId') ?? 'missing';
      const rollover = rolloverPending; rolloverPending = false;
      if (rollover) sequences.set(conversationId, 0);
      subscribers++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
      let closed = false, timer;
      const close = () => {
        if (closed) return; closed = true;
        if (timer) clearInterval(timer); activeFixtureStreams.delete(stream); subscribers = Math.max(0, subscribers - 1);
      };
      const stream = { conversationId, stop: () => { res.end(); close(); } };
      activeFixtureStreams.add(stream);
      res.on('close', close);
      const send = () => {
        if (mode === 'stale') return;
        const sequence = (sequences.get(conversationId) ?? 0) + 1; sequences.set(conversationId, sequence);
        const data = JSON.stringify({ sequence, capturedAt: new Date().toISOString(), contentType: 'image/jpeg', width: 900, height: 560, data: jpegB64 });
        res.write(`event: frame\ndata: ${data}\n\n`);
      };
      send();
      if (rollover) { res.end(); close(); }
      else timer = setInterval(send, 500);
      return;
    }
  }
  res.setHeader('Content-Type', 'text/html'); res.end('<html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(address);
  await expect(page.getByRole('alert')).toContainText('SYNTHETIC TEST FIXTURE');
  await expect(page.getByRole('complementary', { name: 'Agent browser view' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Agent browser active');
  await expect(page.getByRole('img', { name: 'Current frame from the agent’s browser session' })).toBeVisible();
  await expect(page.getByText('SYNTHETIC TEST FRAME')).toHaveCount(0); // JPEG is a visual artifact, not page text.
  await expect(page.getByText('Read only · no mouse or keyboard controls')).toBeVisible();
  expect(requests).toContain('/api/agent-browser/status'); expect(requests).toContain('/api/agent-browser/stream');
  const separator = page.getByRole('separator', { name: 'Resize browser view panel' });
  await separator.focus(); await page.keyboard.press('ArrowLeft'); await expect(separator).toHaveAttribute('aria-valuenow', '584');
  await page.getByRole('button', { name: 'Close browser view' }).click();
  await expect(page.getByRole('complementary', { name: 'Agent browser view' })).toBeHidden();
  await expect.poll(() => subscribers).toBe(0);
  await page.getByRole('button', { name: 'Show test browser view' }).click();
  const frameImage = page.getByRole('img', { name: 'Current frame from the agent’s browser session' });
  await expect(frameImage).toBeVisible();
  await page.waitForTimeout(2200); // Let this synthetic session advance beyond sequence 1.
  const previousFrame = await frameImage.getAttribute('src');
  const previousStreamRequests = streamRequests;
  await page.getByRole('button', { name: 'Rotate run in this chat' }).click();
  await expect.poll(() => streamRequests).toBeGreaterThan(previousStreamRequests);
  await expect.poll(() => frameImage.getAttribute('src'), { timeout: 1000 }).not.toBe(previousFrame);
  await expect(frameImage).toHaveAttribute('data-frame-sequence', '1');
  await page.getByRole('button', { name: 'Stale fixture' }).click();
  await expect(page.getByText('Disconnected')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Current frame from the agent’s browser session' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Idle fixture' }).click();
  await expect(page.getByRole('status')).toContainText('Agent idle');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Close browser view' })).toBeInViewport();
  await page.screenshot({ path: path.join(dir, 'mobile-viewer.png') });
  await page.getByRole('button', { name: 'Close browser view' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(errors).toEqual([]);
  console.log('PASS: consumer fixture only; desktop split panel, bounded frame rendering, same-chat reconnect with sequence reset, stale-frame clearing, idle state, stream cleanup and mobile overlay. The fabricated fixture does not prove authentication, the W4 runtime or same-browser integration.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
