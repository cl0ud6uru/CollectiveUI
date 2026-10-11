import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real fullscreen UI, Three.js renderer and voice bridge; synthetic transport and backend, no paid inference.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'collective-voice-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {VoiceControl} from '@/components/chat/voice-control';
function App(){const [active,setActive]=useState(false);return <main className="h-screen bg-bg p-8 text-fg"><h1>CollectiveUI voice fixture</h1><VoiceControl target={{botId:'bot00000001',conversationId:'chat00000001'}} conversationId="chat00000001" name="Nimbus" onActiveChange={setActive} onConversationChange={()=>{window.changes=(window.changes||0)+1}} chatContext="user: Remember my notes"/><p data-testid="voice-state">{active?'Voice active':'Voice idle'}</p><input aria-label="Message Nimbus" placeholder="Keep typing here" /></main>};createRoot(document.getElementById('root')).render(<App/>);`);
const bundle = await build({ entryPoints: [entry], outfile: path.join(dir, 'bundle.js'), write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') } });
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });
const batches = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css); return; }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (url.pathname === '/api/voice/session') res.end(JSON.stringify(body ? { session: { id: 'live01' }, transport: { type: 'webrtc', sdp: 'answer' }, context: 'user: Remember my notes', reactions: true, avatarUrl: null } : { supported: true }));
    else if (url.pathname === '/api/voice/reaction') res.end(JSON.stringify({ reaction: 'curious', revision: body.revision, latencyMs: 10 }));
    else if (url.pathname === '/api/voice/turn') {
      if (body) { batches.push(body); res.end(JSON.stringify({ messageId: body.delegate ? 'reply0000001' : null, status: body.delegate ? 'queued' : 'saved' })); }
      else res.end(JSON.stringify({ status: 'succeeded', text: 'Your saved note is ready.' }));
    } else { res.writeHead(404); res.end('{}'); }
    return;
  }
  res.setHeader('Content-Type', 'text/html'); res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.commands = []; window.trackStopped = false;
    const track = { enabled: true, stop() { window.trackStopped = true; } };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) });
    class Channel extends EventTarget {
      readyState = 'open';
      send(raw) { const event = JSON.parse(raw); window.commands.push(event); if (event.type === 'session.close') setTimeout(() => this.emit({ type: 'session.closed' }), 10); }
      emit(event) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })); }
      close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
    }
    class Peer extends EventTarget {
      iceGatheringState = 'complete'; connectionState = 'connected'; localDescription = null;
      addTrack() {} createDataChannel() { return window.voiceChannel = new Channel(); }
      async createOffer() { return { type: 'offer', sdp: 'offer' }; }
      async setLocalDescription(description) { this.localDescription = description; }
      async setRemoteDescription() { setTimeout(() => window.voiceChannel.emit({ type: 'session.started' }), 10); }
      close() { this.connectionState = 'closed'; this.dispatchEvent(new Event('connectionstatechange')); }
    }
    window.RTCPeerConnection = Peer;
  });
  await page.goto(base);
  await page.getByRole('button', { name: 'Voice conversation', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await dialog.boundingBox())?.width).toBe(1280);
  await expect.poll(async () => (await dialog.boundingBox())?.height).toBe(900);
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const emit = event => window.voiceChannel.emit(event);
    emit({ type: 'session.input_transcript.delta', event_id: 'u1', delta: 'Find my notes', start_ms: 0, end_ms: 500 });
    emit({ type: 'session.output_transcript.delta', event_id: 'a1', delta: 'Let me check.', start_ms: 450, end_ms: 700 });
    emit({ type: 'session.delegation.created', event_id: 'd1', offset_ms: 750, delegation: { id: 'delegate1', target: 'client' } });
  });
  await expect.poll(() => batches.filter(b => b.delegate).length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.commands.some(c => c.content === 'Your saved note is ready.'))).toBe(true);
  await page.getByRole('button', { name: 'Toggle captions' }).click();
  await expect(page.getByLabel('Live captions')).toContainText('Find my notes');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
  await page.getByRole('button', { name: 'Unmute microphone' }).click();
  await page.getByRole('button', { name: 'Minimize voice' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('voice-state')).toHaveText('Voice active');
  expect(await page.evaluate(() => window.trackStopped)).toBe(false);
  await page.getByLabel('Message Nimbus').fill('A typed follow-up');
  await page.getByRole('button', { name: 'Expand voice conversation' }).click();
  await expect(page.locator('canvas')).toBeVisible();
  const screenshots = process.env.VOICE_SCREENSHOT_DIR;
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, 'voice-desktop.png') }); }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await dialog.boundingBox())?.width).toBe(390);
  await expect(page.getByRole('button', { name: 'End voice', exact: true })).toBeInViewport();
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'voice-mobile.png') });
  await page.evaluate(() => window.voiceChannel.emit({ type: 'session.output_transcript.delta', event_id: 'a2', delta: 'Your note is ready.', start_ms: 900, end_ms: 1200 }));
  await page.getByRole('button', { name: 'End voice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeEnabled();
  await expect.poll(() => batches.some(b => !b.delegate && b.fragments.some(f => f.text === 'Your note is ready.'))).toBe(true);
  expect(await page.evaluate(() => window.trackStopped)).toBe(true);
  expect(errors).toEqual([]);
  console.log('Voice browser checks passed: desktop/mobile fullscreen, 3D canvas, streaming captions, bot delegation, mute, minimize/typing, end and transcript save.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
}
