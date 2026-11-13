// 300명 현장 시뮬레이션: 실제 앱의 추첨 코드(draw-engine.js + figure.js의 figureDrawPolicy·figureAvailable·commitFigureDraw)를
// 가짜 시계 위에서 그대로 실행한다. 쿨다운(상급 당첨 후 N분 상급 제외)이 300명 동안 이상 없이 동작하는지 확인한다.
// 사용: node scripts/simulate-draw-300.cjs [반복 횟수, 기본 300]
// 환경 변수: SIM_COOL=15,20(쿨다운 분 목록), SIM_EXTRA=N(스티커 여유분 N개 추가 등록), SIM_FALLBACK=1(대안 시험: 상급만 남았는데 쿨다운이면 쿨다운 무시)
// 경품 구성(resource/lucky draw items): 라칸 1(상급 A), 제라투 10(상급 B), 플러시 4종 19(일반), 모자 100(일반), 스티커 170(참가상) = 300.
const fs = require('fs'), vm = require('vm'), assert = require('node:assert/strict');
const RUNS = Number(process.argv[2]) || 300;
const engineSrc = fs.readFileSync('app/draw-engine.js', 'utf8');
const fig = fs.readFileSync('app/figure.js', 'utf8');
const html = fs.readFileSync('app/index.html', 'utf8');
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
// 앱 코드 조각(수정 없이 잘라 씀)
const appSrc = [
  cut(fig, 'const figurePercent=', 'let scrollScrubbing'),
  cut(fig, 'function figureDrawPolicy()', 'refreshIdleSoldout = function'),
  cut(fig, 'function commitFigureDraw()', 'function commitScrollDraw()'),
  cut(html, 'function nextSerial()', '/* ════════════════ S6'),
].join('\n');
const K_STATE = (html.match(/K_STATE='([^']+)'/) || [])[1]; assert.ok(K_STATE);

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const IPS = [{ id: 'wf', name: 'SWC2026 World Finals', prizes: [
  { grade: 'A', name: 'Rakan Statue', kind: 'figure', tier: 'high', total: 1 },
  { grade: 'B', name: 'Zeratu Figure', kind: 'figure', tier: 'high', total: 10 },
  { grade: 'C', name: 'Plushies', kind: 'normal', tier: 'normal', subs: [{ name: 'Plush 1' }, { name: 'Plush 2' }, { name: 'Plush 3' }, { name: 'Plush 4' }], subTotals: [5, 5, 5, 4] },
  { grade: 'D', name: 'SWC Cap', kind: 'normal', tier: 'normal', total: 100 },
  { grade: 'E', name: 'Monster Deco Stickers', kind: 'participation', tier: 'normal', total: 170 },
] }];
const freshStock = () => ({ wf: IPS[0].prizes.map(p => p.subs ? [...p.subTotals] : p.total) });
const TOTAL = 300; // 참여자 수
const EXTRA = Number(process.env.SIM_EXTRA) || 0, FALLBACK = process.env.SIM_FALLBACK === '1';
IPS[0].prizes[4].total += EXTRA;

// 한 번의 "앱 실행" = 새 vm 컨텍스트. 재실행 때는 localStorage(K_STATE)에서 재고·기록을 다시 읽는다(index.html loadStock/loadLog와 같은 방식).
function boot(store, clock, cfg, rand) {
  class FakeDate extends Date { constructor(...a) { a.length ? super(...a) : super(clock.now); } static now() { return clock.now; } }
  const state = JSON.parse(store[K_STATE] || 'null');
  const ctx = { Date: FakeDate, JSON, cfg, stock: state ? state.stock : freshStock(), logArr: state ? state.log : [], selectedScroll: 0, K_STATE, curIp: null, lastResult: null,
    localStorage: { setItem(k, v) { store[k] = v; }, getItem(k) { return store[k] ?? null; } }, module: undefined };
  vm.createContext(ctx);
  vm.runInContext('Math.random=__rand;', Object.assign(ctx, { __rand: rand }));
  vm.runInContext(engineSrc + '\n' + appSrc + '\nthis.__api={figureDrawPolicy,figureAvailable,commitFigureDraw,get stock(){return stock},get log(){return logArr},get last(){return lastResult}};', ctx);
  return ctx.__api;
}

// 참여 1회 걸리는 시간(초): 상급(A·B)은 축하 → 시네마틱 → 상품 영상이라 더 길다. 다음 참여자까지 간격은 시나리오별.
const SERVICE = { figure: 60, other: 30 };
function runOnce(seed, sc) {
  const rand = mulberry32(seed), timeRand = mulberry32(seed ^ 0x9e3779b9);
  const clock = { now: Date.parse('2026-11-21T09:00:00+09:00') };
  const cfg = { ips: IPS, cooldownMin: sc.cool, figureCooldownEnabled: sc.cool > 0, figureProbabilityEnabled: sc.pct != null, figureWinPercent: sc.pct ?? 10, figureIntervalEnabled: false };
  const store = {};
  let api = boot(store, clock, cfg, rand), reboots = 0, stalls = 0, stallSec = 0, maxStall = 0, fallbacks = 0;
  const figureTimes = [], figureIdx = [], order = [];
  for (let n = 0; n < TOTAL; n++) {
    if (n && timeRand() < 1 / 60) { api = boot(store, clock, cfg, rand); reboots++; } // 가끔 앱을 껐다 켬
    // 대기 화면 터치: 앱과 같이 figureAvailable()이 막으면(쿨다운 중인데 상급 말고 남은 재고 없음) 스태프가 기다렸다 다시 누른다.
    let waited = 0, fellBack = false;
    // 대안(나): 쿨다운 때문에 막혔고 남은 재고가 상급뿐이면 이번 1회는 쿨다운을 무시한다(앱 수정안 시험).
    if (FALLBACK && cfg.figureCooldownEnabled && !api.figureAvailable().ok) { cfg.figureCooldownEnabled = false; if (api.figureAvailable().ok) fellBack = true; else cfg.figureCooldownEnabled = true; }
    while (!api.figureAvailable().ok) { clock.now += 15000; waited += 15; if (waited > 3 * 3600) throw Error('3시간 넘게 막힘'); }
    if (waited) { stalls++; stallSec += waited; maxStall = Math.max(maxStall, waited); }
    const before = JSON.stringify(api.stock), pol = api.figureDrawPolicy();
    api.commitFigureDraw();
    if (fellBack) { cfg.figureCooldownEnabled = true; fallbacks++; }
    const L = api.last, log = api.log;
    // 검사: 기록 1건 추가, 재고 정확히 1 감소, 음수 없음, 쿨다운 중 상급 당첨 없음
    assert.equal(log.length, n + 1);
    const flat = s => s.wf.flat(), b = flat(JSON.parse(before)), a = flat(api.stock);
    assert.equal(b.reduce((x, y) => x + y) - a.reduce((x, y) => x + y), 1);
    assert.ok(a.every(v => v >= 0));
    if (L.kind === 'figure') {
      assert.equal(pol.gate.blocked, false, '쿨다운 중 상급 당첨');
      if (figureTimes.length && !fellBack) assert.ok(clock.now - figureTimes.at(-1) >= sc.cool * 60000, '쿨다운보다 짧은 간격');
      figureTimes.push(clock.now); figureIdx.push(n + 1);
    }
    order.push(L.prize.grade);
    clock.now += Math.round(((L.kind === 'figure' ? SERVICE.figure : SERVICE.other) + sc.gap[0] + timeRand() * (sc.gap[1] - sc.gap[0])) * 1000);
  }
  // 끝: 300개 모두 지급, 등급별 수량 일치, 일련번호 1~300
  const log = api.log, count = g => log.filter(l => l.grade === g).length;
  const left = api.stock.wf.map(c => [].concat(c).reduce((x, y) => x + y, 0));
  assert.deepEqual(['A', 'B', 'C', 'D', 'E'].map(count).map((c, i) => c + left[i]), [1, 10, 19, 100, 170 + EXTRA]);
  if (!EXTRA) assert.ok(left.every(v => v === 0));
  assert.deepEqual(log.map(l => l.serial), log.map((_, i) => i + 1));
  const gaps = figureTimes.slice(1).map((t, i) => (t - figureTimes[i]) / 60000);
  return { figLeft: left[0] + left[1], rakanLeft: left[0], fallbacks, stalls, stallSec, maxStall, reboots, figureIdx, rakan: order.indexOf('A') + 1, minGap: gaps.length ? Math.min(...gaps) : null,
    hours: (clock.now - Date.parse('2026-11-21T09:00:00+09:00')) / 3600000, last30fig: figureIdx.filter(i => i > TOTAL - 30).length };
}

const SCENARIOS = [];
const CADENCE = [['빠름(다음 사람 0~15초)', [0, 15]], ['보통(15~60초)', [15, 60]], ['느림(60~120초)', [60, 120]]];
for (const cool of (process.env.SIM_COOL ? process.env.SIM_COOL.split(',').map(Number) : [0, 5, 10, 15, 20, 30])) for (const [cname, gap] of CADENCE) SCENARIOS.push({ name: `쿨다운 ${cool ? cool + '분' : '끔'} · ${cname}${EXTRA ? ' · 스티커 +' + EXTRA : ''}${FALLBACK ? ' · 대안(나)' : ''}`, cool, gap });

const pctl = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const t0 = Date.now(); const rows = [];
for (const sc of SCENARIOS) {
  if (sc.cool === 0 && (EXTRA || FALLBACK)) continue;
  const R = []; for (let i = 0; i < RUNS; i++) R.push(runOnce(1000 + i * 7919 + sc.cool * 31 + sc.gap[1], sc));
  const withStall = R.filter(r => r.stalls).length;
  const row = {
    시나리오: sc.name,
    '300명 소요(시간)': pctl(R.map(r => r.hours), .5).toFixed(1),
    '멈춤 생긴 회차': `${withStall}/${RUNS}`,
    '멈춤 횟수(평균)': (R.reduce((s, r) => s + r.stalls, 0) / RUNS).toFixed(2),
    '최장 멈춤(분)': (Math.max(...R.map(r => r.maxStall)) / 60).toFixed(1),
    '상급 최소 간격(분)': Math.min(...R.map(r => r.minGap ?? Infinity)).toFixed(1),
    '마지막 30명 중 상급(평균)': (R.reduce((s, r) => s + r.last30fig, 0) / RUNS).toFixed(2),
    '마지막 상급 순번(중앙)': pctl(R.map(r => r.figureIdx.at(-1)), .5),
    '라칸 순번(중앙)': pctl(R.map(r => r.rakan), .5),
    '상급 남은 회차': `${R.filter(r => r.figLeft).length}/${RUNS}`,
    '남은 상급(평균)': (R.reduce((s, r) => s + r.figLeft, 0) / RUNS).toFixed(2),
    '라칸 남은 회차': `${R.filter(r => r.rakanLeft).length}/${RUNS}`,
    '쿨다운 무시 지급(평균)': (R.reduce((s, r) => s + r.fallbacks, 0) / RUNS).toFixed(2),
    재실행: R.reduce((s, r) => s + r.reboots, 0),
  };
  rows.push(row); console.log(JSON.stringify(row));
}
fs.writeFileSync(process.env.SIM_OUT || 'sim-result.json', JSON.stringify({ runs: RUNS, rows }, null, 1));
console.log(`통과: ${SCENARIOS.length}개 시나리오 × ${RUNS}회 × 300명 — 기록·재고·쿨다운·수량 검사 모두 통과 (${((Date.now() - t0) / 1000).toFixed(0)}초)`);
