const axios = require('axios');
require('dotenv').config();

const DART_BASE = 'https://opendart.fss.or.kr/api';

async function fetchDividendHistory(corpCode) {
  const currentYear = new Date().getFullYear();
  console.log(`현재 연도: ${currentYear}`);
  console.log(`조회할 연도들: ${currentYear - 1}, ${currentYear - 2}, ${currentYear - 3}`);
  
  const history = [];
  
  for (let i = 1; i <= 3; i++) {
    const year = currentYear - i;
    console.log(`\n━━ ${year}년 조회 ━━`);
    try {
      const res = await axios.get(`${DART_BASE}/alotMatter.json`, {
        params: {
          crtfc_key: process.env.OPENDART_API_KEY,
          corp_code: corpCode,
          bsns_year: year.toString(),
          reprt_code: '11011',
        },
        timeout: 8000,
      });
      
      console.log(`  status: ${res.data.status}`);
      
      if (res.data.status !== '000') {
        console.log(`  ⚠️ status가 000이 아님 → 스킵`);
        continue;
      }
      
      const list = res.data.list || [];
      console.log(`  list 개수: ${list.length}`);
      
      let perShare = 0;
      let yieldPct = 0;
      
      for (const row of list) {
        if ((row.stock_knd || '').includes('우선주')) {
          console.log(`  스킵 (우선주): ${row.se}`);
          continue;
        }
        
        const val = parseFloat((row.thstrm || '0').replace(/,/g, ''));
        if (isNaN(val)) {
          console.log(`  스킵 (NaN): ${row.se} = ${row.thstrm}`);
          continue;
        }
        
        const seVal = row.se || '';
        if (seVal.includes('주당') && seVal.includes('현금배당')) {
          console.log(`  ✅ 주당 현금배당 매칭: ${seVal} = ${val} (stock_knd: "${row.stock_knd || '(없음)'}")`);
          perShare = val;
        } else if (seVal.includes('현금배당수익률')) {
          console.log(`  ✅ 수익률 매칭: ${seVal} = ${val}`);
          yieldPct = val;
        }
      }
      
      console.log(`  → perShare=${perShare}, yieldPct=${yieldPct}`);
      
      if (perShare > 0) {
        history.push({ year, amount: perShare, yieldPercent: yieldPct });
        console.log(`  ✅ history 추가됨`);
      } else {
        console.log(`  ❌ perShare가 0이라 history 안 추가`);
      }
    } catch (e) {
      console.log(`  💥 에러: ${e.message}`);
    }
  }
  
  console.log(`\n━━━━━ 최종 history ━━━━━`);
  console.log(JSON.stringify(history, null, 2));
}

// KB금융 corpCode: 00688996
fetchDividendHistory('00688996');