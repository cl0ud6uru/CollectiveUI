import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const base = process.env.REACTION_PREVIEW_URL ?? 'http://127.0.0.1:4317';
const out = process.env.REACTION_PREVIEW_OUTPUT;
if(out)await mkdir(out,{recursive:true});
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
const page = await browser.newPage({viewport:{width:1260,height:1000}});
const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
await page.route('**/*',route=>new URL(route.request().url()).origin === base ? route.continue():route.abort());
try {
  await page.goto(base);await page.waitForFunction(()=>window.reactionPreview?.metrics()?.supportedBones.includes('head'));
  expect(await page.locator('#preset option').count()).toBe(60);
  const play=id=>page.evaluate(id=>window.reactionPreview.play(id),id);
  const snapshot=()=>page.evaluate(()=>window.reactionPreview.metrics());
  await play('warm:small_nod');await expect.poll(async()=> (await snapshot()).headDegrees[0]).toBeGreaterThan(7);
  if(out)await page.screenshot({path:path.join(out,'desktop-warm-nod.png')});
  const running=await snapshot(); await expect.poll(async()=> (await snapshot()).completed,{timeout:10000}).toBeGreaterThan(running.completed);
  await play('warm:small_nod');await expect.poll(async()=> (await snapshot()).starts).toBeGreaterThan(running.starts);
  await play('curious:tilt_left');await expect.poll(async()=> (await snapshot()).headDegrees[2]).toBeGreaterThan(6);
  if(out)await page.screenshot({path:path.join(out,'desktop-curious-tilt.png')});
  await play('sympathetic:lean_in');await expect.poll(async()=> (await snapshot()).bodyDegrees[0]).toBeGreaterThan(3);
  if(out)await page.screenshot({path:path.join(out,'desktop-sympathetic-lean.png')});
  // Rapid cancellation, every named preset and repeated replay without a microphone/provider.
  const ids=await page.locator('#preset option').evaluateAll(options=>options.map(o=>o.value));
  for(const id of ids){await play(id);await page.waitForTimeout(40);}
  await page.getByRole('button',{name:'Replay',exact:true}).click();
  await page.getByRole('checkbox',{name:'Reduce motion (system preference also applies)'}).check();
  await play('sympathetic:double_nod');await expect.poll(async()=> (await snapshot()).reduced).toBe(true);
  expect((await snapshot()).headDegrees).toEqual([0,0,0]);
  await page.getByRole('checkbox',{name:'Reduce motion (system preference also applies)'}).uncheck();
  await page.emulateMedia({reducedMotion:'reduce'});await play('warm:small_nod');await expect.poll(async()=> (await snapshot()).reduced).toBe(true);
  expect((await snapshot()).headDegrees).toEqual([0,0,0]);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:390,height:844});await play('sympathetic:tilt_right');await expect.poll(async()=> (await snapshot()).headDegrees[2]).toBeLessThan(-5);
  if(out)await page.screenshot({path:path.join(out,'mobile-sympathetic-tilt.png')});
  await page.getByRole('button',{name:'Stop',exact:true}).click();await expect.poll(async()=> (await snapshot()).active).toBe(false);
  expect((await snapshot()).headDegrees).toEqual([0,0,0]);
  expect(errors).toEqual([]);expect(requests.some(url=>url.includes('/api/')||url.includes('openai'))).toBe(false);
  const report={presets:ids.length,requests:requests.map(url=>new URL(url).pathname),errors,final:await snapshot()};
  if(out)await writeFile(path.join(out,'browser-validation.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}finally{await browser.close();}
