// Production Composer with synthetic loopback uploads. No providers, accounts or application server.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.COLLECTIVE_UI_SOURCE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({
  absWorkingDir: root,
  stdin: { contents: `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {Tooltip} from 'radix-ui';
import {Composer} from '@/components/chat/composer';
function Fixture(){const [visible,setVisible]=useState(true);window.unmountComposer=()=>setVisible(false);
return <Tooltip.Provider>{visible&&<Composer busy={false} onStop={()=>{}} onSend={()=>true}/>}</Tooltip.Provider>;}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
`, loader: 'tsx', resolveDir: root },
  write: false, outfile: '/tmp/composer-preview-lifecycle.js', bundle: true, jsx: 'automatic',
  define: { 'process.env': '{}', 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'synthetic-actions', setup(builder) {
    builder.onResolve({ filter: /^@\/app\/.*actions$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, async args => {
      const source = await readFile(path.join(root, 'src', args.path.slice(2) + '.ts'), 'utf8');
      return { contents: [...source.matchAll(/export (?:async )?function (\w+)/g)].map(match =>
        `export const ${match[1]}=async()=>{throw Error('No server actions in preview fixture')};`).join('\n'), loader: 'js' };
    });
  } }],
});
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/app.js' ? bundle.outputFiles.find(file => file.path.endsWith('.js')).contents
    : '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const image = name => ({ name, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC2kAAAAASUVORK5CYII=', 'base64') });
const failures = [];
let passed = 0;
async function check(name, run) {
  const page = await browser.newPage(), uploads = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.createdPreviews = []; window.revokedPreviews = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.createdPreviews.push(url); return url; };
    URL.revokeObjectURL = url => { window.revokedPreviews.push(url); revoke(url); };
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/files') { uploads.push(route); return; }
    return route.continue();
  });
  const previews = () => page.evaluate(() => ({ created: window.createdPreviews.length, revoked: window.revokedPreviews.length,
    unreleased: window.createdPreviews.filter(url => !window.revokedPreviews.includes(url)).length }));
  const upload = async (count = 1) => {
    await page.locator('input[type=file]').setInputFiles(Array.from({ length: count }, (_, i) => image(`fixture-${i}.png`)));
    await expect.poll(() => uploads.length).toBe(1);
  };
  const complete = async (index = 0, status = 200) => {
    await uploads[index].fulfill({ status, json: status === 200
      ? { id: `fixture-${index}`, url: `/api/files/fixture-${index}`, filename: `fixture-${index}.png`, mediaType: 'image/png' }
      : { error: 'Synthetic upload refusal' } });
  };
  try {
    await page.goto(origin); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await run({ page, uploads, upload, complete, previews });
    assert.deepEqual(errors, []); passed++; console.log('PASS ' + name);
  } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message); }
  finally { await page.close(); }
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  await check('removed preview is revoked', async ({ page, upload, complete, previews }) => {
    await upload(); await complete(); await page.getByRole('button', { name: 'Remove fixture-0.png' }).click();
    await expect.poll(previews).toEqual({ created: 1, revoked: 1, unreleased: 0 });
  });
  await check('accepted send releases its preview', async ({ page, upload, complete, previews }) => {
    await upload(); await complete(); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(previews).toEqual({ created: 1, revoked: 1, unreleased: 0 });
  });
  await check('failed upload releases its preview', async ({ upload, complete, previews }) => {
    await upload(); await complete(0, 400);
    await expect.poll(previews).toEqual({ created: 1, revoked: 1, unreleased: 0 });
  });
  for (const fail of [false, true]) await check(`unmount stops remaining batch uploads after ${fail ? 'failure' : 'success'}`, async ({ page, uploads, upload, complete, previews }) => {
    await upload(2); await page.evaluate(() => window.unmountComposer());
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
    await complete(0, fail ? 400 : 200);
    // Run through queued React/browser tasks after the held fetch settles.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(uploads.length, 1); assert.deepEqual(await previews(), { created: 1, revoked: 1, unreleased: 0 });
  });
  await check('mounted batch retains previews until send, then releases both', async ({ page, uploads, upload, complete, previews }) => {
    await upload(2); await complete(); await expect.poll(() => uploads.length).toBe(2); await complete(1);
    assert.deepEqual(await previews(), { created: 2, revoked: 0, unreleased: 2 });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(previews).toEqual({ created: 2, revoked: 2, unreleased: 0 });
  });
  console.log(JSON.stringify({ passed, failed: failures.length, failures })); process.exitCode = failures.length ? 1 : 0;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
