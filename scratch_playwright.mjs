import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.pathai.com/careers/8623056002?gh_jid=8623056002', { waitUntil: 'networkidle' });
  
  // Wait a bit just in case
  await page.waitForTimeout(3000);
  
  // Try to find iframes
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const text = await frames[i].evaluate(() => document.body.innerText);
    console.log(`--- FRAME ${i} (${frames[i].url()}) ---`);
    console.log(text.substring(0, 500));
    if (text.includes('Software Engineer') || text.includes('Co-op')) {
        console.log("FULL TEXT:");
        console.log(text);
    }
  }
  
  await browser.close();
})();
