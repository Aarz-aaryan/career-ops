import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('response', response => {
    if (response.url().includes('greenhouse')) {
      console.log('Greenhouse URL:', response.url());
    }
  });

  await page.goto('https://www.pathai.com/careers/8623056002?gh_jid=8623056002', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  
  await browser.close();
})();
