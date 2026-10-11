import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const screens=process.env.GROUP_ACTIVITY_SCREENSHOTS??'/tmp/collective-group-activity-screenshots';
async function phase(page:Page,value:string){await page.request.get('/fixture/phase?value='+value);await page.evaluate(()=>window.dispatchEvent(new Event('bot-work-changed')));}
const row=(page:Page,id:string)=>page.locator('[data-navigation-bot="'+id+'"]');
test.beforeAll(async()=>{await mkdir(screens,{recursive:true});});
test.beforeEach(async({page})=>{
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.request.get('/fixture/phase?value=idle'); await page.goto('/');
});
test('expanded and collapsed reflect speaker, handoff, concurrent work, approval and completion',async({page})=>{
  await expect(row(page,'b1')).toBeVisible();await page.screenshot({path:screens+'/before-expanded.png'});
  await page.getByRole('button',{name:'Close sidebar',exact:true}).click();await page.screenshot({path:screens+'/before-collapsed.png'});
  await page.getByRole('button',{name:'Open sidebar',exact:true}).click();
  await phase(page,'research');await expect(row(page,'b1').getByText('Working…',{exact:true})).toBeVisible();await expect(row(page,'b0').getByText('Working…',{exact:true})).toHaveCount(0);
  await page.screenshot({path:screens+'/after-expanded.png'});
  await page.getByRole('button',{name:'Close sidebar',exact:true}).click();await expect(page.getByRole('link',{name:'Researcher, Working',exact:true})).toBeVisible();
  await page.screenshot({path:screens+'/after-collapsed.png'});
  await phase(page,'handoff');await expect(page.getByRole('link',{name:'Writer, Working',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Researcher, Working',exact:true})).toHaveCount(0);
  await phase(page,'concurrent');await expect(page.getByRole('link',{name:'Extra bot, Working',exact:true})).toBeVisible();
  await page.screenshot({path:screens+'/after-concurrent-collapsed.png'});
  await phase(page,'approval');await expect(page.getByRole('link',{name:'Researcher, Needs your approval',exact:true})).toBeVisible();
  // Simulate a mounted stale approval; the fresh idle snapshot must win.
  await page.evaluate(()=>((window as unknown as {activityFixture:{setStatus:(id:string,status:string)=>void}}).activityFixture.setStatus('b1','waiting')));
  await phase(page,'idle');await expect(page.getByRole('link',{name:'Researcher, Idle',exact:true})).toBeVisible();await expect(page.locator('[data-rail-working]')).toHaveCount(0);
  await page.screenshot({path:screens+'/after-completed.png'});
});
test('off-limit bots, hidden choices, overflow status, keyboard and short dark viewport',async({page})=>{
  await phase(page,'concurrent');await expect(row(page,'b6')).toBeVisible();await expect(row(page,'b7')).toHaveCount(0);
  await page.setViewportSize({width:850,height:540});await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.getByRole('button',{name:'Close sidebar',exact:true}).click();await phase(page,'overflow');
  const overflow=page.getByRole('button',{name:/All bots.*working/});await expect(overflow).toBeVisible();
  await overflow.focus();await page.keyboard.press('Enter');await expect(page.getByRole('textbox',{name:'Find a bot'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Extra bot Working',exact:true})).toBeVisible();await page.screenshot({path:screens+'/after-overflow-dark.png'});
  await page.keyboard.press('Escape');await expect(overflow).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('mobile expanded rows show actual work without horizontal overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});await phase(page,'handoff');await expect(row(page,'b5').getByText('Working…',{exact:true})).toBeVisible();
  expect(await row(page,'b5').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);await row(page,'b5').screenshot({path:screens+'/after-mobile-row.png'});
});
