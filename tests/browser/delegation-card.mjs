import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'delegation-card-browser-'));
let browser, server;

try {
  const entry = path.join(dir, 'entry.tsx');
  await writeFile(entry, `
    import React from 'react';
    import { createRoot } from '${root}/node_modules/react-dom/client';
    import { ToolPartView } from '${root}/src/components/chat/tool-part';
    import { PetProvider } from '${root}/src/components/pets/pet-context';
    import { DEFAULT_PET } from '${root}/src/lib/pets/shared';
    const params = new URLSearchParams(location.search);
    const motion = params.get('motion') || 'auto';
    const base = { taskId: 'task-1', conversationId: 'conv /1', bot: 'Gemma 4', botId: 'bot-gemma', avatar: 'blob:circle:teal', label: 'Mac Mini', status: 'done', steps: [{ tool: 'web_search', status: 'done' }], answer: '**Done.** A clear handoff.' };
    const output = params.has('sanitized') ? { status: 'error', error: 'The assignment is no longer authorized to return a result.' } : base;
    const pets = { 'bot-gemma': { ...DEFAULT_PET, enabled: true, motion } };
    createRoot(document.getElementById('root')).render(<PetProvider initialPets={pets}>
      <main className="mx-auto w-full max-w-3xl px-4 py-6">
        <ToolPartView part={{ type: 'tool-ask_gemma', toolCallId: 'call-1', state: 'output-available', input: { task: 'Review this.' }, output }} live={false} onApprove={() => {}} onDeny={() => {}} />
      </main>
    </PetProvider>);
  `);
  const bundle = await build({
    entryPoints: [entry], outfile: path.join(dir, 'bundle.js'), bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')],
    alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'fixture', setup(build) {
      build.onResolve({ filter: /workspace-actions$/ }, () => ({ path: 'actions', namespace: 'fixture' }));
      build.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
        contents: args.path === 'link' ? `import React from 'react';export default function Link(props){return <a {...props}/>} ` : `export async function stopWorkspaceCommand(){return {ok:true}}`,
        loader: 'jsx', resolveDir: root,
      }));
    } }],
  });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js'));
  const petCss = bundle.outputFiles.find(file => file.path.endsWith('.css'));
  const css = await postcss([tailwind({ base: root })]).process(
    (await readFile(path.join(root, 'src/app/globals.css'), 'utf8')) + `\n@source "${entry}";\n`,
    { from: path.join(root, 'src/app/globals.css') },
  );
  server = createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js.contents); }
    else if (req.url === '/bundle.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css + (petCss?.text ?? '')); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Synthetic component fixtures must never contact production endpoints or load remote assets.
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/?sanitized=1`);
    await expect(page.getByText('The assignment is no longer authorized to return a result.', { exact: true })).toBeVisible();
    await expect(page.getByText('Delegated task', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open task', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Delegated task', { exact: true })).toBeVisible();

    await page.goto(`${origin}/?motion=still`);
    await expect(page.locator('[data-pet-art]')).toHaveAttribute('data-still', 'true');
    const avatar = page.locator('[data-bot-avatar]');
    expect(await avatar.evaluate(el => getComputedStyle(el.parentElement).animationName)).toBe('none');
    const before = await avatar.boundingBox();
    await page.waitForTimeout(250);
    const after = await avatar.boundingBox();
    expect(after.y).toBe(before.y);
    await expect(page.getByRole('link', { name: 'Open task', exact: true })).toHaveAttribute('href', '/c/conv%20%2F1');
    const steps = page.getByRole('button', { name: '1 step', exact: true });
    await steps.focus(); await page.keyboard.press('Enter');
    await expect(steps).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Searched the web', { exact: true })).toBeVisible();
    await page.keyboard.press('Space'); await expect(steps).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.goto(`${origin}/?motion=auto`);
    await expect(page.locator('.delegate-bob')).toBeVisible();
    expect(await page.locator('.delegate-bob').evaluate(el => getComputedStyle(el).animationName)).toBe('delegate-bob');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.locator('.delegate-bob').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    expect(errors).toEqual([]);
    await page.close();
  }
  console.log('Delegation card sanitized errors, motion preferences, keyboard steps and task links passed at desktop and mobile widths.');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
