/* engine.js - 점수 엔진. 라이브 추천과 백테스트가 같은 코드를 쓰도록 브라우저와 Web Worker 양쪽에서 동작한다.
 * 규칙: 모든 지표는 해당 시점(i)까지의 데이터만 사용한다(룩어헤드 금지).
 * 현재 구현 범위: '웅덩이' 관점(하락 구간 분할매수). 도키(적정가)·통합 관점은 다음 단계.
 */
(function (root) {
  'use strict';
  var E = { VERSION: 5 };

  /* ---------- 지표 ---------- */
  function sma(c, n) {
    var o = new Array(c.length).fill(null), s = 0;
    for (var i = 0; i < c.length; i++) {
      s += c[i];
      if (i >= n) s -= c[i - n];
      if (i >= n - 1) o[i] = s / n;
    }
    return o;
  }
  function ema(c, n) {
    var o = new Array(c.length).fill(null), k = 2 / (n + 1), p = null;
    for (var i = 0; i < c.length; i++) {
      p = p === null ? c[i] : c[i] * k + p * (1 - k);
      if (i >= n - 1) o[i] = p;
    }
    return o;
  }
  function rsi(c, n) { // 와일더
    var o = new Array(c.length).fill(null), g = 0, l = 0;
    for (var i = 1; i < c.length; i++) {
      var d = c[i] - c[i - 1], up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
      if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
      else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    }
    return o;
  }
  function rollMin(c, n) {
    var o = new Array(c.length).fill(null);
    for (var i = 0; i < c.length; i++) {
      var m = Infinity;
      for (var j = Math.max(0, i - n + 1); j <= i; j++) if (c[j] < m) m = c[j];
      o[i] = m;
    }
    return o;
  }
  function rollMax(c, n) {
    var o = new Array(c.length).fill(null);
    for (var i = 0; i < c.length; i++) {
      var m = -Infinity;
      for (var j = Math.max(0, i - n + 1); j <= i; j++) if (c[j] > m) m = c[j];
      o[i] = m;
    }
    return o;
  }
  // 주봉 RSI: 완료된 주만 확정하고 진행 중인 주는 현재가로 갱신한다. 일별 값으로 되돌려 반환.
  function weekKey(d) { // 월요일 시작 주 식별자
    var t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    var dow = (new Date(t).getUTCDay() + 6) % 7;
    return Math.floor((t - dow * 86400000) / 86400000);
  }
  function weeklyRsi(dates, c, n) {
    var out = new Array(c.length).fill(null), wc = [], wk = [], lastW = null;
    var g = 0, l = 0, cnt = 0, ag = null, al = null, prevClose = null;
    for (var i = 0; i < c.length; i++) {
      var k = weekKey(dates[i]);
      if (k !== lastW) { // 새 주 시작: 직전 주 확정
        if (lastW !== null) {
          var fin = wc[wc.length - 1];
          if (prevClose !== null) {
            var d = fin - prevClose, up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
            cnt++;
            if (cnt <= n) { g += up; l += dn; if (cnt === n) { ag = g / n; al = l / n; } }
            else { ag = (ag * (n - 1) + up) / n; al = (al * (n - 1) + dn) / n; }
          }
          prevClose = fin;
        }
        wc.push(c[i]); lastW = k;
      } else wc[wc.length - 1] = c[i];
      // 진행 주를 현재가로 가정한 RSI(미확정 값은 저장하지 않는다)
      if (prevClose !== null && ag !== null) {
        var d2 = c[i] - prevClose, u2 = d2 > 0 ? d2 : 0, n2 = d2 < 0 ? -d2 : 0;
        var tg = (ag * (n - 1) + u2) / n, tl = (al * (n - 1) + n2) / n;
        out[i] = tl === 0 ? 100 : 100 - 100 / (1 + tg / tl);
      }
    }
    return out;
  }

  /* ---------- 시장 컨텍스트 ---------- */
  // 시장별로 분리: US 는 VIX, KR 는 지수의 20일 실현변동성(연환산) 백분위.
  function buildMarket(kind, idx, volSeries) {
    var n = idx.c.length, vol = new Array(n).fill(null), dd = new Array(n).fill(0), i;
    var mx = rollMax(idx.c, 252);
    for (i = 0; i < n; i++) dd[i] = 1 - idx.c[i] / mx[i];
    if (kind === 'vix' && volSeries) {
      var map = {}; volSeries.d.forEach(function (d, j) { map[d] = volSeries.c[j]; });
      var last = null;
      for (i = 0; i < n; i++) { if (map[idx.d[i]] != null) last = map[idx.d[i]]; vol[i] = last; }
      return { kind: 'vix', vol: vol, dd: dd, dates: idx.d };
    }
    // 실현변동성 백분위(해당 시점까지의 이력 안에서만 계산)
    var rv = new Array(n).fill(null);
    for (i = 20; i < n; i++) {
      var s = 0, s2 = 0;
      for (var j = i - 19; j <= i; j++) { var r = Math.log(idx.c[j] / idx.c[j - 1]); s += r; s2 += r * r; }
      var m = s / 20; rv[i] = Math.sqrt(Math.max(0, s2 / 20 - m * m)) * Math.sqrt(252) * 100;
    }
    var pct = new Array(n).fill(null), hist = [];
    for (i = 0; i < n; i++) {
      if (rv[i] == null) continue;
      if (hist.length >= 250) { var below = 0; for (var h = 0; h < hist.length; h++) if (hist[h] <= rv[i]) below++; pct[i] = below / hist.length; }
      hist.push(rv[i]);
    }
    return { kind: 'realized', vol: rv, pct: pct, dd: dd, dates: idx.d };
  }
  function marketAt(mk, date) { // 날짜로 컨텍스트 조회(해당일 이하 마지막 값)
    var a = mk.dates, lo = 0, hi = a.length - 1, r = -1;
    while (lo <= hi) { var m = (lo + hi) >> 1; if (a[m] <= date) { r = m; lo = m + 1; } else hi = m - 1; }
    if (r < 0) return null;
    return { i: r, vol: mk.vol[r], pct: mk.pct ? mk.pct[r] : null, dd: mk.dd[r] };
  }

  /* ---------- 준비/신호 ---------- */
  E.prepare = function (s) {
    var c = s.c;
    var mc = ema(c, 12), ml = ema(c, 26), macd = c.map(function (_, i) { return mc[i] != null && ml[i] != null ? mc[i] - ml[i] : null; });
    var sig = ema(macd.map(function (v) { return v == null ? 0 : v; }), 9);
    return {
      s: s, sma20: sma(c, 20), sma200: sma(c, 200), rsi: rsi(c, 14), wrsi: weeklyRsi(s.d, c, 14),
      max252: rollMax(c, 252), min252: rollMin(c, 252), macd: macd, macdSig: sig, fairAdj: null
    };
  };
  function step(v, pts) { // pts: [[임계, 강도], ...] 임계 내림차순
    for (var i = 0; i < pts.length; i++) if (v >= pts[i][0]) return pts[i][1];
    return 0;
  }
  var W = { dd: 25, dev: 10, wrsi: 15, rsi: 5, macd: 10, vol: 20, idx: 15 };
  E.WEIGHTS = W;

  E.signalsAt = function (P, i, mk, lev, weights) {
    var w = weights || W, s = P.s, c = s.c[i], L = Math.max(1, lev || 1), out = [];
    function add(key, label, strength, detail) { out.push({ key: key, label: label, strength: strength, weight: w[key], detail: detail }); }
    var dd = (1 - c / P.max252[i]) / L;
    add('dd', '낙폭(52주 고점 대비' + (L > 1 ? ', 배율 환산' : '') + ')', step(dd, [[.3, 1], [.2, .8], [.1, .48]]), (dd * 100).toFixed(1) + '%');
    var dev = P.sma200[i] ? c / P.sma200[i] - 1 : null; var devL = dev == null ? null : dev / L;
    add('dev', '200일선 이격', devL == null ? 0 : step(-devL, [[.15, 1], [.1, .7], [.05, .4]]), devL == null ? '데이터 부족' : (devL * 100).toFixed(1) + '%');
    var wr = P.wrsi[i];
    add('wrsi', '주봉 RSI', wr == null ? 0 : wr < 30 ? 1 : wr < 35 ? .8 : wr < 45 ? .45 : 0, wr == null ? '데이터 부족' : wr.toFixed(1));
    var dr = P.rsi[i];
    add('rsi', '일봉 RSI', dr == null ? 0 : dr < 30 ? 1 : dr < 40 ? .5 : 0, dr == null ? '데이터 부족' : dr.toFixed(1));
    var mc = 0;
    for (var j = Math.max(1, i - 9); j <= i; j++) {
      if (P.macd[j] != null && P.macd[j - 1] != null && P.macdSig[j] != null && P.macd[j - 1] <= P.macdSig[j - 1] && P.macd[j] > P.macdSig[j] && P.macd[j] < 0) mc = .6;
    }
    add('macd', 'MACD 골든크로스(10거래일 내, 0선 아래)', mc, mc ? '발생' : '없음');
    var m = marketAt(mk, s.d[i]);
    if (mk.kind === 'vix') {
      var v = m && m.vol;
      add('vol', 'VIX', v == null ? 0 : step(v, [[40, 1], [30, .8], [25, .5]]), v == null ? '데이터 없음' : v.toFixed(1));
    } else {
      var p = m && m.pct;
      add('vol', '자체 변동성(코스피 20일 실현변동성 백분위)', p == null ? 0 : step(p, [[.95, 1], [.85, .8], [.75, .5]]), p == null ? '이력 부족' : (p * 100).toFixed(0) + '백분위');
    }
    var idd = m ? m.dd : 0;
    add('idx', '시장 지수 낙폭', step(idd, [[.2, 1], [.1, .5]]), (idd * 100).toFixed(1) + '%');
    return out;
  };

  /* ---------- 점수/차수 ---------- */
  E.DEFAULT_TH = [40, 55, 70];
  E.evaluate = function (P, i, mk, opt) {
    opt = opt || {};
    var lev = opt.lev || 1, th = opt.th || E.DEFAULT_TH;
    var sg = E.signalsAt(P, i, mk, lev, opt.weights), score = 0;
    sg.forEach(function (x) { score += x.strength * x.weight; });
    score = Math.min(100, Math.round(score * 10) / 10);
    var wr = P.wrsi[i], overheat = wr != null && wr >= 70;
    var tier = score >= th[2] ? 3 : score >= th[1] ? 2 : score >= th[0] ? 1 : 0;
    var notes = [];
    if (opt.inverse) { tier = 0; notes.push('인버스 상품은 장기 보유에 부적합하여 매수 추천에서 제외'); }
    if (lev >= 3 && tier > 2) { tier = 2; notes.push('3배 레버리지는 2차까지로 제한'); }
    if (overheat) { tier = 0; notes.push('주봉 RSI 70 이상 과열: 신규 매수 중단'); }
    return { score: score, tier: tier, overheat: overheat, signals: sg, notes: notes };
  };

  /* ---------- 도키 관점: 적정가·저점 위치·과매수 회피·200일선 지지 ---------- */
  function lowerBound(a, x) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  // 공시일(filed) '다음 거래일부터' 해당 적정가를 쓴다(룩어헤드 방지).
  // 액면분할 등으로 가격 척도가 바뀌어도 비교가 맞도록, 공시일의 수정주가/원주가 비율로 적정가를 수정주가 척도로 환산한다.
  E.attachFund = function (P, f) {
    var s = P.s, n = s.c.length;
    P.fairAdj = null; P.fundNA = !!(f && f.na);
    if (!f || f.na || !f.hist || !f.hist.length) return P;
    var recs = f.hist.filter(function (h) { return h.fair > 0 && h.filed; }).sort(function (a, b) { return a.filed < b.filed ? -1 : 1; }).map(function (h) {
      var j = lowerBound(s.d, h.filed); if (j >= n) return null;
      var raw = s.raw ? s.raw[j] : s.c[j];
      return { j: j, fa: h.fair * (s.c[j] / raw) };
    }).filter(Boolean);
    if (!recs.length) return P;
    var out = new Array(n).fill(null), k = -1;
    for (var i = 0; i < n; i++) {
      while (k + 1 < recs.length && recs[k + 1].j < i) k++;
      if (k >= 0) out[i] = recs[k].fa;
    }
    P.fairAdj = out;
    return P;
  };
  var DW = { val: 35, pos: 25, rsi: 15, sup: 25 };
  E.DOKI_W = DW; E.DOKI_TH = [35, 50, 65]; E.BOTH_TH = [45, 60, 75];

  E.evaluateDoki = function (P, i, mk, opt) {
    opt = opt || {};
    var th = opt.th || E.DOKI_TH, c = P.s.c[i], lev = opt.lev || 1, sg = [], notes = [];
    function add(key, label, st, detail, na) { sg.push({ key: key, label: label, strength: st, weight: DW[key], detail: detail, na: !!na }); }
    var fa = P.fairAdj ? P.fairAdj[i] : null, ratio = fa ? c / fa : null;
    add('val', '적정가 대비 가격(영업현금흐름 기반)', ratio == null ? 0 : ratio <= .7 ? 1 : ratio <= .85 ? .75 : ratio <= 1 ? .45 : 0,
      ratio == null ? (P.fundNA ? '해당 없음(금융업)' : '적정가 없음') : '적정가의 ' + (ratio * 100).toFixed(0) + '%', ratio == null);
    var lo = P.min252[i], hi = P.max252[i], pos = hi > lo ? (c - lo) / (hi - lo) : .5;
    add('pos', '저점 위치(52주 범위 안)', pos <= .2 ? 1 : pos <= .35 ? .6 : pos <= .5 ? .25 : 0, (pos * 100).toFixed(0) + '% 지점');
    var dr = P.rsi[i];
    add('rsi', '과매수 회피(일봉 RSI)', dr == null ? 0 : dr < 50 ? 1 : dr < 60 ? .5 : 0, dr == null ? '데이터 부족' : dr.toFixed(1));
    var sm = P.sma200[i], dev = sm ? c / sm - 1 : null, rising = sm && i >= 20 && P.sma200[i - 20] != null && sm >= P.sma200[i - 20];
    add('sup', '200일선 지지(±5% 이내, 200일선 상승 중)', dev != null && Math.abs(dev) <= .05 && rising ? 1 : 0, dev == null ? '데이터 부족' : (dev * 100).toFixed(1) + '%' + (rising ? ', 상승' : ', 하락'));
    var aw = 0, raw = 0;
    sg.forEach(function (x) { if (!x.na) { aw += x.weight; raw += x.strength * x.weight; } });
    var score = aw ? raw / aw * 100 : 0, capped1 = false;
    if (ratio != null && ratio > 1.3) { score -= 15; capped1 = true; notes.push('고평가(적정가의 130% 초과): 감점 15, 1차로 제한'); }
    score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));
    var tier = score >= th[2] ? 3 : score >= th[1] ? 2 : score >= th[0] ? 1 : 0;
    var wr = P.wrsi[i], overheat = wr != null && wr >= 70;
    if (capped1 && tier > 1) tier = 1;
    if (lev >= 3 && tier > 2) { tier = 2; notes.push('3배 레버리지는 2차까지로 제한'); }
    if (opt.inverse) { tier = 0; notes.push('인버스 상품은 매수 추천에서 제외'); }
    if (overheat) { tier = 0; notes.push('주봉 RSI 70 이상 과열: 신규 매수 중단'); }
    if (ratio == null) notes.push('적정가가 없어 나머지 항목만으로 정규화한 점수입니다');
    return { score: score, tier: tier, overheat: overheat, signals: sg, notes: notes, hasFair: ratio != null, capped1: capped1, ratio: ratio };
  };

  // 통합: 두 점수의 평균 + 두 관점이 동의하면 가점, 한쪽이 매우 낮으면 감점
  E.evaluateBoth = function (P, i, mk, opt) {
    opt = opt || {};
    var a = E.evaluate(P, i, mk, { lev: opt.lev, inverse: opt.inverse, weights: opt.weights, th: opt.poolTh }), b = E.evaluateDoki(P, i, mk, { lev: opt.lev, inverse: opt.inverse });
    var notes = [], score, th;
    if (!b.hasFair) { score = a.score; th = opt.th || E.DEFAULT_TH; notes.push('적정가가 없어 웅덩이 점수만 반영했습니다'); }
    else {
      th = opt.th || E.BOTH_TH; score = (a.score + b.score) / 2;
      if (a.tier >= 1 && b.tier >= 1) { score += 5; notes.push('두 관점이 모두 신호: 가점 +5'); }
      if (Math.min(a.score, b.score) < 20) { score -= 10; notes.push('한쪽 점수가 매우 낮음: 감점 -10'); }
    }
    score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));
    var tier = score >= th[2] ? 3 : score >= th[1] ? 2 : score >= th[0] ? 1 : 0;
    if (b.capped1 && tier > 1) tier = 1;
    if ((opt.lev || 1) >= 3 && tier > 2) tier = 2;
    if (opt.inverse || a.overheat) tier = 0;
    if (a.overheat) notes.push('주봉 RSI 70 이상 과열: 신규 매수 중단');
    return { score: score, tier: tier, overheat: a.overheat, signals: [], parts: { a: a, b: b }, notes: notes.concat(b.capped1 ? ['고평가: 1차로 제한'] : []), hasFair: b.hasFair };
  };
  E.evaluateBy = function (lens, P, i, mk, opt) {
    return lens === 'doki' ? E.evaluateDoki(P, i, mk, opt) : lens === 'both' ? E.evaluateBoth(P, i, mk, opt) : E.evaluate(P, i, mk, opt);
  };

  E.fwd = function (c, i, h) { // 다음 거래일 종가 체결 가정: i+1 진입, i+1+h 청산
    var a = i + 1, b = i + 1 + h;
    return b < c.length ? c[b] / c[a] - 1 : null;
  };

  E.buildMarket = buildMarket;
  E.marketAt = marketAt;
  E.sma = sma;

  root.Engine = E;
  if (typeof module !== 'undefined') module.exports = E;
})(typeof self !== 'undefined' ? self : this);
