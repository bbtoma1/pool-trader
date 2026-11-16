/* app.js - 모바일 우선 UI. 데이터 우선순위: 같은 출처 data/ → IndexedDB 마지막 정상 저장본. */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var S = { uni: null, man: null, ser: {}, src: {}, mk: {}, ev: {}, mkt: 'KR', lens: 'pool', fund: {}, tab: 'today', sel: null, bt: null, btBusy: false };
  var LENS = { pool: '웅덩이', doki: '도키', both: '통합' };
  var FRESH_DAYS = 10; // 신호가 켜진 뒤 이 거래일 수(0부터 세어 10 → 11번째 거래일)까지를 '신규'로 본다
  var CAL_KEY = 'trader-calib-v' + Engine.VERSION, USECAL_KEY = 'trader-usecal';
  S.calib = null; S.calibBusy = false; S.useCal = lsGet(USECAL_KEY) === '1';
  try { var cc = lsGet(CAL_KEY); if (cc) S.calib = JSON.parse(cc); } catch (e) { }
  // 채택된 시장에만 보정값(수축 적용)을 쓴다. 웅덩이 점수 계산(웅덩이·통합 관점의 웅덩이 부분)에만 반영된다.
  function calOpt(w) {
    var o = { lev: w.lev, inverse: w.group === 'inverse' };
    var r = S.useCal && S.calib && S.calib.res && S.calib.res[w.market];
    if (r && r.adopted) { o.weights = r.shrunk.w; if (S.lens === 'pool') o.th = r.shrunk.th; else o.poolTh = r.shrunk.th; }
    return o;
  }
  var ACCT_KEY = 'trader-acct-v1', BT_KEY = 'trader-bt-v';
  var RATIO = [0.2, 0.3, 0.5]; // 차수별 가용 현금 사용 비율

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fname(sym) { return sym.replace('^', '_') + '.json'; }
  function money(v, cur) { return cur === 'KRW' ? Math.round(v).toLocaleString('ko-KR') + '원' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(v, d) { return (v > 0 ? '+' : '') + (v * 100).toFixed(d == null ? 2 : d) + '%'; }
  function cls(v) { return v > 0 ? 'up' : v < 0 ? 'down' : ''; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

  /* ---- IndexedDB(마지막 정상 저장본) ---- */
  function idb() { return new Promise(function (res, rej) { var r = indexedDB.open('trader', 1); r.onupgradeneeded = function () { r.result.createObjectStore('px'); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function idbGet(k) { return idb().then(function (d) { return new Promise(function (res) { var q = d.transaction('px').objectStore('px').get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; }); }).catch(function () { return null; }); }
  function idbSet(k, v) { return idb().then(function (d) { d.transaction('px', 'readwrite').objectStore('px').put(v, k); }).catch(function () { }); }

  function getJson(url) { return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

  function loadAll() {
    $('#fresh').textContent = '불러오는 중'; $('#fresh').className = 'chip';
    return getJson('data/universe.json').then(function (u) {
      S.uni = u;
      return getJson('data/manifest.json').catch(function () { return null; });
    }).then(function (man) {
      S.man = man;
      var syms = S.uni.helpers.concat(S.uni.watch.map(function (w) { return w.sym; }));
      var v = man && man.updated ? man.updated : 0;
      return Promise.all(syms.map(function (sym) {
        return getJson('data/px/' + fname(sym) + '?v=' + v).then(function (j) { S.ser[sym] = j; S.src[sym] = 'net'; idbSet(sym, j); })
          .catch(function () { return idbGet(sym).then(function (j) { if (j) { S.ser[sym] = j; S.src[sym] = 'cache'; } }); });
      }));
    }).then(function () { return getJson('data/fund.json').catch(function () { return {}; }); }).then(function (f) {
      S.fund = f || {};
      return Promise.all([getJson('data/tracker_kr.json').catch(function () { return null; }), getJson('data/tracker_status.json').catch(function () { return null; })]);
    }).then(function (t) {
      S.trk = t[0]; S.trkSt = t[1]; compute(); chip(); render();
    }).catch(function (e) {
      $('#fresh').textContent = '데이터 없음'; $('#fresh').className = 'chip late';
      $('#view').innerHTML = '<div class="note">데이터를 불러오지 못했습니다. <code>python tools/update_data.py</code> 실행 후 <code>python server.py</code> 로 열어 주세요. (' + esc(e.message) + ')</div>';
    });
  }

  function compute() {
    S.mk = {}; S.ev = {}; S.reg = null;
    Object.keys(S.uni.markets).forEach(function (m) {
      var cfg = S.uni.markets[m], idx = S.ser[cfg.index];
      if (!idx) return;
      S.mk[m] = Engine.marketFromConfig(cfg, S.ser);
      S.uni.watch.filter(function (w) { return w.market === m && S.ser[w.sym]; }).forEach(function (w) {
        var s = S.ser[w.sym], P = Engine.attachFund(Engine.prepare(s), S.fund[w.sym]), i = s.c.length - 1, opt = calOpt(w);
        var ev = Engine.evaluateBy(S.lens, P, i, S.mk[m], opt);
        // 신호 구간의 시작일: 신호가 없던 날이 20일 이상 이어진 뒤 처음 켜진 날(검증의 '새 웅덩이'와 같은 규칙). 최근 300거래일로 계산.
        var i0 = Math.max(260, i - 300), quiet = 999, start = -1;
        for (var j = i0; j <= i; j++) {
          var t = j === i ? ev.tier : Engine.evaluateBy(S.lens, P, j, S.mk[m], opt).tier;
          if (t > 0) { if (quiet >= 20 || start < 0) start = j; quiet = 0; } else quiet++;
        }
        var age = ev.tier > 0 && start >= 0 ? i - start : null;
        S.ev[w.sym] = { P: P, w: w, i: i, ev: ev, age: age, ageMin: start === i0 && age !== null, fresh: age !== null && age <= FRESH_DAYS };
      });
    });
  }

  function chip() {
    var el = $('#fresh');
    if (!S.man || !S.man.updated) { el.textContent = '갱신 시각 불명'; el.className = 'chip late'; return; }
    var h = (Date.now() / 1000 - S.man.updated) / 3600, cache = Object.keys(S.src).some(function (k) { return S.src[k] === 'cache'; });
    el.textContent = (cache ? '저장본 · ' : '') + (h < 1 ? '방금 갱신' : h < 48 ? Math.floor(h) + '시간 전' : Math.floor(h / 24) + '일 전');
    el.className = 'chip ' + (h < 30 && !cache ? 'ok' : 'late');
  }

  /* ---- 화면 ---- */
  function render() {
    if (!S.uni) return;
    var v = $('#view');
    if (S.tab === 'today') v.innerHTML = viewToday();
    else if (S.tab === 'stock') { v.innerHTML = viewStock(); drawChart(); }
    else if (S.tab === 'market') v.innerHTML = viewMarket();
    else if (S.tab === 'tracker') v.innerHTML = viewTracker();
    else if (S.tab === 'verify') { v.innerHTML = viewVerify(); bindCost(); if (!S.bt && !S.btBusy) runBt(false); }
    else { v.innerHTML = viewAcct(); bindAcct(); calcAcct(); }
    window.scrollTo(0, 0);
  }
  function visible() { return S.uni.watch.filter(function (w) { return S.ev[w.sym] && (S.mkt === 'ALL' || w.market === S.mkt); }); }
  function last(sym) { var s = S.ser[sym], i = s.c.length - 1; return { c: s.c[i], p: s.c[i - 1], d: s.d[i], raw: (s.raw || s.c)[i] }; }

  function viewToday() {
    var html = '', mk = ['KR'];
    mk.forEach(function (m) {
      var cfg = S.uni.markets[m], idx = S.ser[cfg.index], c = S.mk[m];
      if (!idx || !c) return;
      var i = idx.c.length - 1, ch = idx.c[i] / idx.c[i - 1] - 1;
      var volTxt = cfg.volType === 'vix' ? 'VIX ' + (c.vol[i] == null ? '-' : c.vol[i].toFixed(1)) : '변동성 ' + (c.pct[i] == null ? '-' : Math.round(c.pct[i] * 100) + '백분위');
      html += '<h2>' + (m === 'US' ? '미국' : '국내') + ' 시장 온도</h2><div class="grid">'
        + '<div class="card kpi"><div class="l">' + (cfg.index === '^KS11' ? '코스피' : esc(cfg.index)) + ' (' + idx.d[i] + ')</div><div class="v num ' + cls(ch) + '">' + idx.c[i].toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + '</div><div class="num ' + cls(ch) + '">' + pct(ch) + '</div></div>'
        + '<div class="card kpi"><div class="l">' + volTxt + '</div><div class="v num">' + (c.dd[i] * 100).toFixed(1) + '%</div><div class="muted">지수 52주 낙폭</div></div></div>';
    });
    html += '<h2>오늘의 행동</h2>';
    var list = visible().sort(function (a, b) { return S.ev[b.sym].ev.score - S.ev[a.sym].ev.score; });
    function row(w) {
      var d = S.ev[w.sym], e = d.ev, L = last(w.sym), ch = L.c / L.p - 1;
      var age = d.age !== null ? (d.fresh ? '신규 ' : '지속 ') + (d.ageMin ? (d.age + '일+') : (d.age + 1) + '일째') + ' · ' : '';
      var badge = e.overheat ? '<span class="badge hot">과열 · 신규 매수 중단</span>' : e.tier ? '<span class="badge ' + (d.fresh ? 't' + e.tier : '') + '">' + age + e.tier + '차</span>' : '<span class="badge">신호 없음</span>';
      var nofair = (S.lens !== 'pool' && e.hasFair === false ? ' · <span class="muted">적정가 없음</span>' : '') + (execTier(w.sym) ? ' · <b>' + execTier(w.sym) + '차 집행</b>' : '');
      return '<button class="card srow" type="button" data-sym="' + esc(w.sym) + '"><div class="ring" style="--p:' + e.score + ';--c:' + (d.fresh ? 'var(--accent)' : 'var(--muted)') + '"><span class="num">' + Math.round(e.score) + '</span></div>'
        + '<div class="nm"><b>' + esc(w.name) + '</b><span class="muted num">' + w.market + ' · ' + money(L.raw, S.uni.markets[w.market].currency) + ' <span class="' + cls(ch) + '">' + pct(ch) + '</span>' + nofair + '</span></div>' + badge + '</button>';
    }
    var fresh = list.filter(function (w) { return S.ev[w.sym].fresh && !S.ev[w.sym].ev.overheat; });
    var ongoing = list.filter(function (w) { var d = S.ev[w.sym]; return d.age !== null && !d.fresh; });
    var over = list.filter(function (w) { var d = S.ev[w.sym]; return d.fresh && d.ev.overheat; });
    var none = list.filter(function (w) { return S.ev[w.sym].age === null; });
    html += '<h3>새로 켜진 신호 <span class="muted">(켜진 지 ' + (FRESH_DAYS + 1) + '거래일 이내)</span></h3>'
      + (fresh.length ? fresh.map(row).join('') : '<div class="card muted">지금 새로 켜진 신호가 없습니다. 현금을 지키는 구간입니다.</div>');
    if (ongoing.length) html += '<h3>지속 중 <span class="muted">(켜진 지 오래됨 · 신규 진입 우위 낮음)</span></h3>' + ongoing.map(row).join('');
    if (over.length) html += '<h3>과열</h3>' + over.map(row).join('');
    if (none.length) html += '<h3>신호 없음</h3>' + none.map(row).join('');
    var calOn = S.useCal && S.calib && S.calib.res && ['KR'].filter(function (m) { return S.calib.res[m] && S.calib.res[m].adopted; });
    html += '<div class="note">' + (calOn && calOn.length ? '자동 보정값 사용 중. ' : '') + '점수는 과거 하락 구간의 겹침 정도를 숫자로 만든 것이며 투자 권유가 아닙니다. 신규/지속 구분은 참고용입니다: 이 앱의 검증에서는 신규 구간이 지속 구간보다 뚜렷하게 좋지 않았습니다(검증 탭 "경과별"). 검증 탭에서 기준선 대비 효과를 확인하세요.</div>';
    return html + foot();
  }

  /* ---- 거물·공시(DART) ---- */
  function fmtN(v) { return Math.round(v).toLocaleString('ko-KR'); }
  function mergeExec(items) { // 같은 종목·보고자·날짜의 소유보고는 합쳐서 보여 준다
    var map = {}, out = [];
    items.forEach(function (x) {
      if (x.kind !== 'exec') { out.push(x); return; }
      var k = x.sym + '|' + x.person + '|' + x.date, m = map[k];
      if (!m) { m = map[k] = Object.assign({}, x, { n: 0, change: 0 }); out.push(m); }
      m.n++; m.change += x.change; m.after = x.after;
    });
    return out;
  }
  function trkLine(x) {
    if (x.kind === 'exec') return esc(x.person) + (x.role ? '(' + esc(x.role) + ')' : '') + ' · 보유 ' + (x.change > 0 ? '+' : '') + fmtN(x.change) + '주 → ' + fmtN(x.after) + '주' + (x.n > 1 ? ' (' + x.n + '건 합산)' : '');
    if (x.kind === 'major') return esc(x.person) + ' · 5% 대량보유 ' + esc(x.role) + ' · 보유 ' + esc(x.rate) + '%' + (x.rateChg && Number(x.rateChg) ? ' (' + (Number(x.rateChg) > 0 ? '+' : '') + Number(x.rateChg).toFixed(2) + '%p)' : '') + (x.reason ? '<div class="hint">' + esc(x.reason.replace(/\s*\n\s*/g, ' / ')) + '</div>' : '');
    return esc(x.title);
  }
  function trkBadge(x) {
    if (x.kind === 'exec') return '<span class="badge ' + (x.change > 0 ? 't1' : '') + '">내부자 ' + (x.change > 0 ? '증가' : x.change < 0 ? '감소' : '변동') + '</span>';
    if (x.kind === 'major') return '<span class="badge">대량보유</span>';
    return '<span class="badge ' + (x.tone === 'risk' ? 'hot' : '') + '">' + esc(x.tag) + '</span>';
  }
  function trkCard(x, showName) {
    return '<div class="card" style="margin-bottom:8px"><div class="hint">' + esc(x.date) + (showName ? ' · <b>' + esc(x.name) + '</b>' : '') + ' · ' + trkBadge(x) + '</div><div>' + trkLine(x) + '</div><a href="' + esc(x.url) + '" target="_blank" rel="noopener" class="hint">DART 원문 ↗</a></div>';
  }
  function trkFor(sym, n) { return S.trk && S.trk.items ? mergeExec(S.trk.items.filter(function (x) { return x.sym === sym; })).slice(0, n) : []; }
  function viewTracker() {
    var html = '<h2>거물·공시</h2><p class="hint">DART 공시를 종목별로 모았습니다(국내 개별주 12종목). 내부자·대량보유 거래의 방향은 <b>참고 정보</b>이며 검증하지 못해 매수 점수에는 반영하지 않습니다.</p>';
    var st = S.trkSt;
    if (!S.trk || !S.trk.items) return html + '<div class="note">공시 데이터를 아직 받지 못했습니다. <code>DART_API_KEY</code> 를 설정하고 <code>python tools/tracker_kr.py</code> 를 실행하거나, 배포 환경의 첫 실행을 기다려 주세요.</div>' + foot();
    var age = (Date.now() / 1000 - S.trk.updated) / 3600;
    html += '<div class="hint">수집 ' + new Date(S.trk.updated * 1000).toLocaleString('ko-KR') + ' (' + (age < 1 ? '방금' : age < 48 ? Math.floor(age) + '시간 전' : Math.floor(age / 24) + '일 전') + ') · 최근 ' + S.trk.windowDays + '일'
      + (st && st.limited ? ' · <span class="badge hot">DART 호출 제한 — 마지막 정상 데이터</span>' : '') + (st && st.fails && st.fails.length ? ' · 일부 종목 실패 ' + st.fails.length + '건' : '') + '</div>';
    var f = S.trkFilter || 'all', a = loadAcct();
    var chips = [['all', '전체'], ['risk', '주의 공시'], ['exec', '내부자'], ['major', '대량보유'], ['mine', '내 보유 종목']];
    html += '<div class="chips" style="margin-top:10px">' + chips.map(function (c) { return '<button type="button" data-trk="' + c[0] + '" class="' + (c[0] === f ? 'on' : '') + '">' + c[1] + '</button>'; }).join('') + '</div>';
    // 최근 30일 내부자 순증감 요약
    var lim = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), sum = {};
    S.trk.items.forEach(function (x) { if (x.kind === 'exec' && x.date >= lim) { var s = sum[x.sym] = sum[x.sym] || { name: x.name, up: 0, dn: 0, net: 0 }; if (x.change > 0) s.up++; else if (x.change < 0) s.dn++; s.net += x.change; } });
    var keys = Object.keys(sum).sort(function (p, q) { return sum[q].up + sum[q].dn - sum[p].up - sum[p].dn; });
    if (keys.length && (f === 'all' || f === 'exec')) {
      html += '<div class="hint">최근 30일 내부자(임원·주요주주) 보유 변동</div><div class="tablebox"><table style="min-width:420px"><thead><tr><th>종목</th><th>증가 건</th><th>감소 건</th><th>순증감(주)</th></tr></thead><tbody>'
        + keys.map(function (k) { var s = sum[k]; return '<tr><td>' + esc(s.name) + '</td><td class="num">' + s.up + '</td><td class="num">' + s.dn + '</td><td class="num ' + cls(s.net) + '">' + (s.net > 0 ? '+' : '') + fmtN(s.net) + '</td></tr>'; }).join('')
        + '</tbody></table></div><div class="hint">증가·감소에는 스톡옵션 행사, 보상 지급, 증여, 계열사 간 이전 등이 섞여 있어 시장 매수·매도와 다릅니다. 사유는 DART 원문에서 확인하세요.</div>';
    }
    var items = mergeExec(S.trk.items).filter(function (x) {
      if (f === 'risk') return x.kind === 'filing' && x.tone === 'risk';
      if (f === 'exec') return x.kind === 'exec';
      if (f === 'major') return x.kind === 'major';
      if (f === 'mine') return holdQty(x.sym, a) > 0;
      return true;
    });
    if (f === 'mine' && !items.length) html += '<div class="note">보유 수량이 입력된 종목의 공시가 없습니다. 내 계좌에서 보유 수량이나 매매 기록을 입력하세요.</div>';
    html += '<h3>' + (f === 'risk' ? '주의 공시' : '최근 순') + ' <span class="muted">(' + Math.min(items.length, 60) + '/' + items.length + '건)</span></h3>' + items.slice(0, 60).map(function (x) { return trkCard(x, true); }).join('');
    if (!items.length && f !== 'mine') html += '<div class="card muted">해당하는 항목이 없습니다.</div>';
    return html + '<div class="note">공시 제목 키워드로 "주의"(유상증자·CB·횡령·감자 등)를 분류했습니다. 분류가 틀릴 수 있고, 원문 내용은 직접 확인해야 합니다. 투자 권유가 아닙니다.</div>' + foot();
  }

  /* ---- 시장 국면 ---- */
  function lastDate(sym) { var s = S.ser[sym]; return s ? s.d[s.d.length - 1] : null; }
  function regimes() {
    if (S.reg) return S.reg;
    S.reg = {};
    var d = lastDate('^KS11'); if (d && S.mk.KR) S.reg.KR = Regime.analyze(S.ser, S.mk, d);
    return S.reg;
  }
  function chgBy(sym, days, yieldLike) {
    var s = S.ser[sym]; if (!s) return null; var n = s.c.length - 1, t = s.d[n], lim = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10)) - days * 86400000).toISOString().slice(0, 10), j = n;
    while (j > 0 && s.d[j] > lim) j--;
    if (j === n || s.d[j] > lim) return null;
    return yieldLike ? s.c[n] - s.c[j] : (s.c[j] > 0 && s.c[n] > 0 ? s.c[n] / s.c[j] - 1 : null);
  }
  function regCard(m) {
    var r = regimes()[m]; if (!r) return '';
    var rows = r.areas.map(function (a) {
      var w = a.score == null ? 0 : Math.abs(a.score) / 2 * 50, bar = a.score == null ? '' : '<i style="width:' + w + '%;' + (a.score < 0 ? 'right:50%;background:var(--down)' : 'left:50%;background:var(--up)') + '"></i>';
      return '<tr><td>' + a.name + ' <span class="muted">' + a.weight + '%</span></td><td class="num">' + (a.score == null ? '유보' : (a.score > 0 ? '+' : '') + a.score.toFixed(2)) + '</td><td><div class="sc">' + bar + '</div></td><td>' + r.evalLabel(a.score) + '</td></tr>';
    }).join('');
    var ev = r.areas.map(function (a) {
      return '<h3 style="font-size:14px">' + a.name + ' (' + a.n + '/' + a.total + '개 확인)</h3>' + a.metrics.map(function (x) {
        return '<div class="chk"><span>' + esc(x.label) + (x.note ? ' <span class="muted">· ' + esc(x.note) + '</span>' : '') + '</span><span class="num">' + (x.score == null ? '<span class="badge hot">확인 불가</span>' : esc(x.text) + ' · ' + (x.score > 0 ? '+' : '') + x.score) + '</span>' + (x.asof ? '<span class="hint" style="grid-column:1/-1">기준 ' + esc(x.asof) + '</span>' : '') + '</div>';
      }).join('');
    }).join('');
    return '<div class="card"><div class="hint">국내 · 기준 ' + r.date + ' 종가</div><div class="reg">' + esc(r.name) + '</div>'
      + '<div>신뢰도 <b>' + r.confidence + '</b> · 전환 가능성 <b>' + r.transition + '</b> · 한 달 전 ' + esc(r.prevName) + '</div>'
      + '<p style="margin:10px 0 6px">현재 한국 시장은 <b>' + esc(r.name) + '</b>에 있으며, 가장 중요한 근거는 ' + (r.drivers.length ? esc(r.drivers.join(' · ')) : '뚜렷한 근거 없음(지표 대부분이 중립)') + '입니다.</p>'
      + '<div class="hint">' + esc(r.hint) + ' (일반론적 설명이며 매매 신호가 아닙니다)</div>'
      + '<div class="tablebox" style="margin-top:10px"><table style="min-width:420px"><thead><tr><th>영역(가중치)</th><th>점수</th><th></th><th>평가</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="hint">종합 ' + (r.total == null ? '-' : (r.total > 0 ? '+' : '') + r.total.toFixed(2)) + ' · 지표 확보율 ' + Math.round(r.coverage * 100) + '%. 점수만으로 국면을 기계적으로 정하지 않고 유동성·경기 중심 규칙으로 분류했습니다.</div>'
      + '<details><summary>지표별 근거 보기</summary>' + ev + '<h3 style="font-size:14px">확인 불가 항목</h3><div class="hint">' + esc(r.unavailable.join(' · ')) + '</div></details></div>';
  }
  function viewMarket() {
    if (!window.Regime) return '<div class="note">국면 모듈을 불러오지 못했습니다.</div>';
    var html = '<h2>시장 국면 판별</h2><p class="hint">가격으로 계산 가능한 지표(국내 지수·섹터와 글로벌 변수)만 사용합니다. 국면은 판단의 출발점이며 매수 점수에는 반영되지 않습니다.</p>';
    html += regCard('KR');
    // 과거 성과
    var us = regimes().KR;
    if (us) {
      if (S.regHist === undefined) S.regHist = Regime.history(S.ser, S.mk);
      var hs = S.regHist;
      if (hs) {
        html += '<h2>이 국면, 과거엔?</h2><p class="hint">월말 시점의 국내 국면과 이후 3개월 코스피 수익(2008~). 월 1회 표본이라 횟수가 적고 3개월이 겹칩니다.</p><div class="tablebox"><table><thead><tr><th>국내 국면</th><th>횟수</th><th>3개월 상승</th><th>평균</th></tr></thead><tbody>';
        Object.keys(Regime.NAMES).forEach(function (k) {
          var x = hs.rows[k]; html += '<tr' + (us.id === +k ? ' style="font-weight:700"' : '') + '><td>' + Regime.NAMES[k] + '</td><td class="num">' + x.n + '</td><td class="num">' + (x.n ? (x.up * 100).toFixed(0) + '%' : '-') + '</td><td class="num ' + cls(x.mean) + '">' + (x.n ? pct(x.mean, 1) : '-') + '</td></tr>';
        });
        html += '<tr><td>전체</td><td class="num">' + hs.all.n + '</td><td class="num">' + (hs.all.n ? (hs.all.up * 100).toFixed(0) + '%' : '-') + '</td><td class="num">' + (hs.all.n ? pct(hs.all.mean, 1) : '-') + '</td></tr></tbody></table></div><div class="hint">국면별 차이가 뚜렷하지 않거나 횟수가 적으면 국면은 상황 설명이지 매매 신호가 아닙니다. 과거 재현에는 한계가 있습니다.</div>';
      }
    }
    // 주요 시장 데이터
    var items = [['코스피', '^KS11'], ['코스닥', '^KQ11'], ['필라델피아 반도체', '^SOX'], ['VIX', '^VIX'], ['미 10년물 금리', '^TNX', 1], ['미 5년물 금리', '^FVX', 1], ['미 3개월물 금리', '^IRX', 1], ['달러인덱스', 'DX-Y.NYB'], ['원/달러', 'KRW=X'], ['WTI 원유', 'CL=F'], ['금', 'GC=F'], ['구리', 'HG=F']];
    html += '<h2>주요 시장 데이터</h2><p class="hint">출처 Yahoo Finance(지연·오차 가능). 금리는 %p 변화.</p><div class="tablebox"><table style="min-width:520px"><thead><tr><th>지표</th><th>현재</th><th>1일</th><th>1개월</th><th>3개월</th></tr></thead><tbody>';
    items.forEach(function (it) {
      var s = S.ser[it[1]]; if (!s) return; var yl = !!it[2], v = s.c[s.c.length - 1];
      function cell(d) { var c = chgBy(it[1], d, yl); return '<td class="num ' + (c == null ? '' : cls(c)) + '">' + (c == null ? '-' : yl ? (c > 0 ? '+' : '') + c.toFixed(2) + '%p' : pct(c, 1)) + '</td>'; }
      html += '<tr><td>' + it[0] + ' <span class="muted">' + s.d[s.d.length - 1].slice(5) + '</span></td><td class="num">' + v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + '</td>' + cell(1) + cell(30) + cell(91) + '</tr>';
    });
    html += '</tbody></table></div>';
    return html + '<div class="note">경제 일정, AI 해설, PMI·기업이익·외국인 수급 같은 항목은 자동 수집이 어려워 포함하지 않았습니다. 투자 권유가 아닙니다.</div>' + foot();
  }

  /* ---- 종목 추가·삭제 요청 ----
   * 앱은 정적 사이트라 목록을 바로 바꿀 수 없다. 요청 문구를 만들어 GitHub Actions 수동 실행에 붙여 넣으면
   * 저장소의 data/universe.json 이 바뀌고 시세·적정가·공시가 다음 실행부터 따라온다(약 2~3분). */
  S.addQ = []; S.remQ = []; S.editOpen = false; S.editMsg = '';
  function repoUrl() {
    var m = location.hostname.match(/^([^.]+)\.github\.io$/), p = location.pathname.split('/').filter(Boolean)[0];
    return m && p ? 'https://github.com/' + m[1] + '/' + p + '/actions/workflows/update-data.yml' : null;
  }
  function protectedSym(w) { return w.group === 'index' || w.group === 'sector'; }
  function editPanel() {
    var url = repoUrl(), addTxt = S.addQ.map(function (x) { return x.code + (x.name ? ':' + x.name : ''); }).join(', '), remTxt = S.remQ.join(', ');
    var cur = S.uni.watch.filter(function (w) { return w.sym === S.sel; })[0];
    return '<details id="editBox"' + (S.editOpen ? ' open' : '') + '><summary>＋ 종목 추가·삭제</summary><div class="card">'
      + '<div class="hint">목록은 저장소에 있어서 앱에서 바로 바뀌지 않습니다. 아래에서 요청 문구를 만든 뒤 GitHub에서 한 번 실행하면 2~3분 뒤 반영됩니다(앱 새로고침).</div>'
      + '<h3 style="margin-top:12px">추가</h3><div class="form"><div><label for="addCode">종목 코드(6자리)</label><input id="addCode" maxlength="6" autocapitalize="characters" placeholder="예: 035420"></div>'
      + '<div><label for="addName">이름(선택)</label><input id="addName" maxlength="30" placeholder="비우면 자동"></div></div>'
      + '<div class="hbar"><button class="small" type="button" id="addQueue">목록에 담기</button></div>'
      + (S.addQ.length ? '<div class="hint">' + S.addQ.map(function (x, i) { return esc(x.code + (x.name ? ' ' + x.name : '')) + ' <a href="#" data-qdel="' + i + '">빼기</a>'; }).join(' · ') + '</div>' : '')
      + '<h3 style="margin-top:12px">삭제</h3>'
      + '<div class="hbar"><button class="small" type="button" id="remQueue"' + (cur && !protectedSym(cur) ? '' : ' disabled') + '>' + (cur ? '지금 보는 "' + esc(cur.name) + '" 삭제 담기' : '삭제할 종목을 먼저 선택') + '</button></div>'
      + (cur && protectedSym(cur) ? '<div class="hint">지수·섹터 ETF는 검증 비교 기준과 시장 폭 계산에 쓰여서 삭제할 수 없습니다.</div>' : '')
      + (S.remQ.length ? '<div class="hint">삭제 요청: ' + S.remQ.map(function (c, i) { return esc(c) + ' <a href="#" data-rdel="' + i + '">빼기</a>'; }).join(' · ') + '</div>' : '')
      + '<div class="hint" id="editMsg">' + esc(S.editMsg) + '</div>'
      + '<h3 style="margin-top:12px">요청 문구</h3>'
      + '<label for="addOut">추가 입력칸에 붙여넣을 값</label><input id="addOut" readonly value="' + esc(addTxt) + '"><div class="hbar"><button class="small" type="button" data-copy="addOut">복사</button></div>'
      + '<label for="remOut">삭제 입력칸에 붙여넣을 값</label><input id="remOut" readonly value="' + esc(remTxt) + '"><div class="hbar"><button class="small" type="button" data-copy="remOut">복사</button></div>'
      + '<ol class="hint" style="padding-left:18px;margin:8px 0">'
      + '<li>위 값을 복사합니다.</li><li>' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">GitHub 실행 화면 열기 ↗</a>(로그인 필요)' : 'GitHub 저장소의 Actions → update-data 로 이동 (배포된 주소에서 열면 바로 가기가 나옵니다)') + '</li>'
      + '<li>"Run workflow"를 누르고 해당 입력칸에 붙여넣은 뒤 실행합니다.</li><li>2~3분 뒤 이 앱을 새로고침합니다.</li></ol>'
      + '<div class="hint">개별주 여부는 DART 상장사 목록으로 자동 판별하고, 그 외는 "기타 ETF"로 들어갑니다(검증의 중립 비교 묶음에는 포함되지 않음). 한 번에 10개까지, 전체 60개까지입니다.</div></div></details>';
  }
  function refreshEdit() { var el = document.getElementById('editBox'); if (el) { var h = el.outerHTML; el.outerHTML = editPanel(); } }

  function viewStock() {
    var list = visible();
    if (!list.length) return '<div class="card">표시할 종목이 없습니다.</div>';
    if (!S.sel || !list.some(function (w) { return w.sym === S.sel; })) S.sel = list[0].sym;
    var w = list.filter(function (x) { return x.sym === S.sel; })[0], d = S.ev[w.sym], e = d.ev, L = last(w.sym);
    // ETF 와 주식을 나눠 각각 콤보(선택 상자)로 고른다. 고른 쪽만 값이 채워지고 다른 쪽은 "선택"으로 돌아간다.
    var isEtf = function (x) { return x.group !== 'stock'; };
    var etfs = list.filter(isEtf), stocks = list.filter(function (x) { return !isEtf(x); });
    var GL = { index: '지수 ETF', sector: '섹터 ETF', leverage: '레버리지 ETF', etf: '기타 ETF', inverse: '인버스 ETF' };
    function opts(arr, grouped) {
      if (!grouped) return arr.map(function (x) { return '<option value="' + esc(x.sym) + '"' + (x.sym === S.sel ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('');
      return ['index', 'sector', 'leverage', 'etf', 'inverse'].map(function (g) {
        var a = arr.filter(function (x) { return x.group === g; }); if (!a.length) return '';
        return '<optgroup label="' + GL[g] + '">' + opts(a, false) + '</optgroup>';
      }).join('');
    }
    var selIsEtf = isEtf(list.filter(function (x) { return x.sym === S.sel; })[0] || {});
    var html = '<div class="form" style="margin-bottom:10px">'
      + '<div><label for="selEtf">ETF (' + etfs.length + ')</label><select id="selEtf" data-pick="1">' + (selIsEtf ? '' : '<option value="" selected>ETF 선택…</option>') + opts(etfs, true) + '</select></div>'
      + '<div><label for="selStock">주식 (' + stocks.length + ')</label><select id="selStock" data-pick="1">' + (selIsEtf ? '<option value="" selected>주식 선택…</option>' : '') + opts(stocks, false) + '</select></div></div>';
    html += '<div class="card"><b>' + esc(w.name) + '</b> <span class="muted">' + esc(w.sym) + ' · ' + L.d + (w.lev > 1 ? ' · ' + w.lev + '배 레버리지' : '') + '</span>'
      + '<div style="font-size:22px;font-weight:700" class="num">' + money(L.raw, S.uni.markets[w.market].currency) + '</div><canvas id="chart"></canvas>'
      + '<div class="hint">검정: 종가(수정주가), 청록: 200일선, 점: 과거 신호 첫날</div><div class="hbar" style="margin-bottom:0"><button class="small" type="button" data-logsym="' + esc(w.sym) + '">이 종목 매매 기록하기</button></div></div>';
    var stTxt = d.age === null ? '' : (d.fresh ? '신규 신호 · 켜진 지 ' + (d.age + 1) + '거래일째' : '지속 중 · 켜진 지 ' + (d.ageMin ? d.age + '거래일 이상' : (d.age + 1) + '거래일째') + ' (신규 진입 우위 낮음)') + (execTier(w.sym) ? ' · 이번 신호 구간에 ' + execTier(w.sym) + '차 집행(내 기록)' : '');
    html += '<div class="card"><b>' + LENS[S.lens] + ' 관점 · 점수 ' + e.score + ' / 100 · ' + (e.tier ? e.tier + '차' : '신호 없음') + '</b>' + (stTxt ? '<div class="' + (d.fresh ? '' : 'muted') + '">' + stTxt + '</div>' : '');
    e.notes.forEach(function (n) { html += '<div class="note">' + esc(n) + '</div>'; });
    function chk(list) {
      return list.map(function (s) {
        return '<div class="chk"><span>' + esc(s.label) + '</span><span class="num">' + esc(s.detail) + (s.na ? '' : ' · ' + (s.strength * s.weight).toFixed(1) + '/' + s.weight) + '</span><div class="bar"><i style="width:' + (s.na ? 0 : Math.round(s.strength * 100)) + '%"></i></div></div>';
      }).join('');
    }
    if (e.parts) html += '<h3>웅덩이 ' + e.parts.a.score + '점</h3>' + chk(e.parts.a.signals) + '<h3>도키 ' + e.parts.b.score + '점</h3>' + chk(e.parts.b.signals);
    else html += chk(e.signals);
    html += '</div>';
    var f = S.fund[w.sym];
    if (S.lens !== 'pool') {
      if (f && f.na) html += '<div class="note">' + esc(f.reason || '적정가 해당 없음') + '</div>';
      else if (f && f.fair) html += '<div class="card"><b>자동 적정가</b> <span class="muted">DART FY' + f.asof + ' · 공시 ' + esc(f.filed) + '</span><div class="num">' + money(f.fair, 'KRW') + ' <span class="muted">(주당현금흐름 ' + money(f.cfps, 'KRW') + ', 성장률 ' + (f.g * 100).toFixed(0) + '%, 멀티플 ' + f.mult + ', 요구수익률 ' + (f.r * 100).toFixed(0) + '%)</span></div><div class="hint">보수적 가정에 따른 참고 값이며 투자 권유가 아닙니다.</div></div>';
      else if (w.market === 'KR' && w.group === 'stock') html += '<div class="note">이 종목의 적정가가 아직 없습니다. DART 인증키를 설정하고 <code>python tools/fund_kr.py</code> 를 실행하세요.</div>';
      else html += '<div class="hint">이 종목은 적정가 계산 대상이 아닙니다(국내 개별주만 지원).</div>';
    }
    var tr = trkFor(w.sym, 6);
    if (tr.length) html += '<h3>최근 공시·내부자 <span class="muted">(DART, 참고 정보)</span></h3>' + tr.map(function (x) { return trkCard(x, false); }).join('') + '<div class="hint"><a href="#" data-trkgo="' + esc(w.sym) + '">거물 탭에서 전체 보기</a></div>';
    else if (w.group === 'stock' && S.trk) html += '<div class="hint">최근 ' + S.trk.windowDays + '일 안에 이 종목의 수집된 공시가 없습니다.</div>';
    return html + editPanel() + foot();
  }

  function drawChart() {
    var cv = $('#chart'); if (!cv || !S.sel) return;
    var d = S.ev[S.sel], s = d.P.s, n = s.c.length, N = Math.min(520, n), a = n - N;
    var dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    var g = cv.getContext('2d'); g.scale(dpr, dpr);
    var cs = getComputedStyle(document.documentElement), ink = cs.getPropertyValue('--ink').trim(), acc = cs.getPropertyValue('--accent').trim(), up = cs.getPropertyValue('--up').trim(), mu = cs.getPropertyValue('--muted').trim();
    var lo = Infinity, hi = -Infinity, i;
    for (i = a; i < n; i++) {
      lo = Math.min(lo, s.c[i]); hi = Math.max(hi, s.c[i]);
      if (d.P.sma200[i]) { lo = Math.min(lo, d.P.sma200[i]); hi = Math.max(hi, d.P.sma200[i]); }
      if (S.lens !== 'pool' && d.P.fairAdj && d.P.fairAdj[i]) { lo = Math.min(lo, d.P.fairAdj[i]); hi = Math.max(hi, d.P.fairAdj[i]); }
    }
    var pad = 22, x = function (k) { return pad + (W - pad - 6) * (k - a) / (n - 1 - a); }, y = function (v) { return 8 + (H - 24) * (1 - (v - lo) / (hi - lo)); };
    function line(arr, col, wd) { g.beginPath(); var st = false; for (var k = a; k < n; k++) { if (arr[k] == null) continue; if (!st) { g.moveTo(x(k), y(arr[k])); st = true; } else g.lineTo(x(k), y(arr[k])); } g.strokeStyle = col; g.lineWidth = wd; g.stroke(); }
    line(d.P.sma200, acc, 1.5); line(s.c, ink, 1.4);
    if (S.lens !== 'pool' && d.P.fairAdj) { g.setLineDash([5, 4]); line(d.P.fairAdj, cs.getPropertyValue('--warn').trim(), 1.4); g.setLineDash([]); }
    // 과거 신호 첫날
    var mk = S.mk[d.w.market], quiet = 99;
    for (i = Math.max(260, a); i < n; i++) {
      var r = Engine.evaluateBy(S.lens, d.P, i, mk, calOpt(d.w));
      if (r.tier > 0 && quiet >= 20) { g.beginPath(); g.arc(x(i), y(s.c[i]), 3.5, 0, 7); g.fillStyle = up; g.fill(); }
      quiet = r.tier > 0 ? 0 : quiet + 1;
    }
    g.fillStyle = mu; g.font = '11px sans-serif'; g.fillText(s.d[a], pad, H - 4); g.fillText(s.d[n - 1], W - 66, H - 4);
  }

  /* ---- 검증 ---- */
  function runBt(force) {
    var key = BT_KEY + Engine.VERSION + '-' + S.lens + '-' + (S.man ? S.man.updated : 0) + '-' + Object.keys(S.fund).length + '-' + JSON.stringify(costs());
    if (!force) { var c = lsGet(key); if (c) { try { S.bt = JSON.parse(c); render(); return; } catch (e) { } } }
    S.btBusy = true; render();
    var wk = new Worker('bt-worker.js');
    wk.onmessage = function (ev) { S.bt = ev.data; S.btBusy = false; lsSet(key, JSON.stringify(ev.data)); wk.terminate(); render(); };
    wk.onerror = function () { S.btBusy = false; wk.terminate(); S.bt = { error: true }; render(); };
    wk.postMessage({ universe: S.uni, series: S.ser, fund: S.fund, lens: S.lens, costs: costs() });
  }
  var COST_KEY = 'trader-cost-v1', COST_DEF = { krFee: 0.015, krTax: 0.15 };
  function loadCost() { try { return Object.assign({}, COST_DEF, JSON.parse(lsGet(COST_KEY) || '{}')); } catch (e) { return Object.assign({}, COST_DEF); } }
  function costs() { var c = loadCost(); return { KR: { fee: Number(c.krFee) || 0, tax: Number(c.krTax) || 0 } }; }
  function bindCost() {
    var v = $('#view'); v.oninput = function (e) {
      var t = e.target; if (!t.getAttribute('data-cost')) return;
      var c = loadCost(); c[t.getAttribute('data-cost')] = t.value; lsSet(COST_KEY, JSON.stringify(c));
      var h = $('#costHint'); if (h) h.textContent = '값이 바뀌었습니다. "다시 계산"을 눌러 반영하세요.';
    };
  }
  function costForm() {
    var c = loadCost();
    return '<div class="card"><b>거래 비용 설정</b> <span class="muted">(% 단위, 편도)</span><div class="form" style="margin-top:8px">'
      + '<div><label for="krFee">국내 수수료(%)</label><input id="krFee" data-cost="krFee" type="number" step="0.001" inputmode="decimal" value="' + esc(c.krFee) + '"></div>'
      + '<div><label for="krTax">국내 개별주 매도 거래세(%)</label><input id="krTax" data-cost="krTax" type="number" step="0.01" inputmode="decimal" value="' + esc(c.krTax) + '"></div></div>'
      + '<div class="hint" id="costHint" style="margin-top:6px">기본값은 가정입니다. 증권사 수수료와 최신 거래세율을 확인해 바꾸세요. 국내 ETF는 거래세가 면제라 적용하지 않습니다.</div></div>';
  }
  /* ---- 자동 보정 ---- */
  function runCalib() {
    S.calibBusy = true; render();
    var wk = new Worker('bt-worker.js');
    wk.onmessage = function (ev) { S.calib = ev.data; S.calibBusy = false; lsSet(CAL_KEY, JSON.stringify(ev.data)); wk.terminate(); compute(); render(); };
    wk.onerror = function () { S.calibBusy = false; S.calib = { error: true }; wk.terminate(); render(); };
    wk.postMessage({ mode: 'calib', universe: S.uni, series: S.ser, fund: S.fund });
  }
  var KLAB = { dd: '낙폭', dev: '200일선 이격', wrsi: '주봉 RSI', rsi: '일봉 RSI', macd: 'MACD', vol: '변동성', idx: '지수 낙폭' };
  function calibHtml() {
    var h = '<h2>자동 보정</h2><p class="hint">종목별 앞 70%(학습)로 신호 가중치와 임계값을 정하고, 뒤 30%(검증)에서 기본값보다 나을 때만 채택합니다. 채택해도 기본값 쪽으로 50% 되돌린 값을 씁니다. 대상은 웅덩이 관점의 7개 신호이며, 위의 검증·점검 표는 항상 기본값 기준입니다.</p>';
    if (S.calibBusy) return h + '<div class="card">계산 중입니다…</div>';
    if (!S.calib || S.calib.error || !S.calib.res) return h + (S.calib && S.calib.error ? '<div class="note">보정을 실행하지 못했습니다.</div>' : '') + '<button id="calRun" type="button">자동 보정 실행</button>';
    function pr(x) { return x.n + '건 · 초과 ' + (x.excess >= 0 ? '+' : '') + (x.excess * 100).toFixed(1) + '%p · z ' + x.z.toFixed(1); }
    ['KR'].forEach(function (m) {
      var r = S.calib.res[m]; h += '<h3>국내 <span class="badge ' + (r.adopted ? 't1' : '') + '">' + (r.adopted ? '채택' : '기본값 유지') + '</span></h3>';
      h += '<div class="tablebox"><table style="min-width:520px"><thead><tr><th>신호</th><th>학습 z</th><th>가중치 기본 → 보정</th></tr></thead><tbody>';
      Object.keys(KLAB).forEach(function (k) { h += '<tr><td>' + KLAB[k] + '</td><td class="num">' + r.z[k].toFixed(1) + '</td><td class="num">' + r.def.w[k] + ' → ' + r.shrunk.w[k].toFixed(0) + '</td></tr>'; });
      h += '</tbody></table></div><div class="hint">임계값 기본 ' + r.def.th.join('/') + ' · 학습 최적 ' + r.cal.th.join('/') + ' · 수축 후 ' + r.shrunk.th.join('/') + '</div>';
      h += '<div class="tablebox"><table style="min-width:620px"><thead><tr><th>설정</th><th>학습 구간(1차 신호 60일 후)</th><th>검증 구간</th></tr></thead><tbody>';
      [['def', '기본값'], ['cal', '학습 최적(수축 전)'], ['shrunk', '수축 후(적용 후보)']].forEach(function (p) { h += '<tr><td>' + p[1] + '</td><td class="num">' + pr(r.results[p[0]].train) + '</td><td class="num">' + pr(r.results[p[0]].test) + '</td></tr>'; });
      h += '</tbody></table></div>';
      h += '<div class="hint">' + (r.adopted ? '검증 구간 초과수익이 기본값보다 크고 0보다 커서 채택했습니다.' : '검증 구간에서 기본값보다 낫지 않거나 초과수익이 0 이하여서 기본값을 유지합니다.') + '</div>';
    });
    var adoptedAny = ['KR'].some(function (m) { return S.calib.res[m] && S.calib.res[m].adopted; });
    h += '<div class="card"><label style="display:flex;gap:10px;align-items:center;font-size:14px;color:var(--ink);margin:0"><input id="useCal" type="checkbox" style="width:24px;min-height:24px"' + (S.useCal ? ' checked' : '') + (adoptedAny ? '' : ' disabled') + '> 채택된 시장에 보정값 사용</label><div class="hint" style="margin-top:6px">' + (adoptedAny ? '켜면 오늘·종목 탭의 웅덩이 점수가 보정값으로 계산됩니다.' : '채택된 시장이 없어 켤 수 없습니다.') + '</div></div>';
    return h + '<div class="note">⚠ 검증 구간이 하나뿐이고 이벤트 수가 적어서, 채택은 "기본값보다 우연히 나았을 수 있는 정도"로 읽으세요. 시간이 지나 데이터가 쌓이면 다시 실행하세요.</div><button id="calRun" type="button">다시 보정</button>';
  }

  /* ---- 신호별 효과 점검 ---- */
  function runEdge() {
    var key = 'trader-edge-v' + Engine.VERSION + '-' + (S.man ? S.man.updated : 0) + '-' + Object.keys(S.fund).length;
    var c = lsGet(key); if (c) { try { S.edge = JSON.parse(c); render(); return; } catch (e) { } }
    S.edgeBusy = true; render();
    var wk = new Worker('bt-worker.js');
    wk.onmessage = function (ev) { S.edge = ev.data; S.edgeBusy = false; lsSet(key, JSON.stringify(ev.data)); wk.terminate(); render(); };
    wk.onerror = function () { S.edgeBusy = false; S.edge = { error: true }; wk.terminate(); render(); };
    wk.postMessage({ mode: 'edge', universe: S.uni, series: S.ser, fund: S.fund });
  }
  function edgeHtml() {
    var h = '<h2>신호 점검</h2><p class="hint">신호가 켜진 날과 꺼진 날의 60일 후 수익률(레버리지는 배율 환산)을 비교합니다. 기간을 앞뒤 절반으로 나눠 방향이 같은지 함께 봅니다. 겹치는 구간이 많아 z 값은 표본을 n/60으로 줄여 보수적으로 계산했지만, 같은 시기에 여러 종목이 함께 움직이고 비교 항목이 많아 우연히 큰 값이 나올 수 있습니다.</p>';
    if (S.edgeBusy) return h + '<div class="card">계산 중입니다…</div>';
    if (!S.edge) return h + '<button id="edgeRun" type="button">신호별 효과 점검 실행</button>';
    if (S.edge.error) return h + '<div class="note">점검을 실행하지 못했습니다.</div><button id="edgeRun" type="button">다시 실행</button>';
    var mks = ['KR'];
    function sgn(v) { return v == null ? '-' : (v > 0 ? '+' : '') + (v * 100).toFixed(1); }
    mks.forEach(function (m) {
      var r = S.edge.res[m]; h += '<h3>국내</h3>';
      if (!r || r.error) { h += '<div class="note">데이터 없음</div>'; return; }
      [['neutral', '중립 유니버스(ETF) ' + r.nNeutral + '종목'], ['all', '전체 ' + r.nAll + '종목']].forEach(function (p) {
        var rows = (r[p[0]] || []).filter(function (x) { return !x.thin && x.key !== 'p_tier'; }).sort(function (a, b) { return b.z - a.z; });
        h += '<div class="hint">' + p[1] + '</div><div class="tablebox"><table style="min-width:600px"><thead><tr><th>신호</th><th>켜짐 평균</th><th>꺼짐 평균</th><th>차이(%p)</th><th>z</th><th>앞/뒤 절반 차이</th><th>판정</th></tr></thead><tbody>';
        rows.forEach(function (x) {
          var same = x.dA != null && x.dB != null && Math.sign(x.dA) === Math.sign(x.diff) && Math.sign(x.dB) === Math.sign(x.diff);
          var v = Math.abs(x.z) >= 2 && same ? (x.diff > 0 ? '효과 있음' : '역효과') : Math.abs(x.z) >= 2 ? '불안정' : '약함';
          h += '<tr><td>' + esc(x.label) + '</td><td class="num">' + sgn(x.mOn) + '%</td><td class="num">' + sgn(x.mOff) + '%</td><td class="num ' + cls(x.diff) + '">' + sgn(x.diff) + '</td><td class="num">' + x.z.toFixed(1) + '</td><td class="num">' + sgn(x.dA) + ' / ' + sgn(x.dB) + '</td><td>' + v + '</td></tr>';
        });
        h += '</tbody></table></div>';
      });
    });
    return h + '<div class="note">"효과 있음/역효과"는 |z| 2 이상이고 앞뒤 절반의 부호가 같을 때만 붙였습니다. 이 기준을 넘어도 독립된 위기 구간은 몇 번 되지 않으니 참고 정보로만 쓰세요.</div><button id="edgeRun" type="button">다시 점검</button>';
  }
  function f1(v) { return v == null ? '-' : (v * 100).toFixed(1) + '%'; }
  function viewVerify() {
    var html = '<h2>검증 · ' + LENS[S.lens] + ' 관점</h2>' + (S.lens === 'doki' ? '<div class="note">도키 관점은 적정가가 계산된 종목만 검증합니다. 적정가 이력이 없으면 해당 시장 결과가 비어 있습니다.</div>' : '') + '<p class="hint">신호가 처음 켜진 날(웅덩이당 차수별 1회) 다음 거래일 종가에 샀다고 가정한 결과를 같은 종목 구성의 "아무 날 매수"와 비교합니다. 시장별로 따로 계산합니다.</p>';
    html += costForm();
    if (S.btBusy) return html + '<div class="card">계산 중입니다…</div>';
    if (!S.bt || S.bt.error) return html + '<div class="note">검증을 실행하지 못했습니다.</div><button class="primary" id="rerun" type="button">다시 실행</button>';
    var mks = ['KR'];
    function setHtml(r, title) {
      if (!r) return '<h3 style="font-size:14px">' + title + '</h3><div class="hint">대상 종목이 없습니다.</div>';
      var h = '<h3 style="font-size:14px">' + title + ' <span class="muted">' + r.symbols.length + '종목</span></h3><div class="hint">' + esc(r.symbols.join(', ')) + '</div><div class="tablebox"><table><thead><tr><th>60일 후</th><th>표본</th><th>상승 확률</th><th>평균 수익</th><th>기준선</th><th>차이</th><th>표본 외</th><th>최대낙폭</th></tr></thead><tbody>';
      [1, 2, 3].forEach(function (t) {
        var x = r.tiers[t], b = r.base[60];
        var diff = x.all.n ? x.all.up - b.all.up : null;
        h += '<tr><td>' + t + '차</td><td class="num">' + x.all.n + (x.all.n < 30 ? ' ⚠' : '') + '</td><td class="num">' + f1(x.all.up) + '</td><td class="num ' + cls(x.all.mean) + '">' + (x.all.n ? pct(x.all.mean, 1) : '-') + '</td><td class="num">' + f1(b.all.up) + '</td><td class="num ' + cls(diff) + '">' + (diff == null ? '-' : (diff * 100 > 0 ? '+' : '') + (diff * 100).toFixed(1) + '%p') + '</td><td class="num">' + f1(x.oos.up) + ' <span class="muted">/ ' + f1(b.oos.up) + '</span></td><td class="num down">' + (x.mae == null ? '-' : pct(x.mae, 1)) + '</td></tr>';
      });
      h += '</tbody></table></div><div class="tablebox"><table><thead><tr><th>1차 신호 후</th><th>20일</th><th>60일</th><th>120일</th><th>250일</th></tr></thead><tbody><tr><td>상승 확률</td>';
      [20, 60, 120, 250].forEach(function (k) { h += '<td class="num">' + f1(r.tiers[1].byH[k].up) + '</td>'; });
      h += '</tr><tr><td>기준선</td>';
      [20, 60, 120, 250].forEach(function (k) { h += '<td class="num">' + f1(r.base[k].all.up) + '</td>'; });
      h += '</tr></tbody></table></div>';
      if (r.age) {
        h += '<div class="hint">신호가 켜진 뒤 경과일별 60일 후 성과(신호 구간의 모든 날 기준, 같은 구간 안의 날들은 겹침). 신규 구간이 더 좋아야 "신규/지속 구분"이 의미가 있습니다.</div><div class="tablebox"><table><thead><tr><th>경과</th><th>표본</th><th>상승 확률</th><th>평균 수익</th><th>기준선 대비</th></tr></thead><tbody>';
        [['fresh', '신규 (0~10일)'], ['mid', '11~30일'], ['old', '31일 이상']].forEach(function (p) {
          var x = r.age[p[0]], b = r.base[60].all, df = x.n ? x.up - b.up : null;
          h += '<tr><td>' + p[1] + '</td><td class="num">' + x.n + '</td><td class="num">' + f1(x.n ? x.up : null) + '</td><td class="num ' + cls(x.mean) + '">' + (x.n ? pct(x.mean, 1) : '-') + '</td><td class="num ' + cls(df) + '">' + (df == null ? '-' : (df > 0 ? '+' : '') + (df * 100).toFixed(1) + '%p') + '</td></tr>';
        });
        h += '</tbody></table></div>';
      }
      var sm = r.sim;
      if (sm) {
        h += '<div class="hint">매매 시뮬레이션(비용 반영, 종목별 결과의 평균 · ' + sm.n + '종목): 처음 50% 보유 + 신호 때 현금의 20/30/50% 추가 매수, 다음 거래일 종가 체결, 종료 시 전량 매도.</div><div class="tablebox"><table><thead><tr><th>전략</th><th>연수익률</th><th>최대낙폭</th><th>칼마</th><th>추가매수/종목</th></tr></thead><tbody>';
        [['strat', '웅덩이 전략'], ['half', '50% 방치'], ['hold', '100% 보유']].forEach(function (p) {
          var x = sm[p[0]];
          h += '<tr><td>' + p[1] + '</td><td class="num ' + cls(x.cagr) + '">' + pct(x.cagr, 1) + '</td><td class="num down">' + pct(x.mdd, 1) + '</td><td class="num">' + (x.calmar == null ? '-' : x.calmar.toFixed(2)) + '</td><td class="num">' + (p[0] === 'strat' ? x.buys.toFixed(1) + '회' : '-') + '</td></tr>';
        });
        h += '</tbody></table></div><div class="hint">100% 보유 대비 웅덩이 전략이 연수익률 ' + sm.winCagr + '/' + sm.n + ', 최대낙폭이 더 얕은 종목 ' + sm.winMdd + '/' + sm.n + ', 칼마 ' + sm.winCalmar + '/' + sm.n + '종목에서 앞섰습니다.</div>';
      }
      return h;
    }
    mks.forEach(function (m) {
      var r = S.bt.res[m]; html += '<h2>국내</h2>';
      if (!r || r.error) { html += '<div class="note">' + esc(r ? r.error : '데이터 없음') + '</div>'; return; }
      html += setHtml(r.neutral, '중립 유니버스 (지수·섹터 ETF만)') + setHtml(r.all, '전체 종목 (ETF + 개별주 + 레버리지)');
    });
    html += '<div class="note">⚠ 표본 30 미만은 신뢰하기 어렵습니다. 중립 유니버스는 종목 선택 편향이 적어 더 믿을 만하지만, 개별주는 현재 살아남은 대표 종목이라 생존편향이 있습니다. 결과가 기준선과 비슷하거나 나쁘면 그대로 받아들이세요. 거래 비용·세금은 반영하지 않았습니다.</div><button id="rerun" type="button">다시 계산</button>';
    return html + edgeHtml() + calibHtml() + foot();
  }

  /* ---- 내 계좌 ---- */
  function loadAcct() { try { return Object.assign({ cashKRW: '', keep: 20, limit: 25, hold: {} }, JSON.parse(lsGet(ACCT_KEY) || '{}')); } catch (e) { return { cashKRW: '', keep: 20, limit: 25, hold: {} }; } }
  /* 매매 기록: 이 기기에만 저장. 보유 수량 = 기록 이전 보유분(직접 입력) + 기록의 순매수 수량 */
  var LOG_KEY = 'trader-log-v1';
  function loadLog() { try { var a = JSON.parse(lsGet(LOG_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveLog(a) { lsSet(LOG_KEY, JSON.stringify(a)); }
  function netQty(sym) { return loadLog().reduce(function (s, x) { return x.sym === sym ? s + (x.side === 'sell' ? -1 : 1) * x.qty : s; }, 0); }
  function holdQty(sym, a) { return (Number(a.hold[sym]) || 0) + netQty(sym); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  // 현재 신호 구간(처음 켜진 날 이후)에 집행한 최대 차수. 같은 차수를 또 추천하지 않는 데 쓴다.
  function execTier(sym) {
    var d = S.ev[sym]; if (!d || d.age === null) return 0;
    var startDate = S.ser[sym].d[d.i - d.age], t = 0;
    loadLog().forEach(function (x) { if (x.sym === sym && x.side === 'buy' && x.date >= startDate && x.tier > t) t = x.tier; });
    return t;
  }
  function renderLog() {
    var el = $('#logList'); if (!el) return;
    var nm = {}; S.uni.watch.forEach(function (w) { nm[w.sym] = w.name; });
    var rows = loadLog().sort(function (p, q) { return p.date < q.date ? 1 : p.date > q.date ? -1 : (p.id < q.id ? 1 : -1); }).slice(0, 12);
    el.innerHTML = rows.length ? '<div class="tablebox" style="margin-top:10px"><table style="min-width:440px"><thead><tr><th>날짜</th><th>종목</th><th>구분</th><th>수량</th><th>체결가</th><th></th></tr></thead><tbody>' + rows.map(function (x) {
      return '<tr><td>' + esc(x.date) + '</td><td>' + esc(nm[x.sym] || x.sym) + '</td><td>' + (x.side === 'sell' ? '매도' : '매수' + (x.tier ? ' ' + x.tier + '차' : '')) + '</td><td class="num">' + x.qty + '</td><td class="num">' + Math.round(x.px).toLocaleString('ko-KR') + '</td><td><button class="small" type="button" data-logdel="' + esc(x.id) + '" aria-label="기록 삭제">삭제</button></td></tr>';
    }).join('') + '</tbody></table></div>' : '<div class="hint" style="margin-top:8px">아직 기록이 없습니다. 매수·매도한 뒤 여기에 적어 두면 같은 차수를 또 추천하지 않고, 보유 수량에 자동 반영됩니다.</div>';
  }
  function viewAcct() {
    var a = loadAcct(), html = '<h2>내 계좌</h2><p class="hint">입력은 이 기기의 브라우저에만 저장됩니다. 서버로 보내지 않습니다.</p><div class="card"><div class="form">'
      + '<div><label for="cashKRW">현금(원)</label><input id="cashKRW" type="number" inputmode="numeric" value="' + esc(a.cashKRW) + '"></div>'
      + '<div><label for="keep">최소 유지 현금 비율(%)</label><input id="keep" type="number" inputmode="numeric" value="' + esc(a.keep) + '"></div>'
      + '<div><label for="limit">단일 종목 한도(총자산 대비 %)</label><input id="limit" type="number" inputmode="numeric" value="' + esc(a.limit) + '"></div></div></div>'
      + '<h3>매매 기록</h3><div class="card"><div class="form">'
      + '<div><label for="logSym">종목</label><select id="logSym">' + S.uni.watch.filter(function (w) { return S.ser[w.sym]; }).map(function (w) { return '<option value="' + esc(w.sym) + '"' + (w.sym === S.logSym ? ' selected' : '') + '>' + esc(w.name) + '</option>'; }).join('') + '</select></div>'
      + '<div><label for="logSide">구분</label><select id="logSide"><option value="buy">매수</option><option value="sell">매도</option></select></div>'
      + '<div><label for="logTier">집행한 차수(매수일 때)</label><select id="logTier"><option value="0">차수 없음</option><option value="1">1차</option><option value="2">2차</option><option value="3">3차</option></select></div>'
      + '<div><label for="logDate">날짜</label><input id="logDate" type="date" value="' + today() + '"></div>'
      + '<div><label for="logQty">수량(주)</label><input id="logQty" type="number" inputmode="numeric" min="1"></div>'
      + '<div><label for="logPx">체결가(원)</label><input id="logPx" type="number" inputmode="numeric" min="1"></div></div>'
      + '<div class="hbar"><button class="primary" id="logAdd" type="button">기록 추가</button></div><div id="logMsg" class="hint"></div><div id="logList"></div></div>'
      + '<h3>보유 수량 <span class="muted" style="font-weight:400;font-size:13px">(기록 이전에 이미 갖고 있던 수량)</span></h3><div class="card"><div class="form">'
      + S.uni.watch.filter(function (w) { return S.ser[w.sym]; }).map(function (w) { return '<div><label for="h_' + esc(w.sym) + '">' + esc(w.name) + ' (주)</label><input id="h_' + esc(w.sym) + '" data-h="' + esc(w.sym) + '" type="number" inputmode="numeric" value="' + esc(a.hold[w.sym] || '') + '"></div>'; }).join('')
      + '</div></div><h3>권장 매수 상한</h3><div id="acctOut"></div>'
      + '<div class="note">새로 켜진 신호(켜진 지 11거래일 이내)만 대상입니다. 가용 현금 = 현금 × (1 - 최소 유지 비율). 차수별 사용 비율은 1차 20%, 2차 30%, 3차 50%이고, <b>점수가 높은 종목부터 가용 현금 안에서 차례로 배분</b>합니다(합계가 가용 현금을 넘지 않음). 이미 집행한 차수는 다시 추천하지 않습니다. 현금은 직접 갱신하세요(기록은 현금을 자동으로 바꾸지 않습니다).</div>' + foot();
    return html;
  }
  function bindAcct() {
    $('#view').oninput = function (e) {
      var t = e.target; if (t.id && t.id.indexOf('log') === 0) return; // 매매 기록 입력칸은 저장하지 않는다(추가 버튼으로만 기록)
      var a = loadAcct();
      if (t.getAttribute('data-h')) a.hold[t.getAttribute('data-h')] = t.value; else if (t.id) a[t.id] = t.value;
      lsSet(ACCT_KEY, JSON.stringify(a)); calcAcct();
    };
    $('#view').onchange = function (e) { if (e.target.id === 'logSym') syncLogForm(); };
    syncLogForm(); renderLog();
  }
  // 종목을 고르면 현재 차수를 기본 선택하고 현재가를 안내한다
  function syncLogForm() {
    var s = $('#logSym'), tier = $('#logTier'), px = $('#logPx'); if (!s || !tier || !px) return;
    var d = S.ev[s.value]; S.logSym = s.value;
    tier.value = d && d.ev.tier ? String(d.ev.tier) : '0';
    px.placeholder = S.ser[s.value] ? '현재가 ' + Math.round(last(s.value).raw).toLocaleString('ko-KR') : '';
  }
  function addLog() {
    var msg = $('#logMsg'), sym = $('#logSym').value, side = $('#logSide').value, tier = Number($('#logTier').value) || 0;
    var date = $('#logDate').value, qty = Math.floor(Number($('#logQty').value)), px = Number($('#logPx').value);
    if (!sym || !date || !(qty > 0) || !(px > 0)) { msg.textContent = '날짜, 수량, 체결가를 모두 올바르게 입력하세요.'; return; }
    if (side === 'sell') { tier = 0; var a = loadAcct(); if (qty > holdQty(sym, a)) { msg.textContent = '보유 수량(' + holdQty(sym, a) + '주)보다 많이 매도할 수 없습니다. 기록 이전 보유분을 먼저 입력하세요.'; return; } }
    var log = loadLog(); log.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), date: date, sym: sym, side: side, tier: tier, qty: qty, px: px }); saveLog(log);
    $('#logQty').value = ''; $('#logPx').value = ''; msg.textContent = '기록했습니다.';
    renderLog(); calcAcct();
  }
  function calcAcct() {
    var out = $('#acctOut'); if (!out) return;
    var a = loadAcct(), keep = (Number(a.keep) || 0) / 100, lim = (Number(a.limit) || 100) / 100;
    var cash = Number(a.cashKRW) || 0, held = 0, cand = [], ongoingN = 0, done = [];
    S.uni.watch.forEach(function (w) { if (S.ser[w.sym]) held += holdQty(w.sym, a) * last(w.sym).raw; });
    var total = cash + held, avail = cash * (1 - keep), remaining = avail;
    S.uni.watch.forEach(function (w) {
      var d = S.ev[w.sym]; if (!d || !d.ev.tier) return;
      if (!d.fresh) { ongoingN++; return; } // 신규 신호만 매수 상한을 계산한다
      var ex = execTier(w.sym);
      if (ex >= d.ev.tier) { done.push(w.name + ' ' + ex + '차'); return; } // 이미 집행한 차수는 다시 추천하지 않는다
      cand.push({ w: w, e: d.ev, ex: ex });
    });
    cand.sort(function (p, q) { return q.e.score - p.e.score; }); // 점수가 높은 종목부터 가용 현금 안에서 배분
    var html = '';
    cand.forEach(function (c) {
      var px = last(c.w.sym).raw, own = holdQty(c.w.sym, a) * px;
      var want = avail * RATIO[c.e.tier - 1], capLim = Math.max(0, total * lim - own);
      var remBefore = remaining, amt = Math.max(0, Math.min(want, capLim, remBefore)), sh = Math.floor(amt / px), used = sh * px;
      remaining -= used;
      var why = amt < want - 1 ? (capLim < Math.min(want, remBefore) ? ' · 단일 종목 한도' : ' · 남은 현금 부족') : '';
      html += '<div class="card"><b>' + esc(c.w.name) + '</b> <span class="badge t' + c.e.tier + '">' + c.e.tier + '차 추천' + (c.ex ? ' (' + c.ex + '차 집행함)' : '') + '</span>'
        + '<div class="num">' + (sh > 0 ? sh + '주 · 약 ' + money(used, 'KRW') : '배분 없음') + ' <span class="muted">(상한 ' + money(amt, 'KRW') + why + ' · 현재가 ' + money(px, 'KRW') + ')</span></div></div>';
    });
    var allocated = avail - remaining;
    var head = '<div class="hint">가용 현금 ' + money(avail, 'KRW') + ' · 배분 합계 ' + money(allocated, 'KRW') + ' · 남음 ' + money(remaining, 'KRW') + '</div>';
    var tail = (ongoingN ? '<div class="hint">지속 중인 신호 ' + ongoingN + '종목은 신규 진입 우위가 낮아 배분하지 않았습니다.</div>' : '') + (done.length ? '<div class="hint">이미 집행한 차수라 제외: ' + esc(done.join(', ')) + '</div>' : '');
    out.innerHTML = (cand.length ? head + html : '<div class="card muted">지금 새로 추천할 신호가 없습니다.</div>') + tail;
  }
  function foot() { return '<footer>정보 제공용이며 투자 권유가 아닙니다. 시세는 지연·오차가 있을 수 있고 과거 검증은 미래를 보장하지 않습니다. · <a href="guide.html">설치·사용 안내</a></footer>'; }

  /* ---- 이벤트 ---- */
  document.addEventListener('toggle', function (e) { if (e.target && e.target.id === 'editBox') S.editOpen = e.target.open; }, true);
  document.addEventListener('change', function (e) { // 종목 탭의 ETF·주식 콤보
    var t = e.target; if (!t || !t.getAttribute || !t.getAttribute('data-pick') || !t.value) return;
    S.sel = t.value; render();
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-t]'), m = e.target.closest('[data-m]'), s = e.target.closest('[data-sym]'), l = e.target.closest('[data-l]');
    if (l) { S.lens = l.getAttribute('data-l'); S.bt = null; document.querySelectorAll('#lens button').forEach(function (b) { b.classList.toggle('on', b === l); }); compute(); render(); return; }
    if (t) { S.tab = t.getAttribute('data-t'); document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b === t); }); render(); return; }
    if (m) { S.mkt = m.getAttribute('data-m'); document.querySelectorAll('#mkt button').forEach(function (b) { b.classList.toggle('on', b === m); }); render(); return; }
    if (s) { S.sel = s.getAttribute('data-sym'); if (S.tab === 'today') { S.tab = 'stock'; document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-t') === 'stock'); }); } render(); return; }
    if (e.target.id === 'rerun') runBt(true);
    if (e.target.id === 'logAdd') addLog();
    var id = e.target.id;
    if (id === 'addQueue') {
      var code = (document.getElementById('addCode').value || '').trim().toUpperCase(), nm = (document.getElementById('addName').value || '').replace(/[^0-9A-Za-z가-힣 \-&.()+]/g, '').trim().slice(0, 30);
      if (!/^[0-9A-Z]{6}$/.test(code)) S.editMsg = '코드는 영문 대문자·숫자 6자리여야 합니다.';
      else if (S.uni.watch.some(function (w) { return w.sym.split('.')[0] === code; })) S.editMsg = code + '는 이미 목록에 있습니다.';
      else if (S.addQ.some(function (x) { return x.code === code; })) S.editMsg = '이미 담았습니다.';
      else if (S.addQ.length >= 10) S.editMsg = '한 번에 10개까지 담을 수 있습니다.';
      else { S.addQ.push({ code: code, name: nm }); S.editMsg = code + ' 담았습니다. 아래 요청 문구를 복사하세요.'; }
      S.editOpen = true; refreshEdit(); return;
    }
    if (id === 'remQueue') {
      var cw = S.uni.watch.filter(function (w) { return w.sym === S.sel; })[0], cc = cw ? cw.sym.split('.')[0] : '';
      if (cw && !protectedSym(cw) && S.remQ.indexOf(cc) < 0) { S.remQ.push(cc); S.editMsg = cw.name + ' 삭제를 담았습니다.'; } else S.editMsg = '담을 수 없는 종목이거나 이미 담았습니다.';
      S.editOpen = true; refreshEdit(); return;
    }
    var qd = e.target.closest('[data-qdel]'), rd = e.target.closest('[data-rdel]');
    if (qd) { e.preventDefault(); S.addQ.splice(Number(qd.getAttribute('data-qdel')), 1); S.editOpen = true; refreshEdit(); return; }
    if (rd) { e.preventDefault(); S.remQ.splice(Number(rd.getAttribute('data-rdel')), 1); S.editOpen = true; refreshEdit(); return; }
    var cp = e.target.closest('[data-copy]');
    if (cp) {
      var inp = document.getElementById(cp.getAttribute('data-copy')); if (!inp || !inp.value) { S.editMsg = '복사할 내용이 없습니다. 먼저 종목을 담으세요.'; var em = document.getElementById('editMsg'); if (em) em.textContent = S.editMsg; return; }
      inp.focus(); inp.select();
      var done = function () { var em2 = document.getElementById('editMsg'); if (em2) em2.textContent = '복사했습니다.'; };
      try { navigator.clipboard.writeText(inp.value).then(done, function () { document.execCommand && document.execCommand('copy'); done(); }); } catch (x) { try { document.execCommand('copy'); done(); } catch (y) { } }
      return;
    }
    var tg = e.target.closest('[data-trkgo]');
    if (tg) { e.preventDefault(); S.trkFilter = 'all'; S.tab = 'tracker'; document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-t') === 'tracker'); }); render(); return; }
    var tk = e.target.closest('[data-trk]');
    if (tk) { S.trkFilter = tk.getAttribute('data-trk'); render(); return; }
    var ls = e.target.closest('[data-logsym]');
    if (ls) { S.logSym = ls.getAttribute('data-logsym'); S.tab = 'acct'; document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-t') === 'acct'); }); render(); return; }
    var ld = e.target.closest('[data-logdel]');
    if (ld) { saveLog(loadLog().filter(function (x) { return x.id !== ld.getAttribute('data-logdel'); })); renderLog(); calcAcct(); }
    if (e.target.id === 'calRun') runCalib();
    if (e.target.id === 'useCal') { S.useCal = e.target.checked; lsSet(USECAL_KEY, S.useCal ? '1' : '0'); compute(); chip(); }
    if (e.target.id === 'edgeRun') { try { localStorage.removeItem('trader-edge-v' + Engine.VERSION + '-' + (S.man ? S.man.updated : 0) + '-' + Object.keys(S.fund).length); } catch (x) { } S.edge = null; runEdge(); }
    if (e.target.closest('#refresh')) loadAll();
  });
  window.addEventListener('resize', function () { if (S.tab === 'stock') drawChart(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.uni) loadAll(); });
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) navigator.serviceWorker.register('sw.js').catch(function () { });
  loadAll();
  window.__S = S; // 디버깅용
})();
