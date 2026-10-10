import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Production sidebar and controls, with synthetic server actions/accounts and no inference.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const sharp = require('sharp');
const dir = await mkdtemp(path.join(tmpdir(), 'bot-sidebar-portrait-'));
const shots = process.env.BOT_PORTRAIT_SCREENSHOTS;
const baseline = process.env.BOT_PORTRAIT_BASELINE === '1';
let browser, server;

try {
  if (shots) await mkdir(shots, { recursive: true });
  const entry = path.join(dir, 'entry.tsx');
  await writeFile(entry, `
    import React, { useState } from 'react';
    import { createRoot } from '${root}/node_modules/react-dom/client';
    import { Tooltip } from 'radix-ui';
    import { BotSidePanel } from '${root}/src/components/bots/bot-side-panel';
    import { PetProvider, usePets } from '${root}/src/components/pets/pet-context';
    import { DEFAULT_PET } from '${root}/src/lib/pets/shared';
    const params = new URLSearchParams(location.search);
    const catalogId = 'builtin-hermes-assimilated-v2';
    const pet = { ...DEFAULT_PET, enabled: true, appearance: 'catalog', source: 'default', motion: 'still', revision: 'synthetic', spriteUrl: '/synthetic-sprite.webp', custom: { displayName: 'Hermes Assimilated', description: '', spriteVersionNumber: 2, credit: '' }, botDefault: { appearance: 'catalog', catalogId } };
    window.fixturePet = pet;
    const count = params.has('busy') ? 16 : 2;
    const activity = Array.from({length: count}, (_, i) => ({ id: 'activity-'+i, title: i === 0 ? 'Review the sample release notes' : 'Prepare the synthetic project summary', conversationId: 'sample-'+i, status: params.has('busy') ? 'running' : i === 0 ? 'failed' : 'succeeded', kind: 'delegation', unread: false }));
    const routines = params.has('busy') ? Array.from({length: 8}, (_, i) => ({id:'routine-'+i, name:'Sample routine '+(i+1), prompt:'Summarize the sample', triggerType:'cron', cron:'0 9 * * *', timezone:'UTC', enabled:true, notifyEmail:false, webhookSecret:null, nextRunAt:null, lastRunAt:null})) : [];
    window.fixtureData = { canEdit: true, state: { working:params.has('busy'), awaitingApproval:false }, activity, outputs: [], routines, runs:[], serviceMode:false, localEngine:false, personalHermes:false, workspace:null };
    function Surface() {
      const { updatePet } = usePets();
      const [botId, setBotId] = useState('synthetic-hermes');
      window.fixtureSetPet = value => updatePet('synthetic-hermes', value);
      window.fixtureSwitchBot = setBotId;
      const bot = {id:botId, kind:'bot', name:botId === 'synthetic-hermes' ? 'Hermes' : 'Research Assistant', icon:'blob:circle:teal', description:'Synthetic assistant for this preview', label:'Hermes'};
      const mobile = params.has('narrow');
      return <div className="flex h-dvh bg-bg text-fg">
        {!mobile && <><nav aria-label="Synthetic navigation" className="w-[240px] shrink-0 bg-sidebar p-5"><strong>CollectiveUI</strong><p className="mt-8 text-sm">Hermes</p><p className="mt-4 text-xs text-muted">Synthetic preview</p></nav><main className="flex min-w-0 flex-1 flex-col p-8"><h1 className="text-center font-medium">Hermes</h1><p className="mt-auto mb-8 rounded-2xl bg-surface-2 p-4 text-sm text-muted">Sample conversation — no account or private chat data</p></main></>}
        <BotSidePanel bot={bot} panelId="sample-panel" mobile={mobile} onClose={()=>{window.fixtureClosed=true}} />
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Tooltip.Provider><PetProvider initialPets={{'synthetic-hermes':pet}}><Surface/></PetProvider></Tooltip.Provider>);
  `);
  const noAction = `async()=>{throw new Error('Unexpected synthetic mutation')}`;
  const names = ['duplicateBot','createBotTemplate','getBotTemplate','revokeBotTemplate','updateBotTemplate','deleteRoutine','runRoutineNow','saveRoutine'];
  const stubs = {
    'next/link': `import React from 'react';export default function Link({prefetch,children,...props}){return <a {...props}>{children}</a>}`,
    'next/navigation': `export const useRouter=()=>({push:()=>{},refresh:()=>{}});`,
    '@/app/(chat)/bots/actions': `export const getBotPanelData=async()=>window.fixtureData;` + names.map(name=>`export const ${name}=${noAction};`).join(''),
  };
  const bundle = await build({ entryPoints:[entry], outfile:path.join(dir,'bundle.js'), write:false, bundle:true, platform:'browser', format:'iife', jsx:'automatic', define:{'process.env':'{}','process.env.NODE_ENV':'"production"'}, nodePaths:[path.join(root,'node_modules')], alias:{'@':path.join(root,'src')}, plugins:[{name:'synthetic-server-boundaries',setup(build){
    build.onResolve({filter:/.*/},args=>stubs[args.path]?{path:args.path,namespace:'fixture'}:undefined);
    build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'tsx',resolveDir:root}));
  }}] });
  const css = await postcss([tailwind({base:root})]).process((await readFile(path.join(root,'src/app/globals.css'),'utf8')) + `\n@source "${entry}";\n`, {from:path.join(root,'src/app/globals.css')});
  server = createServer(async (req,res) => {
    const url = new URL(req.url,'http://localhost');
    if(url.pathname === '/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles.find(file=>file.path.endsWith('.js')).contents);return;}
    if(url.pathname === '/style.css'){res.setHeader('Content-Type','text/css');res.end(css.css + (bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text ?? ''));return;}
    if(url.pathname === '/synthetic-sprite.webp'){res.setHeader('Content-Type','image/webp');res.end(await readFile(path.join(root,'assets/pets/hermes-assimilated/v2/spritesheet.webp')));return;}
    if(url.pathname === '/portraits/hermes-assimilated.png'){res.setHeader('Content-Type','image/png');res.end(await readFile(path.join(root,'public/portraits/hermes-assimilated.png')));return;}
    if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(url.pathname === '/api/pets/catalog' ? '[]' : JSON.stringify({error:'Not available in synthetic preview'}));return;}
    res.setHeader('Content-Type','text/html');res.end('<html lang="en" class="'+(url.searchParams.get('theme') === 'light' ? '' : 'dark')+'"><head><title>CollectiveUI synthetic portrait preview</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  const page = await browser.newPage({viewport:{width:1280,height:1000},reducedMotion:'reduce'});
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on('pageerror',error=>{errors.push(error.message);console.error('Browser error:',error.message);});
  await page.route('**/*',route=>new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const panel = page.getByRole('complementary',{name:'Hermes activity and outputs'});
  const portrait = () => page.locator('[data-bot-portrait] img');
  const capture = async name => {if(shots) await page.screenshot({path:path.join(shots,name+'.png')});};
  const ready = async query => {await page.goto(base+query);await expect(page.getByRole('button',{name:'Duplicate',exact:true})).toBeVisible();};
  if (baseline) {
    for(const theme of ['dark','light']){await ready('/?theme='+theme);await capture('before-'+theme);}
    console.log('PASS: before screenshots captured from unchanged production sidebar with synthetic data.');
  } else {
    for(const theme of ['dark','light']) {
      await ready('/?theme='+theme);
      await portrait().scrollIntoViewIfNeeded();
      await expect.poll(()=>portrait().evaluate(img=>img.complete && img.naturalWidth)).toBe(1024);
      expect(await portrait().evaluate(img=>({height:img.naturalHeight,fit:getComputedStyle(img).objectFit,alt:img.alt,animations:img.getAnimations().length}))).toEqual({height:1536,fit:'contain',alt:'',animations:0});
      const backing = await portrait().evaluate(img=>({
        sidebar:getComputedStyle(img.closest('aside')).backgroundColor,
        image:getComputedStyle(img).backgroundColor,
        wrapper:getComputedStyle(img.parentElement).backgroundColor,
      }));
      expect(backing.image).toBe('rgba(0, 0, 0, 0)');expect(backing.wrapper).toBe('rgba(0, 0, 0, 0)');
      // Inspect actual browser compositing, so hidden RGB under alpha cannot be mistaken for a visible rectangle.
      const background = backing.sidebar.match(/\d+/g).slice(0,3).map(Number);
      const {data,info} = await sharp(await portrait().screenshot()).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      for(const [x,y] of [[0,0],[info.width-1,0],[0,info.height-1],[info.width-1,info.height-1]]) {
        const pixel = [...data.subarray((y*info.width+x)*4,(y*info.width+x)*4+3)];
        expect(pixel.every((channel,index)=>Math.abs(channel-background[index])<=1)).toBe(true);
      }
      const imageBox = await portrait().boundingBox(), controls = await panel.getByRole('button',{name:'Duplicate',exact:true}).boundingBox();
      expect(imageBox.y).toBeGreaterThanOrEqual(controls.y+controls.height);
      await capture('after-'+theme);
    }
    // Existing keyboard controls remain usable above a decorative, unfocusable portrait.
    await ready('/');
    const newRoutine = page.getByRole('button',{name:'New routine',exact:true});
    await newRoutine.focus();await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
    const share = page.getByRole('button',{name:'Share template',exact:true});
    await share.focus();await page.keyboard.press('Enter');await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(share).toBeFocused();
    expect(await portrait().evaluate(img=>img.tabIndex)).toBe(-1);
    const aria = await panel.ariaSnapshot();expect(aria).not.toContain('img');
    for(const [width,height,query,name] of [[1280,480,'/?busy=1','short-busy'],[240,480,'/?narrow=1','narrow'],[320,600,'/?narrow=1&theme=light','narrow-light']]) {
      await page.setViewportSize({width,height});await ready(query);
      await expect(page.getByRole('button',{name:'Hide bot details',exact:true})).toBeInViewport();
      await share.scrollIntoViewIfNeeded();await expect(share).toBeInViewport();
      await portrait().scrollIntoViewIfNeeded();await expect(portrait()).toBeInViewport();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect(await panel.evaluate(el=>Array.from(el.querySelectorAll('*')).filter(child=>child.classList.contains('overflow-y-auto')).every(child=>child.scrollWidth<=child.clientWidth))).toBe(true);
      const box=await portrait().boundingBox();expect(box.height).toBeLessThanOrEqual(height);expect(box.width).toBeLessThanOrEqual(width);
      await capture(name);
    }
    await page.setViewportSize({width:1280,height:1000});await ready('/');
    // Changes in viewer choices and selected bots must never leave Hermes on an unrelated identity.
    await page.evaluate(()=>window.fixtureSwitchBot('synthetic-research'));await expect(portrait()).toHaveCount(0);
    await page.evaluate(()=>window.fixtureSwitchBot('synthetic-hermes'));await expect(portrait()).toHaveCount(1);
    for(const patch of [{enabled:false},{appearance:'custom'},{source:'default',botDefault:{appearance:'catalog',catalogId:'builtin-nimbus-v2'}},{source:'personal',preference:{mode:'personal',appearance:'catalog',catalogId:'builtin-nimbus-v2',motion:'still'}}]) {
      await page.evaluate(patch=>window.fixtureSetPet({...window.fixturePet,...patch}),patch);await expect(portrait()).toHaveCount(0);
    }
    await page.evaluate(()=>window.fixtureSetPet({...window.fixturePet,source:'personal',preference:{mode:'personal',appearance:'catalog',catalogId:'builtin-hermes-assimilated-v2',motion:'still'}}));await expect(portrait()).toHaveCount(1);
    await page.route('**/portraits/hermes-assimilated.png',route=>route.abort());await ready('/');
    await expect(page.locator('[data-bot-portrait]')).toHaveCount(0);await expect(share).toBeVisible();
    await page.getByRole('button',{name:'Hide bot details',exact:true}).click();expect(await page.evaluate(()=>window.fixtureClosed)).toBe(true);
    console.log('PASS: supplied cutout, transparent browser compositing, containment, placement, light/dark, keyboard controls, decorative accessibility, reduced motion, short busy scrolling, 240/320px layouts, bot isolation, personal/default choices and missing-image fallback.');
  }
  expect(errors).toEqual([]);
} finally {
  await browser?.close();if(server) await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});
}
