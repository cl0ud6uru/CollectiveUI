// Real studio component + optional real GLB; every microphone/peer/provider call is a synthetic fixture.
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.REACTION_STUDIO_OUTPUT;
const model = process.env.REACTION_MODEL_PATH ? await readFile(process.env.REACTION_MODEL_PATH) : null;
if (output) await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import {VoiceReactionStudio} from '@/components/chat/voice-reaction-studio'; createRoot(document.getElementById('root')).render(<VoiceReactionStudio initialModelUrl={${model ? JSON.stringify('/avatars/fixture.glb') : 'null'}} conversationId={location.search.includes('manual') ? undefined : 'chat00000001'}/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: path.join(root, '.reaction-studio-test-build'), format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"production"' } });
const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'));
if (!javascript) throw new Error('Studio JavaScript bundle was not generated.');
const css = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(javascript.contents); }
  else if (req.url === '/avatars/fixture.glb' && model) { res.setHeader('Content-Type', 'model/gltf-binary'); res.end(model); }
  else if (req.url?.startsWith('/api/')) { res.writeHead(500); res.end('Unmocked API call'); }
  else { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><style>${css}</style><div style="color:white;background:#7a3400;padding:8px">MOCK VALIDATION ONLY · microphone and provider replaced</div><div id="root"></div><script src="/bundle.js"></script></body></html>`); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const requests = [], errors = [], api = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  page.on('request', req => requests.push(req.url())); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixture = { mediaCalls: 0, stops: 0, peers: [] };
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => { window.fixture.mediaCalls++; return { getTracks: () => [{ stop: () => window.fixture.stops++ }] }; } } });
    class Channel extends EventTarget {
      readyState = 'open'; commands = [];
      emit(event) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })); }
      send(raw) { const event = JSON.parse(raw); this.commands.push(event); if (event.type === 'session.close') this.emit({ type: 'session.closed' }); }
      close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
    }
    window.RTCPeerConnection = class extends EventTarget {
      iceGatheringState = 'complete'; connectionState = 'connected'; localDescription = { sdp: 'synthetic-offer' }; channel = new Channel(); closed = false;
      constructor() { super(); window.fixture.peers.push(this); }
      createDataChannel() { return this.channel; } addTrack() {}
      async createOffer() { return { type: 'offer', sdp: 'synthetic-offer' }; } async setLocalDescription() {}
      async setRemoteDescription() { this.channel.emit({ type: 'session.started' }); }
      close() { this.closed = true; this.connectionState = 'closed'; }
    };
  });
  let outcome = 'accepted';
  await page.route('**/api/**', async route => {
    const req = route.request(), body = req.postDataJSON(); api.push({ path: new URL(req.url()).pathname, method: req.method(), body });
    if (new URL(req.url()).pathname === '/api/voice/session') {
      await route.fulfill({ json: req.method() === 'GET' ? { supported: true } : { session: { id: 'synthetic-session' }, transport: { sdp: 'synthetic-answer' }, reactions: true } }); return;
    }
    expect(new URL(req.url()).pathname).toBe('/api/voice/reaction'); expect(body.inspection).toBe(true);
    const inspection = { status: outcome === 'timeout' ? 'timeout' : 'ok', latencyMs: 17, answers: outcome === 'timeout' ? [] : [
      { name: 'face', choice: 'sympathetic', confidence: outcome === 'confidence' ? .4 : .91 }, { name: 'motion', choice: 'slow_nod', confidence: outcome === 'confidence' ? .4 : .89 },
    ] };
    await route.fulfill({ json: { revision: body.revision, reaction: outcome === 'accepted' ? 'concerned' : 'keep_current', confidence: outcome === 'accepted' ? .89 : null,
      ...(outcome === 'accepted' ? { plan: { face: 'sympathetic', gesture: 'slow_nod', intensity: .85, tempo: .8, durationMs: 2800 }, replay: true } : {}), decision: inspection } });
  });
  await page.goto(base);
  const metrics = () => page.evaluate(() => window.reactionPreview?.metrics());
  await expect.poll(metrics).toBeTruthy();
  if (model) await expect.poll(async () => (await metrics())?.supportedMorphs.includes('mouthSmile'), { timeout: 15000 }).toBe(true);
  await expect(page.getByText('Avatar model unavailable. Using the placeholder.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Manual preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => window.fixture.mediaCalls)).toBe(0); expect(api).toHaveLength(0);
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.getByText('● Microphone active · real provider')).toBeVisible();
  await expect(page.getByText('Live microphone · Decisions', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.mediaCalls)).toBe(1);
  await page.evaluate(() => {
    const channel = window.fixture.peers[0].channel;
    channel.emit({ type: 'session.input_transcript.delta', event_id: 'u1', delta: 'Synthetic story: I lost my friend.', start_ms: 0, end_ms: 500 });
    channel.emit({ type: 'session.output_transcript.delta', event_id: 'a1', delta: 'IGNORED_OUTPUT', start_ms: 500, end_ms: 600 });
    channel.emit({ type: 'session.delegation.created', delegation: { target: 'client', id: 'd1' }, offset_ms: 600 });
  });
  await expect(page.getByLabel('Recognized transcript')).toHaveText('Synthetic story: I lost my friend.');
  await expect(page.getByText('accepted', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Decision choices')).toContainText('sympathetic · confidence 91%');
  await expect.poll(async () => (await metrics())?.face).toBe('sympathetic');
  await expect(page.getByLabel('Rendered reaction')).toContainText('sympathetic / slow_nod');
  expect(await page.getByRole('button', { name: 'Replay', exact: true, includeHidden: true }).isDisabled()).toBe(true);
  if (output) {
    await page.locator('.reaction-studio-shell').evaluate(el => { el.style.height = 'auto'; el.style.overflow = 'visible'; });
    await page.screenshot({ path: path.join(output, 'live-mocked-desktop.png'), fullPage: true });
    await page.locator('.reaction-studio-shell').evaluate(el => el.removeAttribute('style'));
  }
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  await expect(page.getByLabel('Recognized transcript')).toHaveText('No transcript yet.');
  await expect.poll(() => page.evaluate(() => window.fixture.peers[0].closed)).toBe(true);
  expect(await page.evaluate(() => window.fixture.stops)).toBe(1);
  await page.evaluate(() => window.fixture.peers[0].channel.emit({ type: 'session.input_transcript.delta', event_id: 'late', delta: 'LATE', start_ms: 600, end_ms: 900 }));
  await expect(page.getByLabel('Recognized transcript')).toHaveText('No transcript yet.');
  outcome = 'confidence';
  await page.getByLabel('Typed text fallback (real Decisions when signed in)').fill('Synthetic uncertain story');
  await page.getByRole('button', { name: 'Test text with Decisions', exact: true }).click();
  await expect(page.getByText('confidence', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.mediaCalls)).toBe(1);
  outcome = 'timeout';
  await page.getByRole('button', { name: 'Test text with Decisions', exact: true }).click();
  await expect(page.getByText('timeout', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  outcome = 'accepted';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Typed text fallback (real Decisions when signed in)').fill('Synthetic mobile story');
  await page.getByRole('button', { name: 'Test text with Decisions', exact: true }).click();
  await expect(page.getByText('accepted', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Reduce motion (system preference also applies)' }).check();
  await expect.poll(async () => (await metrics())?.reduced).toBe(true);
  expect((await metrics()).headDegrees).toEqual([0, 0, 0]);
  if (output) {
    await page.locator('.reaction-studio-shell').evaluate(el => { el.style.height = 'auto'; el.style.overflow = 'visible'; });
    await page.screenshot({ path: path.join(output, 'typed-mocked-mobile.png'), fullPage: true });
    await page.locator('.reaction-studio-shell').evaluate(el => el.removeAttribute('style'));
  }
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByLabel('Recognized transcript')).toHaveText('No transcript yet.');
  await expect(page.getByLabel('Typed text fallback (real Decisions when signed in)')).toHaveValue('');
  await page.goto(`${base}/?manual`);
  await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Test text with Decisions', exact: true })).toBeDisabled();
  await expect(page.getByText('This localhost renderer has no signed-in app session.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeEnabled();
  expect(errors).toEqual([]); expect(requests.every(url => new URL(url).origin === base)).toBe(true);
  expect(api.every(req => ['/api/voice/session', '/api/voice/reaction'].includes(req.path))).toBe(true);
  expect(api.find(req => req.method === 'POST' && req.path === '/api/voice/session').body.reactionTest).toBe(true);
  const report = { passed: true, realModel: !!model, mockedMicrophone: true, mockedProvider: true, requests: api.map(req => ({ path: req.path, method: req.method })), errors, scenarios: ['default off', 'streamed heard text', 'fixed choices and confidence', 'rendered reaction', 'Stop cleanup and late frames', 'confidence drop', 'provider timeout', 'typed fallback', 'mobile', 'Reduce Motion', 'pagehide clears text', 'manual standalone disabled live'] };
  if (output) await writeFile(path.join(output, 'browser-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
