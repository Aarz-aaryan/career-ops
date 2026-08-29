import { chromium } from 'playwright';
import fs from 'fs';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.pathai.com/careers/8623056002?gh_jid=8623056002', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  const content = await page.content();
  fs.writeFileSync('page_dump.html', content);
  console.log("Dumped");
  await browser.close();
})();
