// ═══════════════════════════════════════════════════════
// 배당나무 일일 동기화 배치
// ═══════════════════════════════════════════════════════
const fs = require('fs');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const KIS_BASE = 'https://openapi.koreainvestment.com:9443';
const DART_BASE = 'https://opendart.fss.or.kr/api';

// ─────────────────────────────────────────────
// KIS 토큰 발급
// ─────────────────────────────────────────────
let kisToken = null;
async function getKisToken() {
  if (kisToken) return kisToken;
  const res = await axios.post(`${KIS_BASE}/oauth2/tokenP`, {
    grant_type: 'client_credentials',
    appkey: process.env.KIS_APP_KEY,
    appsecret: process.env.KIS_APP_SECRET,
  });
  kisToken = res.data.access_token;
  console.log('✅ KIS 토큰 발급');
  return kisToken;
}

// ─────────────────────────────────────────────
// KIS 시세 조회 (PER, PBR, 시총 포함)
// ─────────────────────────────────────────────
async function fetchKisPrice(code) {
  const token = await getKisToken();
  try {
    const res = await axios.get(
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`,
      {
        params: {
          FID_COND_MRKT_DIV_CODE: 'J',
          FID_INPUT_ISCD: code,
        },
        headers: {
          authorization: `Bearer ${token}`,
          appkey: process.env.KIS_APP_KEY,
          appsecret: process.env.KIS_APP_SECRET,
          tr_id: 'FHKST01010100',
          custtype: 'P',
        },
      }
    );
    if (res.data.rt_cd !== '0') return null;
    const o = res.data.output;
    return {
      price: parseInt((o.stck_prpr || '0').replace(/,/g, '')) || 0,
      per: parseFloat((o.per || '0').replace(/,/g, '')) || 0,
      pbr: parseFloat((o.pbr || '0').replace(/,/g, '')) || 0,
      eps: parseFloat((o.eps || '0').replace(/,/g, '')) || 0,
      marketCap: parseInt((o.hts_avls || '0').replace(/,/g, '')) || 0,
    };
  } catch (e) {
    console.warn(`  ⚠️ KIS ${code} 실패: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// OpenDART corp_code 매핑 (1회 다운로드)
// ─────────────────────────────────────────────
let corpCodeMap = null;
async function loadCorpCodeMap() {
  if (corpCodeMap) return corpCodeMap;
  console.log('📥 OpenDART corpCode 다운로드 중...');
  const AdmZip = require('adm-zip');
  const xml2js = require('xml2js');

  const res = await axios.get(`${DART_BASE}/corpCode.xml`, {
    params: { crtfc_key: process.env.OPENDART_API_KEY },
    responseType: 'arraybuffer',
  });
  const zip = new AdmZip(Buffer.from(res.data));
  const entry = zip.getEntries().find(e => e.entryName.toUpperCase() === 'CORPCODE.XML');
  const xml = entry.getData().toString('utf-8');
  const parsed = await xml2js.parseStringPromise(xml);

  corpCodeMap = {};
  for (const corp of parsed.result.list) {
    const stockCode = (corp.stock_code?.[0] || '').trim();
    const corpCode = (corp.corp_code?.[0] || '').trim();
    if (stockCode && corpCode) {
      corpCodeMap[stockCode] = corpCode;
    }
  }
  console.log(`✅ corpCode 매핑 ${Object.keys(corpCodeMap).length}개`);
  return corpCodeMap;
}

// ─────────────────────────────────────────────
// OpenDART 배당 이력 (5년치)
// ─────────────────────────────────────────────
async function fetchDividendHistory(code) {
  const map = await loadCorpCodeMap();
  const corpCode = map[code];
  if (!corpCode) return [];

  const currentYear = new Date().getFullYear();
  const history = [];
  for (let i = 1; i <= 5; i++) {
    const year = currentYear - i;
    try {
      const res = await axios.get(`${DART_BASE}/alotMatter.json`, {
        params: {
          crtfc_key: process.env.OPENDART_API_KEY,
          corp_code: corpCode,
          bsns_year: year.toString(),
          reprt_code: '11011',
        },
      });
      if (res.data.status !== '000') continue;
      const list = res.data.list || [];
      let perShare = 0;
      let yieldPct = 0;
      for (const row of list) {
        if ((row.stock_knd || '').includes('우선주')) continue;
        const val = parseFloat((row.thstrm || '0').replace(/,/g, ''));
        if (isNaN(val)) continue;
        if ((row.se || '').includes('주당') && (row.se || '').includes('현금배당')) {
          perShare = val;
        } else if ((row.se || '').includes('현금배당수익률')) {
          yieldPct = val;
        }
      }
      if (perShare > 0) history.push({ year, amount: perShare, yieldPercent: yieldPct });
    } catch (_) {
      // skip
    }
  }
  return history.sort((a, b) => a.year - b.year);
}

// ─────────────────────────────────────────────
// 메인: 모든 종목 동기화
// ─────────────────────────────────────────────
async function syncAll() {
  const startTime = Date.now();
  const seed = JSON.parse(fs.readFileSync('./seed-stocks.json', 'utf8'));
  console.log(`🚀 ${seed.length}개 종목 동기화 시작\n`);

  let success = 0;
  let failed = 0;

  for (const s of seed) {
    process.stdout.write(`[${success + failed + 1}/${seed.length}] ${s.code} ${s.name}... `);

    const price = await fetchKisPrice(s.code);
    const history = await fetchDividendHistory(s.code);

    // 동적 데이터로 보강
    const latestDividend = history.length > 0 ? history[history.length - 1].amount : 0;
    const dividendYield = price && price.price > 0 && latestDividend > 0
      ? (latestDividend / price.price) * 100
      : 0;

    const row = {
      code: s.code,
      name: s.name,
      sector: s.sector,
      frequency: s.frequency,
      payment_months: s.paymentMonths,
      price: price?.price || 0,
      per: price?.per || 0,
      pbr: price?.pbr || 0,
      market_cap: price?.marketCap || 0,
      dividend_per_share: latestDividend,
      dividend_yield: dividendYield,
      history: history,
      is_active: true,
      data_source: price ? 'kis+opendart' : 'opendart',
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('stocks')
      .upsert(row, { onConflict: 'code' });

    if (error) {
      console.log(`❌ ${error.message}`);
      console.log(`   상세: ${JSON.stringify(error)}`);  // ⭐ 이 줄 추가
      failed++;
    } else {
      console.log(`✅`);
      success++;
    }

    // KIS rate limit (초당 20회 제한 → 50ms 간격)
    await new Promise(r => setTimeout(r, 60));
  }

  // 메타 갱신
  await supabase.from('sync_meta').upsert({
    id: 'last_sync',
    value: {
      timestamp: new Date().toISOString(),
      success,
      failed,
      total: seed.length,
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
    },
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ 성공 ${success} / ❌ 실패 ${failed}`);
  console.log(`⏱️  ${Math.round((Date.now() - startTime) / 1000)}초`);
}

syncAll().catch(e => {
  console.error('💥 치명적 에러:', e);
  process.exit(1);
});