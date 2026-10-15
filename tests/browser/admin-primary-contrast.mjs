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
const directory = await mkdtemp(path.join(tmpdir(), 'admin-primary-contrast-'));
const entry = path.join(directory, 'entry.tsx');
await writeFile(entry, `import React from 'react';
import {createRoot} from '${root}/node_modules/react-dom/client';
import {OfficeBotInstaller} from '${root}/src/components/admin/office-bot-installer';
import {WorkspaceTemplateCatalog} from '${root}/src/components/admin/workspace-template-catalog';
const profile={key:'knowledge-work-v1',label:'Knowledge Work',templateSlug:'knowledge-work',templateName:'Knowledge Work',description:'Synthetic fixture',seedBundleKey:'knowledge-work-v1',seedBundleKeys:['knowledge-work-v1'],capabilities:{shell:true,officeHeadless:true,dotnet:false,agentBrowserView:false}};
const models=new URL(location.href).searchParams.has('noModels')?[]:[{id:'fixture-model',name:'Synthetic model'}];
createRoot(document.getElementById('root')!).render(<><OfficeBotInstaller models={models} botId={null}/><WorkspaceTemplateCatalog profiles={[profile]} templates={[]}/></>);`);
const actions = `window.fixtureCalls={office:0,template:0};
export function addOfficeBot(){window.fixtureCalls.office++;return new Promise(resolve=>{window.releaseOffice=()=>resolve({ok:false,error:'Synthetic fixture refusal.'});});}
export function createWorkspaceTemplateDraft(){window.fixtureCalls.template++;return new Promise(resolve=>{window.releaseTemplate=()=>resolve({ok:false,error:'Synthetic fixture refusal.'});});}
export async function createWorkspaceTemplateVersion(){return {ok:false,error:'Synthetic fixture refusal.'};}
export async function publishWorkspaceTemplateVersion(){return {ok:false,error:'Synthetic fixture refusal.'};}
export async function retireWorkspaceTemplateVersion(){return {ok:false,error:'Synthetic fixture refusal.'};}`;
const actionsPath = path.join(directory, 'actions.ts');
await writeFile(actionsPath, actions);
const bundle = await build({
  entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(root, 'node_modules')],
  alias: { '@': path.join(root, 'src'), '@/app/admin/bots/office-actions': actionsPath, '@/app/admin/workspace-templates/actions': actionsPath },
  plugins: [{ name: 'fixture-navigation', setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function useRouter(){return {push(){},refresh(){}}}', loader: 'js' }));
  } }],
});
const stylesheet = path.join(root, 'src/app/globals.css');
const css = await postcss([tailwind({ base: root })]).process(await readFile(stylesheet, 'utf8'), { from: stylesheet });
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].contents); return; }
  if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css.css); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end('<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}};</script><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Sample computed production CSS, including opacity compositing against the actual parent.
  const sample = button => button.evaluate(async element => {
    getComputedStyle(element).backgroundColor;
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)));
    const style = getComputedStyle(element);
    const channels = color => color.match(/[\d.]+/g).map(Number);
    const composite = (front, back, opacity) => front.slice(0, 3).map((value, index) => value * opacity + back[index] * (1 - opacity));
    const luminance = color => color.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    let backdrop = [255, 255, 255];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const background = channels(getComputedStyle(parent).backgroundColor);
      if ((background[3] ?? 1) === 1) { backdrop = background.slice(0, 3); break; }
    }
    const opacity = Number(style.opacity);
    const foreground = composite(channels(style.color), backdrop, opacity);
    const background = composite(channels(style.backgroundColor), backdrop, opacity);
    const a = luminance(foreground), b = luminance(background);
    return { opacity, background: style.backgroundColor, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
  });
  for (const theme of ['light', 'dark']) {
    await page.goto(base);
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    const office = page.getByRole('button', { name: 'Add Office Bot', exact: true });
    const starter = page.getByRole('button', { name: 'Create Knowledge Work draft', exact: true });
    for (const button of [office, starter]) {
      await expect(button).toBeEnabled();
      await expect.poll(async () => (await sample(button)).contrast).toBeGreaterThanOrEqual(4.5);
      await button.hover();
      await expect.poll(async () => (await sample(button)).contrast).toBeGreaterThanOrEqual(4.5);
      await button.focus();
      await expect.poll(async () => (await sample(button)).contrast).toBeGreaterThanOrEqual(4.5);
    }
    const enabledBackground = (await sample(office)).background;
    await office.click();
    const officePending = page.getByRole('button', { name: 'Checking workspace…', exact: true });
    await expect(officePending).toBeDisabled();
    await expect.poll(async () => (await sample(officePending)).opacity).toBe(1);
    const officePaint = await sample(officePending);
    expect(officePaint.contrast).toBeGreaterThanOrEqual(4.5);
    expect(officePaint.background).not.toBe(enabledBackground);
    await officePending.evaluate(element => element.click());
    expect(await page.evaluate(() => window.fixtureCalls.office)).toBe(1);
    await page.evaluate(() => window.releaseOffice());
    await expect(office).toBeEnabled();
    const starterForm = page.locator('form').filter({ has: page.locator('input[name="slug"][value="knowledge-work"]') });
    await starter.click();
    const templatePending = starterForm.getByRole('button', { name: 'Saving…', exact: true });
    await expect(templatePending).toBeDisabled();
    await expect.poll(async () => (await sample(templatePending)).opacity).toBe(1);
    const templatePaint = await sample(templatePending);
    expect(templatePaint.contrast).toBeGreaterThanOrEqual(4.5);
    await templatePending.evaluate(element => element.click());
    expect(await page.evaluate(() => window.fixtureCalls.template)).toBe(1);
    await page.evaluate(() => window.releaseTemplate());
    await expect(starter).toBeEnabled();
    await page.goto(`${base}/?noModels=1`);
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    const unavailable = page.getByRole('button', { name: 'Add Office Bot', exact: true });
    await expect(unavailable).toBeDisabled();
    const unavailablePaint = await sample(unavailable);
    expect(unavailablePaint.opacity).toBe(1);
    expect(unavailablePaint.contrast).toBeGreaterThanOrEqual(4.5);
    await unavailable.evaluate(element => element.click());
    expect(await page.evaluate(() => window.fixtureCalls.office)).toBe(0);
    console.log(`${theme}: pending Office ${officePaint.contrast.toFixed(2)}:1; starter ${templatePaint.contrast.toFixed(2)}:1; no-model Office ${unavailablePaint.contrast.toFixed(2)}:1.`);
  }
  expect(errors).toEqual([]);
  console.log('PASS: real target components and production CSS preserve readable enabled/hover/focus, pending and unavailable labels with disabled single-submit behavior.');
} finally { await browser.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
