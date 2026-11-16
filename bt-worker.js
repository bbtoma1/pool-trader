/* bt-worker.js - 이벤트 연구(검증). Web Worker 에서 engine.js 와 같은 코드를 사용한다.
 * 입력: {series, universe, fund, lens}
 * 출력: 시장별로 두 묶음. all=전체 종목, neutral=지수·섹터 ETF만(개별주 선택 편향이 없는 중립 유니버스).
 * 체결: 신호 다음 거래일 종가. 같은 웅덩이에서는 차수마다 첫 신호일만 센다.
 */
importScripts('engine.js');
var H = [20, 60, 120, 250];

function stats(arr) {
  var n = arr.length; if (!n) return { n: 0 };
  var up = 0, sum = 0;
  arr.forEach(function (x) { if (x > 0) up++; sum += x; });
  return { n: n, up: up / n, mean: sum / n };
}
function mae60(c, i) { // 진입(i+1) 후 60일 내 최대낙폭
  var a = i + 1, e = Math.min(c.length - 1, a + 60), m = c[a], low = 0;
  if (a >= c.length) return null;
  for (var j = a; j <= e; j++) { var d = c[j] / m - 1; if (d < low) low = d; }
  return low;
}

var RATIO = [0.2, 0.3, 0.5]; // 차수별 현금 사용 비율(앱의 내 계좌와 동일)

/* 매매 시뮬레이션: 처음 50% 보유 + 신호 단계별 추가 매수, 신호 다음 거래일 종가 체결.
 * 비교 대상: 50% 방치(추가 매수 없음), 100% 보유. 종료 시점에 전량 매도한 것으로 비용을 반영한다.
 * 가격은 배당 반영 수정주가(c)를 쓴다. 매도 시 수수료와 거래세(국내 개별주만; 국내 ETF는 거래세 면제)를 차감. */
function simulate(c, tierArr, i0, feeRate, sellRate) {
  var n = c.length, j0 = i0 + 1;
  function metrics(eq) {
    var peak = -1, mdd = 0;
    for (var k = 0; k < eq.length; k++) { if (eq[k] > peak) peak = eq[k]; var d = eq[k] / peak - 1; if (d < mdd) mdd = d; }
    var yrs = (n - 1 - j0) / 252, cagr = Math.pow(eq[eq.length - 1] / 100, 1 / yrs) - 1;
    return { cagr: cagr, mdd: mdd, calmar: mdd < 0 ? cagr / -mdd : null };
  }
  function run(initFrac, addBuys) {
    var cash = 100 * (1 - initFrac), units = 100 * initFrac * (1 - feeRate) / c[j0], eq = [], buys = 0;
    var seen = { 1: -1e9, 2: -1e9, 3: -1e9 }, quiet = 999;
    eq.push(cash + units * c[j0]);
    for (var j = j0 + 1; j < n; j++) {
      var i = j - 1; // i 일의 신호를 j 일 종가에 체결
      var t = tierArr[i] || 0;
      if (t === 0) quiet++;
      else {
        if (addBuys) {
          for (var q = 1; q <= t; q++) {
            if (i - seen[q] > 20 && (quiet >= 20 || seen[q] < 0)) {
              seen[q] = i;
              var amt = cash * RATIO[q - 1];
              if (amt > 0) { units += amt * (1 - feeRate) / c[j]; cash -= amt; buys++; }
            }
          }
        }
        quiet = 0;
      }
      eq.push(cash + units * c[j]);
    }
    eq[eq.length - 1] = cash + units * c[n - 1] * (1 - feeRate - sellRate); // 종료 시 전량 매도 비용
    var m = metrics(eq); m.buys = buys; return m;
  }
  return { strat: run(0.5, true), half: run(0.5, false), hold: run(1, false) };
}

function analyze(list, ser, mk, fund, lens, costs) {
  var sims = [], ageB = [[], [], []]; // 신호 지속 일수별 60일 수익률: 0~10일(신규), 11~30일, 31일 이상
  var tiers = { 1: { all: [], oos: [], mae: [] }, 2: { all: [], oos: [], mae: [] }, 3: { all: [], oos: [], mae: [] } };
  var base = { all: {}, oos: {} }; H.forEach(function (h) { base.all[h] = []; base.oos[h] = []; });
  var fw = {}; H.forEach(function (h) { fw[h] = { 1: [], 2: [], 3: [] }; });
  var names = [];
  list.forEach(function (w) {
    var s = ser[w.sym], P = Engine.attachFund(Engine.prepare(s), fund[w.sym]), n = s.c.length; names.push(w.sym);
    var split = Math.floor(260 + (n - 260) * 0.7), seen = { 1: -1e9, 2: -1e9, 3: -1e9 }, quiet = 999, tierArr = new Array(n).fill(0), start = -1;
    for (var i = 260; i < n - 2; i++) {
      var r = Engine.evaluateBy(lens, P, i, mk, { lev: w.lev });
      tierArr[i] = r.tier;
      var oos = i >= split;
      H.forEach(function (h) {
        var f = Engine.fwd(s.c, i, h); if (f == null) return;
        base.all[h].push(f); if (oos) base.oos[h].push(f);
      });
      if (r.tier === 0) { quiet++; continue; }
      if (quiet >= 20 || start < 0) start = i; // 신호 구간(웅덩이)의 시작일
      var fAge = Engine.fwd(s.c, i, 60);
      if (fAge != null) { var ag = i - start; ageB[ag <= 10 ? 0 : ag <= 30 ? 1 : 2].push(fAge); }
      // 새 웅덩이: 신호가 없던 날이 20일 이상 이어진 뒤의 첫 진입
      for (var t = 1; t <= r.tier; t++) {
        if (i - seen[t] > 20 && (quiet >= 20 || seen[t] < 0)) {
          seen[t] = i;
          var f60 = Engine.fwd(s.c, i, 60);
          if (f60 != null) { tiers[t].all.push(f60); if (oos) tiers[t].oos.push(f60); var m = mae60(s.c, i); if (m != null) tiers[t].mae.push(m); }
          H.forEach(function (h) { var f = Engine.fwd(s.c, i, h); if (f != null) fw[h][t].push(f); });
        }
      }
      quiet = 0;
    }
    var cm = costs[w.market] || { fee: 0, tax: 0 };
    var tax = w.market === 'KR' && w.group !== 'stock' ? 0 : cm.tax; // 국내 ETF 는 거래세 면제
    sims.push(simulate(s.c, tierArr, 260, cm.fee / 100, tax / 100));
  });
  var out = { symbols: names, tiers: {}, base: {}, sim: aggSim(sims), costs: costs, age: { fresh: stats(ageB[0]), mid: stats(ageB[1]), old: stats(ageB[2]) } };
  [1, 2, 3].forEach(function (t) {
    out.tiers[t] = { all: stats(tiers[t].all), oos: stats(tiers[t].oos), mae: tiers[t].mae.length ? tiers[t].mae.reduce(function (a, b) { return a + b; }, 0) / tiers[t].mae.length : null, byH: {} };
    H.forEach(function (h) { out.tiers[t].byH[h] = stats(fw[h][t]); });
  });
  H.forEach(function (h) { out.base[h] = { all: stats(base.all[h]), oos: stats(base.oos[h]) }; });
  return out;
}

function aggSim(sims) {
  var out = { n: sims.length }, keys = ['strat', 'half', 'hold'];
  keys.forEach(function (k) {
    var a = { cagr: 0, mdd: 0, calmar: 0, buys: 0, cn: 0 };
    sims.forEach(function (s) { a.cagr += s[k].cagr; a.mdd += s[k].mdd; a.buys += s[k].buys; if (s[k].calmar != null) { a.calmar += s[k].calmar; a.cn++; } });
    out[k] = { cagr: a.cagr / sims.length, mdd: a.mdd / sims.length, calmar: a.cn ? a.calmar / a.cn : null, buys: a.buys / sims.length };
  });
  out.winCalmar = sims.filter(function (s) { return s.strat.calmar != null && s.hold.calmar != null && s.strat.calmar > s.hold.calmar; }).length;
  out.winCagr = sims.filter(function (s) { return s.strat.cagr > s.hold.cagr; }).length;
  out.winMdd = sims.filter(function (s) { return s.strat.mdd > s.hold.mdd; }).length; // 낙폭이 더 얕음
  return out;
}

/* 신호별 효과: 신호가 켜진 날(강도>0)과 꺼진 날의 60일 후 수익률 비교(레버리지는 배율로 나눠 기초 환산).
 * 60일 수익률은 겹치므로 z 값은 표본 수를 n/60 으로 줄여 보수적으로 계산한다.
 * 안정성: 기간 앞 절반과 뒤 절반에서 각각 켜짐-꺼짐 차이를 구해 부호가 같은지 본다. */
function mom(a) {
  var n = a.length; if (!n) return { n: 0, m: 0, sd: 0, up: 0 };
  var s = 0, u = 0, i; for (i = 0; i < n; i++) { s += a[i]; if (a[i] > 0) u++; }
  var m = s / n, v = 0; for (i = 0; i < n; i++) v += (a[i] - m) * (a[i] - m);
  return { n: n, m: m, sd: Math.sqrt(v / Math.max(1, n - 1)), up: u / n };
}
function edgeAnalyze(list, ser, mk, fund) {
  var acc = {}, order = [];
  function push(key, label, on, f, half) {
    var a = acc[key]; if (!a) { a = acc[key] = { label: label, on: [[], []], off: [[], []] }; order.push(key); }
    (on ? a.on : a.off)[half].push(f);
  }
  list.forEach(function (w) {
    var s = ser[w.sym], P = Engine.attachFund(Engine.prepare(s), fund[w.sym]), n = s.c.length, mid = Math.floor((260 + n) / 2), L = Math.max(1, w.lev || 1);
    for (var i = 260; i < n - 62; i++) {
      var f = Engine.fwd(s.c, i, 60); if (f == null) continue; f /= L;
      var half = i < mid ? 0 : 1;
      var e = Engine.evaluate(P, i, mk, { lev: w.lev });
      e.signals.forEach(function (g) { if (!g.na) push('p_' + g.key, '웅덩이 · ' + g.label, g.strength > 0, f, half); });
      push('p_tier', '웅덩이 · 종합 1차 이상', e.tier >= 1, f, half);
      var d = Engine.evaluateDoki(P, i, mk, { lev: w.lev });
      d.signals.forEach(function (g) { if (!g.na) push('d_' + g.key, '도키 · ' + g.label, g.strength > 0, f, half); });
    }
  });
  var out = [];
  order.forEach(function (k) {
    var a = acc[k], on = a.on[0].concat(a.on[1]), off = a.off[0].concat(a.off[1]);
    var A = mom(on), B = mom(off);
    if (A.n < 30 || B.n < 30) { out.push({ key: k, label: a.label, nOn: A.n, nOff: B.n, thin: true }); return; }
    var ne1 = Math.max(1, A.n / 60), ne2 = Math.max(1, B.n / 60);
    var se = Math.sqrt(A.sd * A.sd / ne1 + B.sd * B.sd / ne2), diff = A.m - B.m;
    function halfDiff(h) { var x = mom(a.on[h]), y = mom(a.off[h]); return x.n >= 20 && y.n >= 20 ? x.m - y.m : null; }
    out.push({ key: k, label: a.label, nOn: A.n, nOff: B.n, upOn: A.up, upOff: B.up, mOn: A.m, mOff: B.m, diff: diff, z: se ? diff / se : 0, dA: halfDiff(0), dB: halfDiff(1) });
  });
  return out;
}

/* 자동 보정(워크포워드): 종목별 앞 70%(학습)로 가중치와 임계값을 정하고 뒤 30%(검증)에서 기본값보다 나을 때만 채택한다.
 * - 가중치: 학습 구간의 신호별 효과 z 로 기본 가중치의 0.4~1.6배 (배수 = 1 + 0.15 z), 합계 100 으로 정규화
 * - 임계값: 1차 30~65(5 단위), 차수 간격 10/15/20 격자 탐색. 학습 구간 이벤트 초과수익의 z 가 가장 큰 값(이벤트 30건 이상)
 * - 채택 시 기본값 쪽으로 50% 되돌려(수축) 안정화한 값을 쓴다. 채택 조건: 검증 구간 초과수익이 기본값보다 크고 0보다 클 것
 * 현재 범위는 웅덩이 관점의 7개 신호다. */
var KEYS = Engine.KEYS;
var DEFW = KEYS.map(function (k) { return Engine.WEIGHTS[k]; }), DEFTH = [40, 55, 70];
function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }
function normW(w) { var s = w.reduce(function (a, b) { return a + b; }, 0); return w.map(function (v) { return v * 100 / s; }); }
function buildRows(list, ser, mk) {
  return list.map(function (w) {
    var s = ser[w.sym], P = Engine.prepare(s), n = s.c.length, L = Math.max(1, w.lev || 1), split = Math.floor(260 + (n - 260) * 0.7), rows = [];
    for (var i = 260; i < n - 62; i++) {
      var f = Engine.fwd(s.c, i, 60); if (f == null) continue;
      var sg = Engine.signalsAt(P, i, mk, L), sv = new Array(KEYS.length).fill(0), av = new Array(KEYS.length).fill(1);
      sg.forEach(function (g) { var k = KEYS.indexOf(g.key); if (k >= 0) { sv[k] = g.strength; av[k] = g.na ? 0 : 1; } });
      var wr = P.wrsi[i];
      rows.push({ s: sv, av: av, oh: wr != null && wr >= 70, fl: f / L, test: i >= split, L: L });
    }
    return rows;
  });
}
function summ(b) {
  var e = mom(b.ev), base = mom(b.base), ex = e.n ? e.m - base.m : 0;
  return { n: e.n, excess: ex, up: e.n ? e.up : null, baseUp: base.up, z: e.n > 1 && e.sd > 0 ? ex / (e.sd / Math.sqrt(e.n)) : 0 };
}
function evalParams(syms, wv, th) {
  var tr = { ev: [], base: [] }, te = { ev: [], base: [] };
  syms.forEach(function (rows) {
    var seen = -1e9, quiet = 999;
    for (var r = 0; r < rows.length; r++) {
      var x = rows[r], sc = 0, aw = 0, k;
      for (k = 0; k < wv.length; k++) { sc += x.s[k] * wv[k]; aw += x.av[k] * wv[k]; }
      sc = aw > 0 ? sc * 100 / aw : 0; // 시장에 없는 신호를 뺀 나머지로 정규화(엔진과 같은 방식)
      if (sc > 100) sc = 100;
      var tier = sc >= th[2] ? 3 : sc >= th[1] ? 2 : sc >= th[0] ? 1 : 0;
      if (x.L >= 3 && tier > 2) tier = 2;
      if (x.oh) tier = 0;
      var b = x.test ? te : tr; b.base.push(x.fl);
      if (tier === 0) { quiet++; continue; }
      if (r - seen > 20 && (quiet >= 20 || seen < 0)) { seen = r; b.ev.push(x.fl); }
      quiet = 0;
    }
  });
  return { train: summ(tr), test: summ(te) };
}
function keyZ(syms, k) {
  var on = [], off = [];
  syms.forEach(function (rows) { rows.forEach(function (x) { if (!x.test) (x.s[k] > 0 ? on : off).push(x.fl); }); });
  var A = mom(on), B = mom(off); if (A.n < 30 || B.n < 30) return 0;
  var se = Math.sqrt(A.sd * A.sd / Math.max(1, A.n / 60) + B.sd * B.sd / Math.max(1, B.n / 60));
  return se ? (A.m - B.m) / se : 0;
}
function obj(vec) { var o = {}; KEYS.forEach(function (k, i) { o[k] = Math.round(vec[i] * 100) / 100; }); return o; }
function calibrate(list, ser, mk) {
  var syms = buildRows(list, ser, mk), z = {}, mult = {}, wc = [];
  KEYS.forEach(function (k, i) { z[k] = keyZ(syms, i); mult[k] = clampN(1 + 0.15 * z[k], 0.4, 1.6); wc.push(DEFW[i] * mult[k]); });
  var wCal = normW(wc), best = null;
  for (var t1 = 30; t1 <= 65; t1 += 5) [10, 15, 20].forEach(function (d) {
    var th = [t1, t1 + d, t1 + 2 * d], r = evalParams(syms, wCal, th).train;
    if (r.n >= 30 && (!best || r.z > best.z)) best = { th: th, z: r.z };
  });
  var thCal = best ? best.th : DEFTH;
  var wShr = normW(DEFW.map(function (v, i) { return 0.5 * v + 0.5 * wCal[i]; }));
  var t1s = Math.round((DEFTH[0] + thCal[0]) / 2), ds = Math.round((15 + (thCal[1] - thCal[0])) / 2), thShr = [t1s, t1s + ds, t1s + 2 * ds];
  var rDef = evalParams(syms, DEFW, DEFTH), rCal = evalParams(syms, wCal, thCal), rShr = evalParams(syms, wShr, thShr);
  var adopted = rShr.test.n >= 15 && rShr.test.excess > rDef.test.excess && rShr.test.excess > 0;
  return { z: z, mult: mult, cal: { w: obj(wCal), th: thCal }, shrunk: { w: obj(wShr), th: thShr }, def: { w: obj(DEFW), th: DEFTH },
    results: { def: rDef, cal: rCal, shrunk: rShr }, adopted: adopted, nSyms: list.length };
}

onmessage = function (ev) {
  var in_ = ev.data, uni = in_.universe, ser = in_.series, res = {}, lens = in_.lens || 'pool', fund = in_.fund || {};
  if (in_.mode === 'calib') {
    ['US', 'KR'].forEach(function (mkName) {
      var cfg = uni.markets[mkName], idx = ser[cfg.index];
      if (!idx) { res[mkName] = { error: '지수 데이터 없음' }; return; }
      var mk = Engine.marketFromConfig(cfg, ser);
      var list = uni.watch.filter(function (w) { return w.market === mkName && ser[w.sym] && w.group !== 'inverse'; });
      res[mkName] = calibrate(list, ser, mk);
    });
    postMessage({ mode: 'calib', version: Engine.VERSION, at: Date.now(), res: res });
    return;
  }
  if (in_.mode === 'edge') {
    ['US', 'KR'].forEach(function (mkName) {
      var cfg = uni.markets[mkName], idx = ser[cfg.index];
      if (!idx) { res[mkName] = { error: '지수 데이터 없음' }; return; }
      var mk = Engine.marketFromConfig(cfg, ser);
      var list = uni.watch.filter(function (w) { return w.market === mkName && ser[w.sym] && w.group !== 'inverse'; });
      var neutral = list.filter(function (w) { return w.group === 'index' || w.group === 'sector'; });
      res[mkName] = { all: edgeAnalyze(list, ser, mk, fund), neutral: edgeAnalyze(neutral, ser, mk, fund), nAll: list.length, nNeutral: neutral.length };
    });
    postMessage({ mode: 'edge', version: Engine.VERSION, res: res });
    return;
  }
  var costs = in_.costs || { US: { fee: 0.1, tax: 0 }, KR: { fee: 0.015, tax: 0.15 } };
  ['US', 'KR'].forEach(function (mkName) {
    var cfg = uni.markets[mkName], idx = ser[cfg.index];
    if (!idx) { res[mkName] = { error: '지수 데이터 없음: ' + cfg.index }; return; }
    var mk = Engine.marketFromConfig(cfg, ser);
    var list = uni.watch.filter(function (w) {
      if (w.market !== mkName || !ser[w.sym] || w.group === 'inverse') return false;
      var f = fund[w.sym];
      return lens !== 'doki' || (f && !f.na && f.hist && f.hist.length); // 도키는 적정가 이력이 있는 종목만
    });
    var neutral = list.filter(function (w) { return w.group === 'index' || w.group === 'sector'; });
    res[mkName] = {
      all: list.length ? analyze(list, ser, mk, fund, lens, costs) : null,
      neutral: neutral.length ? analyze(neutral, ser, mk, fund, lens, costs) : null
    };
  });
  postMessage({ version: Engine.VERSION, at: Date.now(), res: res });
};
