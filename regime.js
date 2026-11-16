/* regime.js - 국내 시장 국면 판별(규칙 기반). 유동성·경기·시장 내부 흐름·신용 스트레스·포지셔닝 5개 영역을 -2~+2 로 채점한다.
 * 규칙: 가격으로 계산할 수 있는 지표만 쓰고, 없는 지표는 '확인 불가'로 둔다. 모든 값은 기준일까지 알 수 있던 것만 쓴다.
 * 국내 시장에 영향을 주는 글로벌 변수(미국 금리·달러·원/달러·유가·금·구리·반도체지수·VIX)를 함께 본다.
 * 국면은 판단의 출발점이며 매수 점수에는 반영하지 않는다(과거 검증 전).
 */
(function (root) {
  'use strict';
  var R = {};
  var NAMES = { 1: '① 골디락스', 2: '② 유동성 주도 장세', 3: '③ 경기 주도 장세', 4: '④ 스태그플레이션 위험', 5: '⑤ 경기 침체·디레버리징', 6: '⑥ 초기 경기 회복', 7: '⑦ 정책 전환 기대', 8: '⑧ 혼합·전환 국면' };
  var HINT = {
    1: '유동성과 성장이 함께 받쳐 주는 구간. 일반적으로 위험자산에 우호적이라고 알려져 있습니다.',
    2: '유동성이 시장을 끌어올리는 구간. 금리·달러가 반전하면 취약할 수 있습니다.',
    3: '경기 개선이 주도하는 구간. 경기민감 업종이 상대적으로 유리하다고 알려져 있습니다.',
    4: '유동성과 성장이 모두 부담. 주식·채권 모두 불리할 수 있어 현금흐름·방어력을 중시하는 구간입니다.',
    5: '경기 둔화와 금융 스트레스가 겹친 구간. 방어와 현금 비중이 우선입니다.',
    6: '경기가 바닥을 지나는 초기 구간. 경기민감 자산의 회복 가능성을 점검합니다.',
    7: '성장은 약하지만 유동성이 개선되는 구간. 금리 하락 수혜와 성장 불확실성이 공존합니다.',
    8: '신호가 엇갈리는 구간. 방향성보다 변동성과 선별 대응이 중요합니다.'
  };
  var AREAS = [['liq', '유동성', 30], ['gro', '경기·성장', 25], ['int', '시장 내부 흐름', 20], ['str', '신용·금융 스트레스', 15], ['pos', '투자자 포지셔닝', 10]];
  R.NAMES = NAMES; R.AREAS = AREAS;

  /* ---------- 조회 도구 ---------- */
  function addDays(d, n) { return new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10); }
  function lb(a, x) { var lo = 0, hi = a.length - 1, r = -1; while (lo <= hi) { var m = (lo + hi) >> 1; if (a[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
  function Ctx(ser, mk) { this.ser = ser || {}; this.mk = mk || {}; }
  Ctx.prototype.px = function (sym, date) { // 기준일 이하 마지막 값(10일 넘게 오래된 값은 쓰지 않음)
    var s = this.ser[sym]; if (!s) return null;
    var i = lb(s.d, date); if (i < 0 || s.d[i] < addDays(date, -10)) return null;
    return { i: i, v: s.c[i], d: s.d[i] };
  };
  Ctx.prototype.diff = function (sym, date, days) { var a = this.px(sym, date), b = this.px(sym, addDays(date, -days)); return a && b && b.i < a.i ? a.v - b.v : null; };
  Ctx.prototype.pct = function (sym, date, days) { var a = this.px(sym, date), b = this.px(sym, addDays(date, -days)); return a && b && b.i < a.i && b.v > 0 && a.v > 0 ? a.v / b.v - 1 : null; };
  Ctx.prototype.rel = function (s1, s2, date, days) { var a = this.pct(s1, date, days), b = this.pct(s2, date, days); return a == null || b == null ? null : a - b; };
  Ctx.prototype.ctxAt = function (date) { var mk = this.mk.KR; return mk ? root.Engine.marketAt(mk, date) : null; };

  function stepScore(v, rules) { for (var i = 0; i < rules.length; i++) if (rules[i][0](v)) return rules[i][1]; return 0; }
  function f1(v) { return (v > 0 ? '+' : '') + v.toFixed(2); }
  function fp(v) { return (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; }

  /* ---------- 지표 정의 ---------- */
  function build(ctx, date) {
    var out = [];
    function m(area, label, v, text, score, asof, extra) { out.push({ area: area, label: label, value: v, text: v == null ? '확인 불가' : text, score: v == null ? null : score, asof: asof || '', note: extra || '' }); }
    // 유동성: 글로벌 금리·달러와 원화
    var d10 = ctx.diff('^TNX', date, 91);
    m('liq', '미 10년물 금리 3개월 변화', d10, d10 == null ? '' : f1(d10) + '%p', d10 == null ? 0 : stepScore(d10, [[function (x) { return x >= .5; }, -2], [function (x) { return x >= .2; }, -1], [function (x) { return x <= -.5; }, 2], [function (x) { return x <= -.2; }, 1]]), (ctx.px('^TNX', date) || {}).d, '글로벌 유동성 변수');
    var dx = ctx.pct('DX-Y.NYB', date, 91);
    m('liq', '달러인덱스 3개월 변화', dx, dx == null ? '' : fp(dx), dx == null ? 0 : stepScore(dx, [[function (x) { return x >= .08; }, -2], [function (x) { return x >= .04; }, -1], [function (x) { return x <= -.08; }, 2], [function (x) { return x <= -.04; }, 1]]), (ctx.px('DX-Y.NYB', date) || {}).d, '글로벌 유동성 변수');
    var d3 = ctx.diff('^IRX', date, 91);
    m('liq', '미 3개월물 금리 3개월 변화(미 정책금리 방향)', d3, d3 == null ? '' : f1(d3) + '%p', d3 == null ? 0 : stepScore(d3, [[function (x) { return x <= -.75; }, 2], [function (x) { return x <= -.3; }, 1], [function (x) { return x >= .3; }, -1]]), (ctx.px('^IRX', date) || {}).d, '글로벌 유동성 변수');
    var kw = ctx.pct('KRW=X', date, 91);
    m('liq', '원/달러 3개월 변화(+는 원화 약세)', kw, kw == null ? '' : fp(kw), kw == null ? 0 : stepScore(kw, [[function (x) { return x >= .08; }, -2], [function (x) { return x >= .05; }, -1], [function (x) { return x <= -.08; }, 2], [function (x) { return x <= -.05; }, 1]]), (ctx.px('KRW=X', date) || {}).d);
    // 경기·성장: 수출·글로벌 경기 대리 변수
    var a10 = ctx.px('^TNX', date), a3 = ctx.px('^IRX', date), cv = a10 && a3 ? a10.v - a3.v : null;
    m('gro', '미 10년-3개월 금리차(%p)', cv, cv == null ? '' : f1(cv) + '%p', cv == null ? 0 : stepScore(cv, [[function (x) { return x < -.5; }, -2], [function (x) { return x < 0; }, -1], [function (x) { return x >= 1; }, 1]]), a10 && a10.d, '글로벌 경기 대리 변수');
    var cu = ctx.px('HG=F', date), au = ctx.px('GC=F', date), cu0 = ctx.px('HG=F', addDays(date, -91)), au0 = ctx.px('GC=F', addDays(date, -91)), cg = null;
    if (cu && au && cu0 && au0 && au.v > 0 && au0.v > 0 && cu0.v > 0) cg = (cu.v / au.v) / (cu0.v / au0.v) - 1;
    m('gro', '구리/금 비율 3개월 변화(경기 민감도)', cg, cg == null ? '' : fp(cg), cg == null ? 0 : stepScore(cg, [[function (x) { return x >= .08; }, 1], [function (x) { return x <= -.08; }, -1]]), cu && cu.d, '글로벌 경기 대리 변수');
    var sx = ctx.pct('^SOX', date, 91);
    m('gro', '필라델피아 반도체지수 3개월 변화(수출 대리)', sx, sx == null ? '' : fp(sx), sx == null ? 0 : stepScore(sx, [[function (x) { return x <= -.2; }, -2], [function (x) { return x <= -.1; }, -1], [function (x) { return x >= .1; }, 1]]), (ctx.px('^SOX', date) || {}).d, '국내 반도체 업황의 대리 변수');
    // 시장 내부 흐름
    var ip = ctx.px('^KS11', date), s = ctx.ser['^KS11'], i2 = ip ? ip.i : -1;
    var ma200 = null, rising = false;
    if (s && i2 >= 220) { var t = 0, t0 = 0, k; for (k = i2 - 199; k <= i2; k++) t += s.c[k]; for (k = i2 - 219; k <= i2 - 20; k++) t0 += s.c[k]; ma200 = t / 200; rising = ma200 > t0 / 200; }
    var dv = ma200 ? ip.v / ma200 - 1 : null;
    m('int', '코스피 200일선 대비', dv, dv == null ? '' : fp(dv) + (rising ? ' · 200일선 상승' : ' · 200일선 하락'), dv == null ? 0 : (dv < -.05 ? -2 : dv < 0 ? -1 : rising ? 1 : 0), ip && ip.d);
    var cx = ctx.ctxAt(date), bd = cx ? cx.brd : null;
    m('int', '시장 폭(국내 섹터 ETF 중 52주 고점 -10%↓ 비율)', bd, bd == null ? '' : (bd * 100).toFixed(0) + '%', bd == null ? 0 : stepScore(bd, [[function (x) { return x >= .6; }, -2], [function (x) { return x >= .4; }, -1], [function (x) { return x <= .1; }, 1]]), ip && ip.d);
    var rl = ctx.rel('^KQ11', '^KS11', date, 91);
    m('int', '코스닥 vs 코스피 3개월 상대(%p)', rl, rl == null ? '' : fp(rl), rl == null ? 0 : stepScore(rl, [[function (x) { return x >= .03; }, 1], [function (x) { return x <= -.03; }, -1]]), ip && ip.d);
    var dd = null; if (s && i2 >= 252) { var mx = -Infinity; for (var z = i2 - 251; z <= i2; z++) if (s.c[z] > mx) mx = s.c[z]; dd = 1 - ip.v / mx; }
    m('int', '코스피 52주 고점 대비 낙폭', dd, dd == null ? '' : (dd * 100).toFixed(1) + '%', dd == null ? 0 : (dd >= .2 ? -2 : dd >= .1 ? -1 : dd <= .03 ? 1 : 0), ip && ip.d);
    // 스트레스
    var vp = cx ? cx.pct : null;
    m('str', '코스피 20일 실현변동성 백분위', vp, vp == null ? '' : (vp * 100).toFixed(0) + '백분위', vp == null ? 0 : stepScore(vp, [[function (x) { return x >= .9; }, -2], [function (x) { return x >= .75; }, -1], [function (x) { return x < .3; }, 1]]), ip && ip.d);
    var vx = ctx.px('^VIX', date);
    m('str', 'VIX(글로벌 위험 회피)', vx && vx.v, vx ? vx.v.toFixed(1) : '', vx ? stepScore(vx.v, [[function (x) { return x >= 30; }, -2], [function (x) { return x >= 22; }, -1], [function (x) { return x < 15; }, 1]]) : 0, vx && vx.d, '글로벌 위험 변수');
    var k1 = ctx.pct('KRW=X', date, 30);
    m('str', '원/달러 1개월 변화(+는 원화 약세)', k1, k1 == null ? '' : fp(k1), k1 == null ? 0 : stepScore(k1, [[function (x) { return x >= .05; }, -2], [function (x) { return x >= .03; }, -1]]), (ctx.px('KRW=X', date) || {}).d);
    // 포지셔닝(역발상: 공포가 크면 포지션이 줄어든 상태로 보아 +, 탐욕이 크면 -)
    var fr = cx ? cx.fear : null;
    m('pos', '자체 공포지수(0~100, 높을수록 공포·역발상 해석)', fr, fr == null ? '' : fr.toFixed(0), fr == null ? 0 : (fr >= 75 ? 1 : fr <= 25 ? -1 : 0), ip && ip.d);
    return out;
  }

  function areaScores(metrics) {
    var areas = [];
    AREAS.forEach(function (a) {
      var ms = metrics.filter(function (x) { return x.area === a[0]; }), av = ms.filter(function (x) { return x.score != null; });
      var sc = av.length ? av.reduce(function (s, x) { return s + x.score; }, 0) / av.length : null;
      areas.push({ key: a[0], name: a[1], weight: a[2], score: sc, n: av.length, total: ms.length, metrics: ms });
    });
    return areas;
  }
  function evalLabel(v) { return v == null ? '확인 불가' : v >= 1 ? '긍정' : v >= .3 ? '완만한 긍정' : v > -.3 ? '중립·혼재' : v > -1 ? '완만한 부정' : '부정'; }

  function classify(L, G, M, S, prevG) {
    L = L == null ? 0 : L; G = G == null ? 0 : G; M = M == null ? 0 : M; S = S == null ? 0 : S;
    if (S <= -1.2 && G <= -.8) return 5;
    if (L <= -.5 && G <= -.3) return 4;
    if (G <= -.3 && L >= .5) return 7;
    if (L >= .5 && G >= .5 && S >= -.3) return 1;
    if (L >= .5) return 2;
    if (G >= .5) return 3;
    if (prevG != null && prevG <= -.5 && G > -.3 && M >= .3) return 6;
    return 8;
  }
  function snapshot(ctx, date) {
    var metrics = build(ctx, date), areas = areaScores(metrics), by = {};
    areas.forEach(function (a) { by[a.key] = a.score; });
    var prevG = null; areaScores(build(ctx, addDays(date, -91))).forEach(function (a) { if (a.key === 'gro') prevG = a.score; });
    var wsum = 0, tot = 0, cov = 0;
    areas.forEach(function (a) { if (a.score != null) { wsum += a.weight; tot += a.weight * a.score; } cov += a.weight * (a.total ? a.n / a.total : 0); });
    return { metrics: metrics, areas: areas, total: wsum ? tot / wsum : null, coverage: cov / 100, id: classify(by.liq, by.gro, by.int, by.str, prevG), by: by };
  }

  /* ---------- 공개 API ---------- */
  R.analyze = function (ser, mk, date) {
    var ctx = new Ctx(ser, mk), now = snapshot(ctx, date), prev = snapshot(ctx, addDays(date, -30));
    var contrib = [];
    now.areas.forEach(function (a) { a.metrics.forEach(function (x) { if (x.score != null && x.score !== 0) contrib.push({ x: x, w: Math.abs(x.score) * a.weight / Math.max(1, a.n) }); }); });
    contrib.sort(function (p, q) { return q.w - p.w; });
    var drivers = contrib.slice(0, 3).map(function (c) { return c.x.label + ' ' + c.x.text; });
    var border = 0; ['liq', 'gro'].forEach(function (k) { var v = now.by[k]; if (v != null && Math.abs(Math.abs(v) - .5) <= .3) border++; });
    var unavailable = ['공급자관리지수(PMI)·수출 통계(속보치)', '기업이익 전망·가이던스', '외국인·기관 수급, 공매도·대차, 신용융자(공식 자료 접근이 불안정해 미사용)', '국내 신용스프레드·한국은행 금융여건', 'CNN 공포탐욕 지수(접근 제한 우려로 미사용)'];
    var conf = now.coverage >= .75 ? '보통' : '낮음'; // 확인 불가 항목이 항상 있으므로 '높음'은 부여하지 않는다
    return {
      date: date, id: now.id, name: NAMES[now.id], hint: HINT[now.id], areas: now.areas, total: now.total, coverage: now.coverage,
      confidence: conf, prevId: prev.id, prevName: NAMES[prev.id], transition: border >= 2 ? '높음' : border === 1 ? '보통' : '낮음',
      drivers: drivers, unavailable: unavailable, evalLabel: evalLabel
    };
  };
  // 월말 시점별 국면과 이후 3개월 코스피 수익(2008~): 국면이 '상황 설명'인지 '신호'인지 확인용
  R.history = function (ser, mk) {
    var s = ser['^KS11']; if (!s) return null;
    var ctx = new Ctx(ser, mk), res = {}, n = s.d.length, all = [], lastIdx = {}, i;
    for (i = 0; i < n; i++) lastIdx[s.d[i].slice(0, 7)] = i;
    Object.keys(lastIdx).sort().forEach(function (ym) {
      var j = lastIdx[ym], date = s.d[j]; if (date < '2008-01-01') return;
      var tgt = lb(s.d, addDays(date, 91)); if (tgt < 0 || s.d[tgt] < addDays(date, 85) || tgt === j) return;
      var snap = snapshot(ctx, date), f = s.c[tgt] / s.c[j] - 1;
      (res[snap.id] = res[snap.id] || []).push(f); all.push(f);
    });
    function agg(a) { var up = a.filter(function (x) { return x > 0; }).length; return { n: a.length, up: a.length ? up / a.length : null, mean: a.length ? a.reduce(function (p, q) { return p + q; }, 0) / a.length : null }; }
    var rows = {}; Object.keys(NAMES).forEach(function (k) { rows[k] = agg(res[k] || []); });
    return { rows: rows, all: agg(all) };
  };
  root.Regime = R;
  if (typeof module !== 'undefined') module.exports = R;
})(typeof self !== 'undefined' ? self : this);
