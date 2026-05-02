const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('SUPABASE_URL 그대로:', JSON.stringify(process.env.SUPABASE_URL));
console.log('URL 길이:', process.env.SUPABASE_URL?.length);
console.log('Key 시작:', process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 30));
console.log('Key 길이:', process.env.SUPABASE_SERVICE_ROLE_KEY?.length);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function test() {
  // ① 그냥 select 시도
  console.log('\n[테스트 1] stocks 테이블 select...');
  const { data, error } = await supabase
    .from('stocks')
    .select('code')
    .limit(1);
  console.log('  data:', data);
  console.log('  error:', error);

  // ② 테이블 존재 확인 (다른 방법)
  console.log('\n[테스트 2] count로 확인...');
  const { count, error: cErr } = await supabase
    .from('stocks')
    .select('*', { count: 'exact', head: true });
  console.log('  count:', count);
  console.log('  error:', cErr);
}

test();