"""국내 개별주 적정가(도키 관점): DART OpenAPI 의 연간 영업활동현금흐름과 발행주식수로 계산한다.

- 인증키: 환경변수 DART_API_KEY (DART 오픈API 사이트에서 본인이 신청). 키가 없으면 아무것도 바꾸지 않고 종료한다.
- 주당현금흐름(CFPS) = 영업활동현금흐름 / (발행주식수 - 자기주식수)
- 성장률 g = 최근 최대 5년 영업현금흐름 CAGR 을 5~20% 로 제한(자료가 부족하면 5%)
- 적정가 = CFPS x (1+g)^5 x 멀티플(18) / (1+요구수익률(10%))^5
- 금융업(은행·보험·증권)은 영업현금흐름이 의미 없어 '해당 없음'(na) 처리
- 이력(hist)에 공시일(filed)을 남겨 백테스트에서 공시 이후부터만 쓰게 한다(룩어헤드 방지)
- 한도(상태 020) 등 제한을 만나면 즉시 중단하고 기존 값을 유지한다. 우회하지 않는다.

사용법:  set DART_API_KEY=<키>   python tools/fund_kr.py        |   python tools/fund_kr.py --selftest
"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
BASE = "https://opendart.fss.or.kr/api/"
MULT, REQ, G_MIN, G_MAX, HORIZON = 18.0, 0.10, 0.05, 0.20, 5
FIN_PREFIX = ("64", "65", "66")  # 한국표준산업분류 금융·보험업


class Limit(Exception):
    pass


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


def num(x):
    x = str(x or "").replace(",", "").strip()
    if x in ("", "-"):
        return 0
    try:
        return int(float(x))
    except ValueError:
        return 0


# ---------- 순수 계산(자체 테스트 대상) ----------
def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def build_history(rows):
    """rows: [{fy, filed('YYYY-MM-DD'), cfo, shares(유통), ...}] 연도 오름차순 -> 적정가 이력"""
    rows = sorted(rows, key=lambda r: r["fy"])
    hist = []
    for k, r in enumerate(rows):
        base = [x for x in rows[max(0, k - 4): k + 1]]  # 최대 5개 연도
        cagr = None
        if len(base) >= 3 and base[0]["cfo"] > 0 and base[-1]["cfo"] > 0:
            cagr = (base[-1]["cfo"] / base[0]["cfo"]) ** (1.0 / (len(base) - 1)) - 1
        g = clamp(cagr if cagr is not None else G_MIN, G_MIN, G_MAX)
        sh = r["shares"]
        cfps = r["cfo"] / sh if sh > 0 else None
        fair = None
        if cfps is not None and cfps > 0 and r["cfo"] > 0:
            fair = cfps * (1 + g) ** HORIZON * MULT / (1 + REQ) ** HORIZON
        hist.append({
            "fy": r["fy"], "filed": r["filed"], "cfo": r["cfo"], "shares": sh,
            "cfps": round(cfps, 2) if cfps is not None else None,
            "cagr": round(cagr, 4) if cagr is not None else None,
            "g": round(g, 4), "fair": round(fair, 2) if fair else None,
        })
    return hist


def selftest():
    rows = [
        {"fy": 2020, "filed": "2021-03-10", "cfo": 100_000_000_000, "shares": 1_000_000_000},
        {"fy": 2021, "filed": "2022-03-10", "cfo": 120_000_000_000, "shares": 1_000_000_000},
        {"fy": 2022, "filed": "2023-03-10", "cfo": 144_000_000_000, "shares": 1_000_000_000},
        {"fy": 2023, "filed": "2024-03-10", "cfo": -5, "shares": 1_000_000_000},
    ]
    h = build_history(rows)
    assert h[0]["cagr"] is None and h[0]["g"] == G_MIN, h[0]            # 자료 부족 -> 보수적 5%
    assert abs(h[2]["cagr"] - 0.2) < 1e-3 and h[2]["g"] == G_MAX, h[2]  # CAGR 20%
    exp = 144 * 1.2 ** 5 * 18 / 1.1 ** 5                                  # CFPS 144원
    assert abs(h[2]["fair"] - exp) < 0.05, (h[2]["fair"], exp)
    assert h[3]["fair"] is None, h[3]                                     # 영업현금흐름 적자 -> 적정가 없음
    assert num("1,234") == 1234 and num("-") == 0 and num(None) == 0
    print("selftest OK: fair(2022) = %.0f원/주" % h[2]["fair"])
    return 0


# ---------- DART 호출 ----------
def call(key, path, **params):
    q = urllib.parse.urlencode(dict(crtfc_key=key, **params))
    req = urllib.request.Request(BASE + path + "?" + q, headers={"User-Agent": "trader-app/0.1 (personal research tool)"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            raise Limit("HTTP %d" % e.code)
        raise
    if path.endswith(".xml"):
        return raw
    j = json.loads(raw.decode("utf8"))
    st = j.get("status")
    if st == "000":
        return j
    if st == "013":  # 조회된 데이터 없음
        return None
    if st in ("020", "021"):  # 한도 초과 등
        raise Limit("DART status %s: %s" % (st, j.get("message")))
    raise RuntimeError("DART status %s: %s" % (st, j.get("message")))


def corp_map(key, codes):
    path = os.path.join(DATA, "corp_codes.json")
    cache = read_json(path, {})
    if all(c in cache for c in codes):
        return cache
    raw = call(key, "corpCode.xml")
    if not raw.startswith(b"PK"):  # zip 이 아니면 오류 XML(인증키 오류·한도 등)
        msg = ET.fromstring(raw).findtext("message") if raw[:5] == b"<?xml" else "알 수 없는 응답"
        raise Limit("corpCode 응답 오류: %s" % msg)
    z = zipfile.ZipFile(io.BytesIO(raw))
    root = ET.fromstring(z.read(z.namelist()[0]))
    for it in root.iter("list"):
        sc = (it.findtext("stock_code") or "").strip()
        if sc in codes:
            cache[sc] = {"corp": it.findtext("corp_code"), "name": it.findtext("corp_name")}
    write_json(path, cache)
    return cache


def fetch_cfo(key, corp, year):
    for fs in ("CFS", "OFS"):  # 연결 우선
        j = call(key, "fnlttSinglAcntAll.json", corp_code=corp, bsns_year=str(year), reprt_code="11011", fs_div=fs)
        if not j:
            continue
        for r in j.get("list", []):
            nm = (r.get("account_nm") or "")
            if r.get("sj_div") == "CF" and "영업활동" in nm and "현금흐름" in nm:
                rc = r.get("rcept_no", "")
                filed = "%s-%s-%s" % (rc[:4], rc[4:6], rc[6:8]) if len(rc) >= 8 else "%d-12-31" % (year + 1)
                return {"cfo": num(r.get("thstrm_amount")), "filed": filed, "fs": fs}
    return None


def fetch_shares(key, corp, year):
    j = call(key, "stockTotqySttus.json", corp_code=corp, bsns_year=str(year), reprt_code="11011")
    if not j:
        return None
    # 보통주+우선주를 모두 더한다(영업현금흐름은 회사 전체 값이라 우선주 몫도 분모에 포함). 구분이 없으면 합계 행 사용.
    rows = j.get("list", [])
    parts = [r for r in rows if "보통" in (r.get("se") or "") or "우선" in (r.get("se") or "")]
    if not parts:
        parts = [r for r in rows if "합계" in (r.get("se") or "")]
    out = sum(num(r.get("istc_totqy")) - num(r.get("tesstk_co")) for r in parts)
    return out if out > 0 else None


def is_financial(key, corp):
    j = call(key, "company.json", corp_code=corp)
    code = (j or {}).get("induty_code") or ""
    return code.startswith(FIN_PREFIX)


def main():
    if "--selftest" in sys.argv:
        return selftest()
    key = os.environ.get("DART_API_KEY", "").strip()
    if not key:
        print("DART_API_KEY 환경변수가 없습니다. DART 오픈API(opendart.fss.or.kr)에서 인증키를 직접 신청한 뒤")
        print("  set DART_API_KEY=<키>   (Windows)   /   export DART_API_KEY=<키>   (macOS·Linux)")
        print("로 설정하고 다시 실행하세요. 기존 fund.json 은 변경하지 않았습니다.")
        return 0
    if len(key) != 40 or not key.isalnum():  # DART 인증키는 영문·숫자 40자. 값은 출력하지 않는다.
        print("DART_API_KEY 형식이 올바르지 않습니다(현재 %d자). 영문·숫자 40자여야 합니다." % len(key))
        print("앞뒤 공백·따옴표·다른 서비스 키가 섞이지 않았는지 확인하고 다시 설정하세요. 기존 fund.json 은 변경하지 않았습니다.")
        return 1
    uni = read_json(os.path.join(DATA, "universe.json"), None)
    targets =[w for w in uni["watch"] if w["market"] == "KR" and w["group"] == "stock"]
    codes = {w["sym"].split(".")[0] for w in targets}
    fund_path = os.path.join(DATA, "fund.json")
    fund = read_json(fund_path, {})
    status = {"updated": int(time.time()), "ok": [], "fails": [], "limited": False}
    try:
        cmap = corp_map(key, codes)
        this_year = time.gmtime().tm_year
        for w in targets:
            sc = w["sym"].split(".")[0]
            try:
                if sc not in cmap:
                    raise RuntimeError("corp_code 를 찾을 수 없음")
                corp = cmap[sc]["corp"]
                if is_financial(key, corp):
                    fund[w["sym"]] = {"src": "DART", "unit": "KRW", "na": True, "reason": "금융업은 영업현금흐름 기반 적정가 해당 없음", "t": int(time.time())}
                    status["ok"].append(w["sym"] + " (금융업, 해당 없음)")
                    continue
                rows = []
                for y in range(this_year - 1, this_year - 8, -1):
                    c = fetch_cfo(key, corp, y)
                    if not c:
                        continue
                    sh = fetch_shares(key, corp, y)
                    if not sh:
                        continue
                    rows.append({"fy": y, "filed": c["filed"], "cfo": c["cfo"], "shares": sh})
                    if len(rows) >= 6:
                        break
                if not rows:
                    raise RuntimeError("재무 데이터를 받지 못함")
                hist = build_history(rows)
                last = hist[-1]
                fund[w["sym"]] = {
                    "src": "DART", "unit": "KRW", "na": False, "mult": MULT, "r": REQ, "years": len(hist),
                    "asof": last["fy"], "filed": last["filed"], "cfps": last["cfps"], "g": last["g"], "cagr": last["cagr"],
                    "fair": last["fair"], "hist": hist, "t": int(time.time()),
                }
                status["ok"].append(w["sym"])
                print("OK   %-10s FY%d CFPS %s g %.0f%% 적정가 %s" % (w["sym"], last["fy"], last["cfps"], last["g"] * 100, last["fair"]))
            except Limit:
                raise
            except Exception as e:  # 개별 종목 실패는 기존 값 유지
                status["fails"].append({"sym": w["sym"], "err": str(e)})
                print("FAIL %-10s %s (기존 값 유지)" % (w["sym"], e))
    except Limit as e:
        status["limited"] = True
        print("중단: 호출 제한 (%s). 기존 값을 유지합니다. 시간을 두고 다시 실행하세요." % e)
    write_json(fund_path, fund)
    write_json(os.path.join(DATA, "fund_status.json"), status)
    return 0


if __name__ == "__main__":
    sys.exit(main())
