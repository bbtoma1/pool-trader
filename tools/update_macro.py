"""거시 지표 수집: FRED(세인트루이스 연준)의 공개 CSV 다운로드로 일부 지표를 받아 data/macro.json 에 저장한다.

- 인증키가 필요 없는 공개 다운로드 주소(fredgraph.csv)만 쓴다. 접근이 막히거나 느리면 우회하지 않고 해당 지표만 건너뛰며 기존 값을 유지한다.
- 발표 지연(lag)을 함께 기록해, 앱이 과거 시점을 재현할 때 그 날 알 수 없던 값을 쓰지 않게 한다(룩어헤드 방지).
- 사용법: python tools/update_macro.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "macro.json")
START = "2005-01-01"
UA = "trader-app/0.1 (personal research tool)"
# id: (이름, 발표 지연 일수)
SERIES = {
    "DFII10": ("10년 실질금리(%)", 2),
    "BAMLH0A0HYM2": ("하이일드 스프레드 OAS(%)", 2),
    "NFCI": ("시카고연은 금융여건지수", 7),
    "ICSA": ("신규 실업수당 청구(건)", 6),
    "UNRATE": ("실업률(%)", 36),
}


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def fetch(sid):
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=%s&cosd=%s" % (sid, START)
    last = None
    for _ in range(2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf8", "replace")
        except urllib.error.HTTPError as e:
            last = "HTTP %d" % e.code
            if e.code in (403, 429):
                break  # 접근 제한: 우회하지 않는다
        except Exception as e:
            last = "%s" % type(e).__name__
        time.sleep(2)
    raise RuntimeError(last or "unknown")


def parse(csv):
    d, v = [], []
    for line in csv.splitlines()[1:]:
        p = line.strip().split(",")
        if len(p) < 2 or p[1] in ("", "."):
            continue
        try:
            d.append(p[0])
            v.append(float(p[1]))
        except ValueError:
            d.pop()
    return d, v


def main():
    old = read_json(OUT, {"series": {}})
    out = {"series": dict(old.get("series", {})), "fails": []}
    for sid, (name, lag) in SERIES.items():
        try:
            d, v = parse(fetch(sid))
            if len(d) < 20:
                raise RuntimeError("행 수 부족: %d" % len(d))
            out["series"][sid] = {"name": name, "lag": lag, "d": d, "v": v}
            print("OK   %-14s %5d rows, last %s = %s" % (sid, len(d), d[-1], v[-1]))
        except Exception as e:
            out["fails"].append({"id": sid, "err": str(e)})
            print("FAIL %-14s %s (기존 값 유지)" % (sid, e))
    out["updated"] = int(time.time())
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
