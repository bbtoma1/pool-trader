/* 서비스 워커: 같은 출처 요청은 network-first, 실패하면 캐시. 시세 이력은 앱이 IndexedDB 로 따로 보관한다. */
var CACHE = 'trader-shell-v2';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'engine.js', 'regime.js', 'bt-worker.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // no-cache: 브라우저 HTTP 캐시(GitHub Pages 기본 10분)가 옛 파일을 돌려주지 않게 서버에 매번 확인한다
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(function (r) {
    var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); return r;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
