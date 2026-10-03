import { chromium, expect } from '@playwright/test';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

(async () => {
  const phase = process.argv[2];
  if (!['before', 'after'].includes(phase)) throw new Error('before or after required');
  const url = new URL(process.env.DATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/collective_header_test') throw new Error('Disposable database required');
  const pool = new Pool({connectionString: url.href});
  const paragraphs = ['## A little space for focused work', ...Array.from({length: 18}, (_, i) => `### ${i+1}. Make room for one useful idea\n\nChoose a task that matters today. Give it a quiet hour, keep a short list of questions, and pause to check what you have learned. A small, steady step makes the next decision easier.\n\nKeep your notes close and leave enough room to change direction. When the work is ready, share a clear result and a practical next step.`)];
  try {
  const seeded = await pool.query("UPDATE messages SET parts=$1 WHERE id='headerAnswer'", [JSON.stringify([{type:'text', text:paragraphs.join('\n\n')}])]);
  if (seeded.rowCount !== 1) throw new Error('Run the chat-header browser suite to create the disposable fixtures first');
  await pool.query('DELETE FROM auth_throttle');
  } finally { await pool.end(); }
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/usr/bin/chromium',headless:true});
  try {
  const page = await browser.newPage({viewport:{width:1360,height:900},reducedMotion:'reduce'});
  await page.goto('http://localhost:3120/login');
  await page.getByLabel('Local username or email').fill('header-viewer');
  await page.getByLabel('Local password',{exact:true}).fill('Synthetic-header!42');
  await page.getByRole('button',{name:'Sign in with local account'}).click();
  await page.waitForURL('http://localhost:3120/');
  const out=path.resolve('docs/screenshots/chat-header'); fs.mkdirSync(out,{recursive:true});
  for (const theme of ['dark','light']) {
    await page.evaluate(theme=>localStorage.setItem('theme',theme),theme);
    for (const [size,width,height] of [['desktop',1360,900],['mobile',390,844]]) {
      await page.setViewportSize({width,height});
      await page.goto('http://localhost:3120/c/headerHome');
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      await page.locator('main header [data-bot-avatar="headerHermes"] img').waitFor();
      await page.waitForFunction(()=>document.querySelector('main header img')?.naturalHeight===2288);
      await page.getByRole('heading',{name:'A little space for focused work'}).waitFor();
      // Omit Next's developer-only indicator from review screenshots.
      await page.addStyleTag({content:'nextjs-portal { display: none; }'});
      const scroll=page.locator('main .overflow-y-auto').filter({has:page.getByRole('heading',{name:'A little space for focused work'})});
      await scroll.evaluate(el=>{el.scrollTop=420;el.dispatchEvent(new Event('scroll'));});
      await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(420);
      await page.screenshot({path:path.join(out,`${phase}-${size}-${theme}.png`),animations:'disabled'});
      console.log(JSON.stringify({phase,size,theme,geometry:await scroll.evaluate(el=>({top:el.getBoundingClientRect().top,height:el.clientHeight,scrollTop:el.scrollTop,header:document.querySelector('main header').getBoundingClientRect().toJSON()}))}));
    }
  }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
