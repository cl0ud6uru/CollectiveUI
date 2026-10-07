import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
const screenshots = process.env.DELEGATION_CARD_SCREENSHOTS;
let browser, server;

try {
  const entry = path.join(dir, 'entry.tsx');
  await writeFile(entry, `
    import React, { useEffect, useState } from 'react';
    import { Tooltip } from '${root}/node_modules/radix-ui';
    import { createRoot } from '${root}/node_modules/react-dom/client';
    import { AssistantMessage } from '${root}/src/components/chat/message';
    import { DelegatedApprovals } from '${root}/src/components/chat/delegated-approvals';
    import { PetProvider } from '${root}/src/components/pets/pet-context';
    import { DEFAULT_PET } from '${root}/src/lib/pets/shared';
    const params = new URLSearchParams(location.search);
    const motion = params.get('motion') || 'auto';
    const status = params.get('state') || 'done';
    const base = { taskId: 'task-1', conversationId: 'conv /1', bot: params.has('long') ? 'Gemma 4 with a very long receiver name' : 'Gemma 4', botId: 'bot-gemma', avatar: 'blob:circle:teal', label: 'Mac Mini', status, steps: [{ tool: 'web_search', status: 'done' }], answer: '**Delegated reading:** 21°C. A clear handoff.', startedAt: '2026-10-06T12:00:00Z', finishedAt: '2026-10-06T12:00:25Z', ...(['error', 'cancelled', 'interrupted'].includes(status) ? { error: 'The task needs attention.' } : {}) };
    const initialOutput = params.has('sanitized') ? { status: 'error', error: 'The assignment is no longer authorized to return a result.' } : base;
    const pets = { 'bot-gemma': { ...DEFAULT_PET, enabled: true, motion } };
    function Fixture() {
      const [output, setOutput] = useState(initialOutput);
      useEffect(() => { window.updateDelegation = patch => setOutput(current => ({ ...current, ...patch })); }, []);
      const parts = [{ type: 'tool-ask_gemma', toolCallId: 'call-1', state: 'output-available', input: { task: 'Read the temperature.' }, output }];
      if (params.has('multiple')) parts.push({ type: 'tool-ask_nova', toolCallId: 'call-2', state: 'output-available', input: {}, output: { ...base, bot: 'Nova', botId: 'bot-nova', answer: 'Second receiver answer.' } });
      parts.push({ type: 'text', text: "Queen's answer: the room is 21°C." });
      return <Tooltip.Provider><PetProvider initialPets={pets}>
        <main className="mx-auto w-full max-w-3xl px-4 py-6">
          <AssistantMessage message={{ id: 'message-1', role: 'assistant', parts }} streaming={output.status === 'working'} isLast botName="Queen" variant="bubbles" avatar={{ botId: 'queen', value: 'blob:circle:pink' }} onApprove={() => {}} onDeny={() => {}} />
          <DelegatedApprovals conversationId={params.has('approval') ? 'with-approval' : 'no-approval'} />
        </main>
      </PetProvider></Tooltip.Provider>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
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
  let pendingApproval = true;
  const decisions = [];
  server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js.contents); }
    else if (req.url === '/bundle.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css + (petCss?.text ?? '')); }
    else if (req.url.endsWith('/approvals')) {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        decisions.push(JSON.parse(Buffer.concat(chunks).toString())); pendingApproval = false;
        res.end(JSON.stringify({ accepted: true }));
      } else {
        res.end(JSON.stringify({ requests: req.url.includes('with-approval') && pendingApproval ? [{ runId: 'run-1', taskId: 'task-1', conversationId: 'conv /1', messageId: 'message-1', botName: 'Gemma 4', assignerName: 'Queen', expiresAt: new Date(Date.now() + 60_000).toISOString(), part: { type: 'tool-workspace_bash', toolCallId: 'command-1', state: 'approval-requested', input: { command: 'printf fixture' }, approval: { id: 'approval-1' } } }] : [] }));
      }
    } else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  if (screenshots) await mkdir(screenshots, { recursive: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser fixture page error:', error.message); });
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
    const avatar = page.locator('[data-bot-avatar="bot-gemma"]');
    expect(await avatar.evaluate(el => getComputedStyle(el.parentElement).animationName)).toBe('none');
    const before = await avatar.boundingBox();
    await page.waitForTimeout(250);
    const after = await avatar.boundingBox();
    expect(after.y).toBe(before.y);
    await expect(page.getByRole('link', { name: 'Open task', exact: true })).toHaveAttribute('href', '/c/conv%20%2F1');
    const toggle = page.getByRole('button', { name: /^(Expand|Collapse) Gemma 4 response$/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const detailsId = await toggle.getAttribute('aria-controls');
    await expect(toggle).toHaveAttribute('aria-describedby', `${detailsId}-status`);
    await expect(page.locator(`[id="${detailsId}"]`)).toBeHidden();
    await expect(page.getByText('Delegated reading:', { exact: true })).toHaveCount(0);
    await expect(page.getByText("Queen's answer: the room is 21°C.", { exact: true })).toBeVisible();
    await expect(page.getByText('replied in 25s · Mac Mini', { exact: true })).toBeVisible();
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `${viewport.width}-collapsed.png`), fullPage: true });
    if (screenshots) {
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.screenshot({ path: path.join(screenshots, `${viewport.width}-collapsed-dark.png`), fullPage: true });
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    }
    await toggle.focus(); await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Delegated reading:', { exact: true })).toBeVisible();
    await page.evaluate(() => window.updateDelegation({ label: 'Updated host' }));
    await expect(page.getByText('replied in 25s · Updated host', { exact: true })).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const steps = page.getByRole('button', { name: '1 step', exact: true });
    await steps.focus(); await page.keyboard.press('Enter');
    await expect(steps).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Searched the web', { exact: true })).toBeVisible();
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `${viewport.width}-expanded.png`), fullPage: true });
    await page.keyboard.press('Space'); await expect(steps).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Collapse Gemma 4 response', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    for (const status of ['working', 'done']) {
      await page.evaluate(status => window.updateDelegation({ status }), status);
      await expect(page.locator('[data-delegation-card]')).toHaveAttribute('data-delegation-card', status);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(page.getByText('Delegated reading:', { exact: true })).toHaveCount(0);
    await expect(page.getByText("Queen's answer: the room is 21°C.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    for (const state of ['queued', 'working', 'error', 'cancelled', 'interrupted']) {
      await page.goto(`${origin}/?state=${state}`);
      await expect(page.getByRole('button', { name: 'Expand Gemma 4 response', exact: true })).toHaveAttribute('aria-expanded', 'false');
      if (state === 'queued') await expect(page.getByText('Scheduled independently. This reply will continue when the task returns.', { exact: true })).toBeVisible();
      if (state === 'working') await expect(page.getByText('Gemma 4 is working…', { exact: true })).toBeVisible();
      if (['error', 'cancelled', 'interrupted'].includes(state)) await expect(page.getByText('The task needs attention.', { exact: true })).toBeVisible();
    }
    pendingApproval = true;
    await page.goto(`${origin}/?approval=1&state=working`);
    await expect(page.getByRole('button', { name: 'Expand Gemma 4 response', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
    expect(decisions.at(-1)).toEqual({ runId: 'run-1', approvalId: 'approval-1', approved: false });

    await page.goto(`${origin}/?multiple=1&long=1`);
    await page.getByRole('button', { name: '2 steps', exact: true }).click();
    const toggles = page.getByRole('button', { name: /Expand .+ response/ });
    await expect(toggles).toHaveCount(2);
    const ids = await toggles.evaluateAll(elements => elements.map(el => el.getAttribute('aria-controls')));
    expect(new Set(ids).size).toBe(2);
    const first = page.getByRole('button', { name: /^(Expand|Collapse) Gemma 4 with a very long receiver name response$/ });
    const second = page.getByRole('button', { name: /^(Expand|Collapse) Nova response$/ });
    await first.click();
    await expect(page.getByText('Second receiver answer.', { exact: true })).toHaveCount(0);
    await second.click();
    await first.click();
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await expect(second).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Second receiver answer.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.goto(`${origin}/?motion=auto`);
    await expect(page.locator('.delegate-bob')).toBeVisible();
    expect(await page.locator('.delegate-bob').evaluate(el => getComputedStyle(el).animationName)).toBe('delegate-bob');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.locator('.delegate-bob').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    expect(errors).toEqual([]);
    await page.close();
  }
  console.log('Delegation card default collapse, coordinator answers, keyboard controls, streaming updates, visible errors/approvals, independent cards, motion and task links passed at desktop and mobile widths.');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
