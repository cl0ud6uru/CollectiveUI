import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const sharp = require('sharp');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const dir = await (await import('node:fs/promises')).mkdtemp(path.join(tmpdir(), 'computer-viewer-fixture-'));
const entry = path.join(dir, 'entry.tsx');
const screenshotDir = path.join(root, 'docs/screenshots/computer-view');
await mkdir(screenshotDir, { recursive: true });
let mode = 'active';
let sequence = 0;
let streams = new Set();
const receivedInputs = [];
const controlActions = [];
const sessions = new Map([
  ['fixture-conversation', { control: 'agent', paused: false }],
  ['other-conversation', { control: 'agent', paused: false }],
]);
let delayNextTakeover = false;
let browser;

const fixtureSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#101820"/><rect width="1280" height="48" fill="#192733"/><circle cx="25" cy="24" r="7" fill="#e16b61"/><circle cx="49" cy="24" r="7" fill="#e2b553"/><circle cx="73" cy="24" r="7" fill="#60ba86"/><rect x="155" y="11" width="900" height="26" rx="13" fill="#273846"/><text x="605" y="29" fill="#bac8d3" font-family="sans-serif" font-size="13" text-anchor="middle">fixture.local / computer-view-demo</text><rect x="90" y="110" width="1100" height="595" rx="16" fill="#17232c" stroke="#34434d" stroke-width="2"/><text x="640" y="240" fill="#f1f5f7" font-family="sans-serif" font-size="36" font-weight="bold" text-anchor="middle">SYNTHETIC COMPUTER FRAME</text><text x="640" y="284" fill="#aab8c1" font-family="sans-serif" font-size="18" text-anchor="middle">Fabricated test screen · no real desktop or agent session</text><rect x="450" y="360" width="380" height="64" rx="12" fill="#385e78"/><text x="640" y="400" fill="#fff" font-family="sans-serif" font-size="18" text-anchor="middle">Synthetic action target</text><text x="640" y="520" fill="#93a0a8" font-family="sans-serif" font-size="15" text-anchor="middle">No credentials, user data or browser process involved</text></svg>`);
const jpeg = await sharp(fixtureSvg).jpeg({ quality: 79 }).toBuffer();
const jpegB64 = jpeg.toString('base64');
const entryCode = `
import React,{useState} from 'react';
import {createRoot} from '${root}/node_modules/react-dom/client';
import {ComputerViewer} from '${root}/src/components/chat/computer-viewer';
function App(){const [open,setOpen]=useState(true);const [conversationId,setConversationId]=useState('fixture-conversation');return <div style={{display:'flex',height:'100dvh',overflow:'hidden',background:'var(--bg)',color:'var(--fg)'}}><main style={{display:'flex',minWidth:0,flex:1,flexDirection:'column'}}><div role="alert" style={{padding:'9px 14px',background:'#713918',color:'white',fontSize:12,fontWeight:700}}>SYNTHETIC TEST FIXTURE · fabricated computer frames; never an agent session</div><header style={{padding:'18px 22px',borderBottom:'1px solid var(--border)'}}><strong>Codex task · fixture demo</strong><p style={{fontSize:11,color:'var(--muted)'}}>Full computer viewer consumer fixture</p></header><section style={{padding:24}}><h1 style={{fontSize:20}}>A conversation beside the computer</h1><p style={{marginTop:10,color:'var(--muted)',fontSize:13}}>The fabricated screen is supplied by a local test server.</p><div style={{display:'flex',gap:8,marginTop:16}}>{!open&&<button style={{padding:10}} onClick={()=>setOpen(true)}>Reopen computer view</button>}<button style={{padding:10}} onClick={()=>setConversationId(id=>id==='fixture-conversation'?'other-conversation':'fixture-conversation')}>Switch conversation</button></div></section></main><ComputerViewer open={open} onClose={()=>setOpen(false)} conversationId={conversationId}/></div>};
createRoot(document.getElementById('root')).render(<App/>);
`;
await (await import('node:fs/promises')).writeFile(entry, entryCode);
const moduleCssPath = path.join(root, 'src/components/chat/computer-viewer.module.css');
const moduleCss = await readFile(moduleCssPath, 'utf8');
const classNames = [...new Set([...moduleCss.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)].map(match => match[1]))];
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, outdir: dir, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') }, plugins: [{
  name: 'fixture-css-modules', setup(build) { build.onLoad({ filter: /\.module\.css$/ }, async () => ({ contents: `export default ${JSON.stringify(Object.fromEntries(classNames.map(name => [name, name])))}`, loader: 'js' })); },
}] });
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles.find(file => file.path.endsWith('.js')).contents); return; }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css + moduleCss); return; }
  if (url.pathname === '/fixture/mode' && req.method === 'POST') { mode = url.searchParams.get('value') ?? 'active'; res.end('{}'); return; }
  if (url.pathname === '/fixture/drop' && req.method === 'POST') { for (const stream of streams) stream.stop(); streams.clear(); res.end('{}'); return; }
  if (url.pathname === '/fixture/expire' && req.method === 'POST') { sessions.get('fixture-conversation').control = 'other'; sessions.get('fixture-conversation').paused = true; res.end('{}'); return; }
  if (url.pathname === '/fixture/delay-takeover' && req.method === 'POST') { delayNextTakeover = true; res.end('{}'); return; }
  if (url.pathname === '/api/computer/status') {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Type', 'application/json');
    const session = sessions.get(url.searchParams.get('conversationId')) ?? { control: 'agent', paused: false };
    const stale = mode === 'stale'; res.end(JSON.stringify({ available: mode !== 'stopped', state: mode === 'stopped' ? 'stopped' : 'running', control: session.control, paused: session.paused, lastFrameAt: stale ? new Date(Date.now() - 10_000).toISOString() : new Date().toISOString(), width: 1280, height: 800, ...(mode === 'stopped' ? { reason: 'Synthetic fixture stopped.' } : session.control === 'other' ? { reason: 'Lease expired; take over to resume computer access.' } : {}) })); return;
  }
  if (url.pathname === '/api/computer/control' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const { conversationId, action } = JSON.parse(body);
    const session = sessions.get(conversationId) ?? { control: 'agent', paused: false };
    controlActions.push({ conversationId, action });
    if (action === 'takeover' && delayNextTakeover) { delayNextTakeover = false; await new Promise(resolve => setTimeout(resolve, 800)); }
    if (action === 'takeover') { session.control = 'you'; session.paused = true; }
    if (action === 'release') { session.control = 'agent'; session.paused = false; }
    sessions.set(conversationId, session);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ available: true, state: 'running', control: session.control, paused: session.paused, lastFrameAt: new Date().toISOString(), width: 1280, height: 800 })); return;
  }
  if (url.pathname === '/api/computer/input' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const { conversationId, input } = JSON.parse(body);
    if (sessions.get(conversationId)?.control !== 'you') { res.writeHead(409); res.end(); return; }
    if (input.kind === 'type' && /[\u0000-\u001f\u007f-\u009f]/.test(input.text)) { res.writeHead(400); res.end(); return; }
    receivedInputs.push({ conversationId, input }); res.writeHead(204); res.end(); return;
  }
  if (url.pathname === '/api/computer/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    let closed = false, timer;
    const stop = () => { if (closed) return; closed = true; if (timer) clearInterval(timer); streams.delete(stream); res.end(); };
    const stream = { stop }; streams.add(stream); res.on('close', () => { closed = true; if (timer) clearInterval(timer); streams.delete(stream); });
    const send = () => {
      if (mode === 'stale') {
        const data = JSON.stringify({ sequence: ++sequence, capturedAt: new Date(Date.now() - 10_000).toISOString(), contentType: 'image/jpeg', width: 1280, height: 800, data: jpegB64 });
        res.write(`event: frame\ndata: ${data}\n\n`); return;
      }
      if (mode !== 'active' || closed) return;
      const data = JSON.stringify({ sequence: ++sequence, capturedAt: new Date().toISOString(), contentType: 'image/jpeg', width: 1280, height: 800, data: jpegB64 });
      res.write(`event: frame\ndata: ${data}\n\n`);
    };
    send(); timer = setInterval(send, 500); return;
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
  const viewer = page.getByRole('complementary', { name: 'Computer viewer' });
  await expect(viewer).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Live');
  const frame = page.getByRole('img', { name: /Fresh computer frame captured/ });
  await expect(frame).toBeVisible();
  await expect(page.getByText('The agent has control of this computer.')).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, 'computer-view-desktop.png') });

  // A screen click cannot reach the backend without an explicit control lease.
  await frame.evaluate(image => { const rect = image.getBoundingClientRect(); image.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, pointerId: 1, pointerType: 'mouse' })); });
  await page.getByRole('main', { name: 'Codex computer screen' }).evaluate(stage => stage.focus());
  await page.keyboard.press('Enter');
  expect(receivedInputs).toHaveLength(0);
  await page.getByRole('button', { name: 'Take over' }).click();
  await expect(page.getByRole('textbox', { name: 'Type text' })).toBeEnabled();
  await frame.evaluate(image => { const rect = image.getBoundingClientRect(); image.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, pointerId: 1, pointerType: 'mouse' })); });
  await page.getByRole('main', { name: 'Codex computer screen' }).focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('textbox', { name: 'Type text' }).fill('synthetic test text');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('main', { name: 'Codex computer screen' }).evaluate(stage => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', 'first\nsecond\tthird\u0007\u0085');
    stage.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => receivedInputs.length).toBe(4);
  expect(receivedInputs[0]).toMatchObject({ conversationId: 'fixture-conversation', input: { kind: 'click', button: 'left' } });
  expect(receivedInputs[1]).toEqual({ conversationId: 'fixture-conversation', input: { kind: 'key', key: 'ArrowDown' } });
  expect(receivedInputs[2]).toEqual({ conversationId: 'fixture-conversation', input: { kind: 'type', text: 'synthetic test text' } });
  expect(receivedInputs[3]).toEqual({ conversationId: 'fixture-conversation', input: { kind: 'type', text: 'first second third' } });
  await page.getByRole('button', { name: 'Return control' }).click();
  await expect(page.getByText('The agent has control of this computer.')).toBeVisible();

  await page.evaluate(async () => { await fetch('/fixture/mode?value=disconnected', { method: 'POST' }); await fetch('/fixture/drop', { method: 'POST' }); });
  await expect(page.getByRole('status')).toContainText('Reconnecting', { timeout: 4000 });
  await page.evaluate(() => fetch('/fixture/mode?value=active', { method: 'POST' }));
  await expect(frame).toBeVisible({ timeout: 6000 });

  await page.evaluate(() => fetch('/fixture/mode?value=stale', { method: 'POST' }));
  await expect(page.getByRole('img', { name: /Fresh computer frame captured/ })).toHaveCount(0, { timeout: 4000 });
  await expect(page.getByRole('status')).not.toContainText('Live');
  await page.evaluate(() => fetch('/fixture/mode?value=active', { method: 'POST' }));
  await expect(frame).toBeVisible({ timeout: 6000 });

  await page.getByRole('button', { name: 'Take over' }).click();
  await expect(page.getByText(/Closing the view leaves the agent paused until you return control\./)).toBeVisible();
  await page.getByRole('button', { name: 'Close computer view' }).click();
  await expect(page.getByRole('complementary', { name: 'Computer viewer' })).toBeHidden();
  expect(controlActions.filter(action => action.action === 'release')).toHaveLength(1);
  await page.evaluate(() => fetch('/fixture/expire', { method: 'POST' }));
  await page.getByRole('button', { name: 'Reopen computer view' }).click();
  await expect(page.getByText('Lease expired; take over to resume computer access.')).toBeVisible();
  await expect(page.getByText('Closing the view leaves the agent paused until you return control.')).toBeVisible();

  await page.evaluate(() => fetch('/fixture/delay-takeover', { method: 'POST' }));
  await page.getByRole('button', { name: 'Take over' }).click();
  await page.getByRole('button', { name: 'Switch conversation' }).click();
  await expect(page.getByText('The agent has control of this computer.')).toBeVisible();
  await page.waitForTimeout(1000); // Let the old conversation's delayed takeover response arrive.
  await expect(page.getByText('The agent has control of this computer.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Type text' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Take over' }).click();
  await expect(page.getByRole('button', { name: 'Return control' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Close computer view' })).toBeInViewport();
  await page.screenshot({ path: path.join(screenshotDir, 'computer-view-mobile.png') });
  await page.getByRole('button', { name: 'Close computer view' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(errors).toEqual([]);
  console.log('PASS: synthetic fixture covered sanitized text input, explicit takeover, close-with-paused-task lease expiry, stale cross-conversation takeover responses, reconnect recovery, stale frame clearing, and mobile dialog. Captures are saved under docs/screenshots/computer-view/.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
