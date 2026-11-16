"""국내 '거물' 정보 수집(DART OpenAPI): 임원·주요주주 소유보고, 5% 대량보유 보고, 주요 공시.

- 인증키: 환경변수 DART_API_KEY (영문·숫자 40자). 키가 없거나 형식이 틀리면 아무것도 바꾸지 않고 종료한다.
- 대상: universe.json 의 국내 개별주(group == "stock"). ETF 는 해당 공시가 없어 제외.
- 호출 제한(020 등)·접근 제한(403/429)을 만나면 우회하지 않고 즉시 중단하고 기존 data/tracker_kr.json 을 유지한다.
- 공시 원문은 저장하지 않고 DART 뷰어 링크만 남긴다. 거래 방향은 참고 정보이며 매수 점수에 반영하지 않는다(검증 불가).
- 사용법: set DART_API_KEY=<키>   python tools/tracker_kr.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fund_kr import DATA, Limit, call, corp_map, num, read_json, write_json  # noqa: E402

WINDOW_DAYS = 120
OUT = os.path.join(DATA, "tracker_kr.json")
STATUS = os.path.join(DATA, "tracker_status.json")
VIEW = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo="

# 공시 제목 키워드 -> (분류, 성격). 성격: risk(주의), watch(참고), info(일반)
RULES = [
    ("횡령", "횡령·배임", "risk"), ("배임", "횡령·배임", "risk"), ("상장폐지", "상장폐지·관리", "risk"), ("관리종목", "상장폐지·관리", "risk"),
    ("거래정지", "거래정지", "risk"), ("불성실공시", "불성실공시", "risk"), ("감사의견", "감사의견", "risk"), ("회생", "회생·부도", "risk"), ("부도", "회생·부도", "risk"),
    ("유상증자", "유상증자", "risk"), ("전환사채", "전환사채(CB)", "risk"), ("신주인수권부사채", "신주인수권부사채(BW)", "risk"), ("교환사채", "교환사채(EB)", "risk"),
    ("감자", "감자", "risk"), ("소송", "소송", "watch"),
    ("자기주식취득", "자사주 취득", "watch"), ("자기주식 취득", "자사주 취득", "watch"), ("자기주식처분", "자사주 처분", "watch"), ("자기주식 처분", "자사주 처분", "watch"),
    ("무상증자", "무상증자", "watch"), ("합병", "합병·분할", "watch"), ("분할", "합병·분할", "watch"), ("영업양수", "영업양수도", "watch"), ("영업양도", "영업양수도", "watch"),
    ("단일판매", "공급계약", "watch"), ("공급계약", "공급계약", "watch"), ("최대주주", "최대주주 변경", "watch"), ("임원", "임원 변동", "info"),
    ("영업(잠정)실적", "잠정실적", "watch"), ("매출액또는손익구조", "손익 변동", "watch"), ("배당", "배당", "info"), ("주주총회", "주주총회", "info"),
    ("사업보고서", "정기보고서", "info"), ("분기보고서", "정기보고서", "info"), ("반기보고서", "정기보고서", "info"), ("조회공시", "조회공시", "watch"),
]


def classify(title):
    t = title or ""
    for kw, kind, tone in RULES:
        if kw in t:
            return kind, tone
    return "기타", "info"


def d8(s):  # 'YYYYMMDD' -> 'YYYY-MM-DD'
    s = str(s or "")
    return "%s-%s-%s" % (s[:4], s[4:6], s[6:8]) if len(s) >= 8 else s


def ymd(ts):
    return time.strftime("%Y%m%d", time.gmtime(ts))


def fmt_int(v):
    return num(v)


def fetch_filings(key, corp, bgn, end):
    items, page = [], 1
    while page <= 3:  # 종목당 최대 300건
        j = call(key, "list.json", corp_code=corp, bgn_de=bgn, end_de=end, page_no=str(page), page_count="100")
        if not j:
            break
        items += j.get("list", [])
        if page >= int(j.get("total_page", 1) or 1):
            break
        page += 1
    return items


def build(key, targets, cmap, now):
    cutoff = ymd(now - WINDOW_DAYS * 86400)
    today = ymd(now)
    items, fails = [], []
    for w in targets:
        sc = w["sym"].split(".")[0]
        try:
            if sc not in cmap:
                raise RuntimeError("corp_code 를 찾을 수 없음")
            corp = cmap[sc]["corp"]
            # 1) 임원·주요주주 소유보고
            j = call(key, "elestock.json", corp_code=corp)
            for r in (j or {}).get("list", []):
                if str(r.get("rcept_dt", "")).replace("-", "") < cutoff:
                    continue
                chg, aft = fmt_int(r.get("sp_stock_lmp_irds_cnt")), fmt_int(r.get("sp_stock_lmp_cnt"))
                rate = str(r.get("sp_stock_lmp_irds_rate") or "").replace(",", "").strip()
                items.append({
                    "sym": w["sym"], "name": w["name"], "kind": "exec", "date": d8(str(r.get("rcept_dt", "")).replace("-", "")),
                    "person": r.get("repror") or "", "role": (r.get("isu_exctv_ofcps") or r.get("isu_main_shrholdr") or "").strip(),
                    "change": chg, "after": aft, "rate": rate, "url": VIEW + str(r.get("rcept_no", "")),
                })
            # 2) 5% 대량보유 보고
            j = call(key, "majorstock.json", corp_code=corp)
            for r in (j or {}).get("list", []):
                if str(r.get("rcept_dt", "")).replace("-", "") < cutoff:
                    continue
                items.append({
                    "sym": w["sym"], "name": w["name"], "kind": "major", "date": d8(str(r.get("rcept_dt", "")).replace("-", "")),
                    "person": r.get("repror") or "", "role": (r.get("report_tp") or "").strip(), "reason": (r.get("report_resn") or "").strip(),
                    "change": fmt_int(r.get("stkqy_irds")), "after": fmt_int(r.get("stkqy")),
                    "rate": str(r.get("stkrt") or "").strip(), "rateChg": str(r.get("stkrt_irds") or "").strip(), "url": VIEW + str(r.get("rcept_no", "")),
                })
            # 3) 주요 공시(정기보고서 외 전체 목록에서 분류)
            for r in fetch_filings(key, corp, cutoff, today):
                if "소유상황보고서" in (r.get("report_nm") or "") or "대량보유상황보고서" in (r.get("report_nm") or ""):
                    continue  # 위 1)·2) 에서 세부 내용을 따로 받으므로 중복 제외
                kind, tone = classify(r.get("report_nm"))
                items.append({
                    "sym": w["sym"], "name": w["name"], "kind": "filing", "date": d8(r.get("rcept_dt")), "title": (r.get("report_nm") or "").strip(),
                    "tag": kind, "tone": tone, "filer": r.get("flr_nm") or "", "url": VIEW + str(r.get("rcept_no", "")),
                })
            time.sleep(0.2)
        except Limit:
            raise
        except Exception as e:
            fails.append({"sym": w["sym"], "err": str(e)})
            print("FAIL %-10s %s" % (w["sym"], e))
    items.sort(key=lambda x: (x["date"], x["sym"]), reverse=True)
    return items, fails


def main():
    key = os.environ.get("DART_API_KEY", "").strip()
    if len(key) != 40 or not key.isalnum():
        print("DART_API_KEY 가 없거나 형식이 올바르지 않습니다(영문·숫자 40자). 기존 tracker_kr.json 은 변경하지 않았습니다.")
        return 1 if key else 0
    uni = read_json(os.path.join(DATA, "universe.json"), None)
    targets = [w for w in uni["watch"] if w["market"] == "KR" and w["group"] == "stock"]
    status = {"updated": int(time.time()), "limited": False, "fails": [], "count": 0}
    try:
        cmap = corp_map(key, {w["sym"].split(".")[0] for w in targets})
        items, fails = build(key, targets, cmap, time.time())
        status["fails"], status["count"] = fails, len(items)
        if items or not fails:
            write_json(OUT, {"updated": status["updated"], "windowDays": WINDOW_DAYS, "items": items})
        print("공시·거래 %d건 저장 (실패 %d종목)" % (len(items), len(fails)))
    except Limit as e:
        status["limited"] = True
        print("중단: 호출 제한 또는 접근 제한 (%s). 기존 데이터를 유지합니다." % e)
    write_json(STATUS, status)
    return 0


if __name__ == "__main__":
    sys.exit(main())
