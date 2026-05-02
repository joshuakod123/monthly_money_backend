// ═══════════════════════════════════════════════════════
// 배당나무 일일 동기화 v3
//   - OpenDART corpCode → 전체 상장사 ~3,000개 스캔
//   - 배당수익률 ≥ 1.5% 필터 (의미 있는 배당주만)
//   - 시드 JSON으로 알려진 100개는 정확한 정보 덮어쓰기
//   - OpenDART 일 한도 안에서 안전 (~6,000회)
// ═══════════════════════════════════════════════════════
const fs = require('fs');
const axios = require('axios');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const KIS_BASE = 'https://openapi.koreainvestment.com:9443';
const DART_BASE = 'https://opendart.fss.or.kr/api';

// ⭐ 옵션 B 임계값
const MIN_YIELD = 1.5;          // 배당수익률 1.5% 미만은 저장 안 함
const HISTORY_YEARS = 3;        // 5년 → 3년으로 축소 (한도 절약)

// ═════════════════════════════════════════
// KIS 토큰
// ═════════════════════════════════════════
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

// ═════════════════════════════════════════
// KIS 시세 조회
// ═════════════════════════════════════════
async function fetchKisPrice(code) {
  const token = await getKisToken();
  try {
    const res = await axios.get(
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`,
      {
        params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
        headers: {
          authorization: `Bearer ${token}`,
          appkey: process.env.KIS_APP_KEY,
          appsecret: process.env.KIS_APP_SECRET,
          tr_id: 'FHKST01010100',
          custtype: 'P',
        },
        timeout: 5000,
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
    return null;
  }
}

// ═════════════════════════════════════════
// OpenDART 상장사 마스터
// ═════════════════════════════════════════
let corpMaster = null;
async function loadCorpMaster() {
  if (corpMaster) return corpMaster;
  console.log('📥 OpenDART 상장사 마스터 다운로드...');

  const res = await axios.get(`${DART_BASE}/corpCode.xml`, {
    params: { crtfc_key: process.env.OPENDART_API_KEY },
    responseType: 'arraybuffer',
  });
  const zip = new AdmZip(Buffer.from(res.data));
  const entry = zip.getEntries().find(
    e => e.entryName.toUpperCase() === 'CORPCODE.XML'
  );
  const xml = entry.getData().toString('utf-8');
  const parsed = await xml2js.parseStringPromise(xml);

  corpMaster = [];
  for (const corp of parsed.result.list) {
    const stockCode = (corp.stock_code?.[0] || '').trim();
    const corpCode = (corp.corp_code?.[0] || '').trim();
    const name = (corp.corp_name?.[0] || '').trim();
    
    // 상장사만 (stock_code 6자리)
    if (stockCode && corpCode && stockCode.length === 6 && /^\d+$/.test(stockCode)) {
      corpMaster.push({ code: stockCode, name, corpCode });
    }
  }
  console.log(`✅ 상장사 ${corpMaster.length}개 발견`);
  return corpMaster;
}

// ═════════════════════════════════════════
// OpenDART 배당 이력 (3년치)
// ═════════════════════════════════════════
async function fetchDividendHistory(corpCode) {
  const currentYear = new Date().getFullYear();
  const history = [];
  
  for (let i = 1; i <= HISTORY_YEARS; i++) {
    const year = currentYear - i;
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
    } catch (_) {}
  }
  return history.sort((a, b) => a.year - b.year);
}

// ═════════════════════════════════════════
// 섹터 자동 추론 (이름 기반 휴리스틱)
// ═════════════════════════════════════════
function inferSector(name) {
  const n = name.toLowerCase();
  
  // ETF 우선 분류
  if (n.includes('etf') || n.includes('kodex') || n.includes('tiger') || 
      n.includes('sol ') || n.includes('ace ') || n.includes('hanaro') || 
      n.includes('arirang') || n.includes('kbstar') || n.includes('plus') ||
      n.includes('히어로즈')) {
    if (n.includes('리츠') || n.includes('reit') || n.includes('부동산') || n.includes('인프라')) return 'reit';
    return 'consumer';
  }
  
  // 일반 주식
  if (n.includes('금융') || n.includes('은행') || n.includes('증권') || 
      n.includes('보험') || n.includes('카드') || n.includes('캐피탈') ||
      n.includes('지주') || n.includes('홀딩스')) return 'finance';
  if (n.includes('통신') || n.includes('텔레콤') || n.includes('telecom')) return 'telecom';
  if (n.includes('전력') || n.includes('가스공사') || n.includes('에너지') || 
      n.includes('석유') || n.includes('정유') || n.includes('태양광')) return 'energy';
  if (n.includes('리츠') || n.includes('reit') || n.includes('부동산') || n.includes('인프라')) return 'reit';
  if (n.includes('약품') || n.includes('제약') || n.includes('바이오') || 
      n.includes('헬스') || n.includes('의료') || n.includes('생명과학')) return 'healthcare';
  if (n.includes('식품') || n.includes('제과') || n.includes('유통') || 
      n.includes('백화점') || n.includes('마트') || n.includes('편의점') ||
      n.includes('주류') || n.includes('음료')) return 'consumer';
  
  return 'industrial';
}

// ═════════════════════════════════════════
// 배당 횟수 → frequency / paymentMonths
// (단순 추론, 정확한 지급월은 시드 덮어쓰기 사용)
// ═════════════════════════════════════════
function inferFrequencyFromHistory(history) {
  // history만으로는 frequency 추론 어려움
  // history의 분산이 작으면 연배당, 크면 분기 가능성
  // 실용적으로는 연배당 디폴트
  return { frequency: 'annual', paymentMonths: [4] };
}

// ═════════════════════════════════════════
// 메인
// ═════════════════════════════════════════
async function syncAll() {
  const startTime = Date.now();
  
  // 시드 JSON (알려진 100개 정확한 정보)
  const seed = JSON.parse(fs.readFileSync('./seed-stocks.json', 'utf8'));
  const seedMap = {};
  for (const s of seed) seedMap[s.code] = s;
  console.log(`📋 시드 종목 ${seed.length}개 로드 (덮어쓰기용)`);

  // 전체 상장사
  const allCorps = await loadCorpMaster();
  console.log(`🚀 전체 ${allCorps.length}개 검사 시작 (수익률 ≥ ${MIN_YIELD}%)\n`);

  let saved = 0;
  let dividendStocks = 0;
  let belowThreshold = 0;
  let noDividend = 0;
  let failed = 0;

  // 진행 상황 카운터
  let processed = 0;

  for (const corp of allCorps) {
    processed++;
    
    // 50개마다 진행 출력
    if (processed % 50 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${processed}/${allCorps.length}] 경과 ${elapsed}s · 저장 ${saved}개 (배당주 ${dividendStocks}, 수익률 미달 ${belowThreshold})`);
    }

    try {
      // 1) 배당 이력 조회 (없으면 즉시 스킵 — 속도 핵심)
      const history = await fetchDividendHistory(corp.corpCode);
      
      if (history.length === 0) {
        noDividend++;
        await sleep(50);
        continue;
      }
      
      // 2) KIS 시세
      const priceData = await fetchKisPrice(corp.code);
      const price = priceData?.price || 0;
      
      // 3) 수익률 계산
      const latestDividend = history[history.length - 1].amount;
      const dividendYield = price > 0 && latestDividend > 0
        ? (latestDividend / price) * 100
        : 0;

      dividendStocks++;
      
      // 4) ⭐ 임계값 필터 (1.5% 미만 스킵)
      if (dividendYield < MIN_YIELD) {
        belowThreshold++;
        await sleep(50);
        continue;
      }
      
      // 5) 시드 우선, 없으면 추론
      let sector, frequency, paymentMonths;
      if (seedMap[corp.code]) {
        sector = seedMap[corp.code].sector;
        frequency = seedMap[corp.code].frequency;
        paymentMonths = seedMap[corp.code].paymentMonths;
      } else {
        sector = inferSector(corp.name);
        const freqInfo = inferFrequencyFromHistory(history);
        frequency = freqInfo.frequency;
        paymentMonths = freqInfo.paymentMonths;
      }
      
      // 6) Supabase upsert
      const row = {
        code: corp.code,
        name: corp.name,
        sector,
        frequency,
        payment_months: paymentMonths,
        price,
        per: priceData?.per || 0,
        pbr: priceData?.pbr || 0,
        market_cap: priceData?.marketCap || 0,
        dividend_per_share: latestDividend,
        dividend_yield: dividendYield,
        history,
        is_active: true,
        data_source: seedMap[corp.code] ? 'seed+kis+opendart' : 'auto',
        updated_at: new Date().toISOString(),
      };
      
      const { error } = await supabase
        .from('stocks')
        .upsert(row, { onConflict: 'code' });
      
      if (error) {
        console.warn(`  ❌ ${corp.code} ${corp.name}: ${error.message}`);
        failed++;
      } else {
        saved++;
      }
      
      // KIS rate limit
      await sleep(80);
      
    } catch (e) {
      failed++;
      await sleep(50);
    }
  }

  // 비활성 처리: 이번 sync에 없는 종목은 is_active = false
  // (선택 사항 — 일단 생략, 모든 종목 유지)

  // 메타 갱신
  await supabase.from('sync_meta').upsert({
    id: 'last_sync',
    value: {
      timestamp: new Date().toISOString(),
      total_corps: allCorps.length,
      dividend_stocks: dividendStocks,
      saved,
      below_threshold: belowThreshold,
      no_dividend: noDividend,
      failed,
      min_yield: MIN_YIELD,
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
    },
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 결과:`);
  console.log(`   전체 상장사: ${allCorps.length}`);
  console.log(`   배당 있는 종목: ${dividendStocks}`);
  console.log(`   ✅ 저장 (≥ ${MIN_YIELD}%): ${saved}`);
  console.log(`   ⏭️  수익률 미달: ${belowThreshold}`);
  console.log(`   ⏭️  배당 없음: ${noDividend}`);
  console.log(`   ❌ 실패: ${failed}`);
  console.log(`⏱️  ${Math.round((Date.now() - startTime) / 60000)}분 ${Math.round((Date.now() - startTime) / 1000) % 60}초`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

syncAll().catch(e => {
  console.error('💥 치명적 에러:', e);
  process.exit(1);
});