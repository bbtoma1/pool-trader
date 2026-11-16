"""시세 수집: 야후 차트(비공식)에서 일봉을 받아 data/px/<심볼>.json 으로 저장한다.

- 기존 파일이 있으면 최근 1개월만 받아 병합하고, 실패해도 기존 값을 유지한다.
- 접근 제한(403/429)을 만나면 우회하지 않고 해당 종목을 건너뛴 뒤 manifest 의 fails 에 기록한다.
- 사용법: python tools/update_data.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PX = os.path.join(DATA, "px")
HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
UA = "trader-app/0.1 (personal research tool)"


def fname(sym):
    return sym.replace("^", "_") + ".json"


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def fetch_chart(sym, full):
    q = "period1=0&period2=%d&interval=1d" % (int(time.time()) + 86400) if full else "range=1mo&interval=1d"
    last_err = None
    for host in HOSTS:
        url = "https://%s/v8/finance/chart/%s?%s&includeAdjustedClose=true" % (host, urllib.request.quote(sym), q)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last_err = "HTTP %s" % e.code
            if e.code in (403, 429):
                break  # 접근 제한: 우회하지 않는다
        except Exception as e:  # 네트워크 오류
            last_err = str(e)
    raise RuntimeError(last_err or "unknown")


def parse(sym, js):
    res = js["chart"]["result"][0]
    ts = res.get("timestamp") or []
    q = res["indicators"]["quote"][0]
    adj = (res["indicators"].get("adjclose") or [{}])[0].get("adjclose")
    raw = q.get("close") or []
    off = res["meta"].get("gmtoffset", 0)
    # 수정주가에 0 이하 값이나 원 종가와 크게 어긋나는 구간이 있으면(야후 조정 오류) 분할만 반영된 원 종가를 쓴다.
    if adj:
        bad = [i for i in range(len(ts)) if adj[i] is not None and raw[i] is not None and (adj[i] <= 0 or raw[i] <= 0)]
        if bad:
            print("WARN %s: 수정주가 오류(0 이하 %d건) -> 원 종가 사용" % (sym, len(bad)))
            adj = None
    rows = {}
    for i, t in enumerate(ts):
        c = adj[i] if adj and adj[i] is not None else raw[i]
        r = raw[i]
        if c is None or r is None:
            continue
        d = time.strftime("%Y-%m-%d", time.gmtime(t + off))
        rows[d] = (round(float(c), 4), round(float(r), 4))
    return rows, res["meta"]


def update(sym, market, cur):
    path = os.path.join(PX, fname(sym))
    old = read_json(path, None)
    js = fetch_chart(sym, full=old is None)
    rows, meta = parse(sym, js)
    merged = {}
    if old:
        for d, c, r in zip(old["d"], old["c"], old.get("raw", old["c"])):
            merged[d] = (c, r)
    merged.update(rows)
    ds = sorted(merged)
    if len(ds) < 30:
        raise RuntimeError("too few rows: %d" % len(ds))
    out = {
        "s": sym, "m": market, "cur": cur,
        "d": ds, "c": [merged[d][0] for d in ds], "raw": [merged[d][1] for d in ds],
        "t": int(time.time()), "mt": meta.get("regularMarketTime", 0),
    }
    write_json(path, out)
    return len(ds), ds[-1]


def main():
    uni = read_json(os.path.join(DATA, "universe.json"), None)
    if not uni:
        print("universe.json 을 읽을 수 없습니다")
        return 1
    targets = []
    for h in uni.get("helpers", []):  # 국내 시장 판단에 쓰는 글로벌 변수(금리·달러·환율·원자재·VIX 등)
        mk = "KR" if h in ("^KS11", "^KQ11") else "GLOBAL"
        targets.append((h, mk, "KRW" if mk == "KR" else "USD"))
    for w in uni["watch"]:
        targets.append((w["sym"], w["market"], uni["markets"][w["market"]]["currency"]))

    manifest = read_json(os.path.join(DATA, "manifest.json"), {"symbols": {}, "fails": []})
    # 유니버스에서 빠진 종목의 시세 파일과 기록은 지운다(배포 폴더에 옛 파일이 남지 않게)
    keep = {fname(s) for s, _, _ in targets}
    if os.path.isdir(PX):
        for fn in os.listdir(PX):
            if fn.endswith(".json") and fn not in keep:
                os.remove(os.path.join(PX, fn))
                print("삭제 %s (유니버스에 없음)" % fn)
    manifest["symbols"] = {k: v for k, v in manifest.get("symbols", {}).items() if fname(k) in keep}
    fails = []
    for sym, mk, cur in targets:
        try:
            n, last = update(sym, mk, cur)
            manifest["symbols"][sym] = {"n": n, "last": last, "t": int(time.time())}
            print("OK   %-10s %5d rows, last %s" % (sym, n, last))
        except Exception as e:
            fails.append({"sym": sym, "err": str(e)})
            print("FAIL %-10s %s (기존 데이터 유지)" % (sym, e))
        time.sleep(0.4)
    manifest["updated"] = int(time.time())
    manifest["fails"] = fails
    write_json(os.path.join(DATA, "manifest.json"), manifest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
