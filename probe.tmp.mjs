import { chromium } from 'playwright';

const COOKIE = process.env.PROBE_COOKIE;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
await ctx.addCookies([{ name: 'cf_session', value: COOKIE, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0,200)); });
await page.goto('http://localhost:3000/dashboard', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(45000);
await page.screenshot({ path: '/tmp/claude-1000/-home-ferney-oliveros-ferolicas-futbol-copia/db15c3b0-ac79-4e33-b8aa-3096bacfc22c/scratchpad/dash.png', fullPage: false });
const counts = await page.evaluate(() => ({
  cards: document.querySelectorAll('.mcard').length,
  accCards: document.querySelectorAll('.acc-card').length,
  rows: document.querySelectorAll('.virtual-match-row').length,
  url: location.href,
  bodyText: document.body.innerText.slice(0, 300),
}));
console.log(counts);
await browser.close();
