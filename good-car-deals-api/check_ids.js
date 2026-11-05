const { Impit } = require('impit');
const impit = new Impit({ browser: 'firefox', timeout: 10000 });

const targetIds = ['30499878', '30609246', '30744938', '30745472', '30745470'];

(async () => {
  const html = await (await impit.fetch('https://www.polovniautomobili.com/auto-oglasi/pretraga', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0' }
  })).text();
  
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) { console.log('No __NEXT_DATA__'); return; }
  
  const data = JSON.parse(match[1]);
  const buildId = data.buildId;
  
  // Fetch page 1
  const url = 'https://www.polovniautomobili.com/_next/data/' + buildId + '/auto-oglasi/pretraga.json?page=1&pageSize=200&sort=renew_date_desc&onlyWithPrice=true&damaged[]=notDamaged&showOldNew=old';
  const payload = JSON.parse(await (await impit.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0', 'Accept': 'application/json' }
  })).text());
  
  const results = payload.pageProps?.searchResults?.results ?? [];
  
  for (const id of targetIds) {
    const r = results.find(r => String(r.id) === id);
    if (r) {
      console.log(`ID ${id}: ${r.title}`);
      console.log(`  tags: ${JSON.stringify(r.tags)}`);
      console.log(`  registrationInPrice: ${r.registrationInPrice}`);
      console.log(`  showBuyerRegistration: ${r.showBuyerRegistration}`);
      console.log(`  showExtraExpenses: ${r.showExtraExpenses}`);
      console.log(`  price: ${r.price}`);
      // Dump ALL keys to find anything useful
      const allKeys = Object.keys(r);
      console.log(`  all keys: ${allKeys.join(', ')}`);
      console.log('');
    } else {
      console.log(`ID ${id}: NOT FOUND on page 1`);
    }
  }
})();
