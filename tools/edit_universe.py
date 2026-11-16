"""종목 추가·삭제: data/universe.json 의 국내 종목 목록을 고친다. 배포 워크플로(수동 실행 입력)에서 호출된다.

입력(환경변수, 쉼표·줄바꿈·세미콜론으로 구분):
  ADD_CODES     "035420, 360750:TIGER 미국S&P500"  (코드 6자리, 이름은 선택)
  REMOVE_CODES  "035420"
- 입력은 코드 형식(영문 대문자·숫자 6자리)과 이름 문자를 엄격히 검사한다. 야후에 시세가 있는 코드(.KS 또는 .KQ)만 추가한다.
- 개별주/ETF 구분: DART 상장사 목록(DART_API_KEY 가 있을 때)에 있으면 개별주, 없으면 기타 ETF. 이름에 '레버리지'/'인버스'가 있으면 해당 그룹.
- 검증의 비교 기준(지수·섹터 ETF)과 시장 폭 계산에 쓰는 섹터 ETF는 삭제하지 않는다. 전체 종목은 60개까지.
- 결과는 표준 출력과 GITHUB_STEP_SUMMARY 에 남기고, 변경이 있으면 GITHUB_OUTPUT 에 changed=true 를 기록한다.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fund_kr import DATA, corp_map  # noqa: E402

UNI = os.environ.get("UNIVERSE_PATH") or os.path.join(DATA, "universe.json")
CODE = re.compile(r"^[0-9A-Z]{6}$")
NAME_OK = re.compile(r"[^0-9A-Za-z가-힣 \-&.()+]")
MAX_WATCH, MAX_ADD = 60, 10
UA = "trader-app/0.1 (personal research tool)"
PROTECTED_GROUPS = {"index", "sector"}


def split_items(s):
    out = []
    for part in re.split(r"[,\n;]+", s or ""):
        part = part.strip()
        if not part:
            continue
        code, _, name = part.partition(":")
        out.append((code.strip().upper(), NAME_OK.sub("", name).strip()[:30]))
    return out


def yahoo_symbol(code):
    for suf in (".KS", ".KQ"):
        url = "https://query1.finance.yahoo.com/v8/finance/chart/%s?range=5d&interval=1d" % urllib.parse.quote(code + suf)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                res = json.load(r)["chart"]["result"][0]
            if res.get("timestamp"):
                return code + suf, (res.get("meta", {}).get("shortName") or "").strip()
        except Exception:
            continue
    return None, ""


def main():
    with open(UNI, "r", encoding="utf8") as f:
        uni = json.load(f)
    watch = uni["watch"]
    adds, rems = split_items(os.environ.get("ADD_CODES")), split_items(os.environ.get("REMOVE_CODES"))
    log, changed = [], False

    cmap = {}
    key = os.environ.get("DART_API_KEY", "").strip()
    codes = [c for c, _ in adds if CODE.match(c)]
    if codes and len(key) == 40 and key.isalnum():
        try:
            cmap = corp_map(key, set(codes))
        except Exception as e:  # DART 가 막혀도 ETF 로 처리하고 계속한다
            log.append("참고: DART 상장사 목록을 받지 못해 개별주 자동 판별을 건너뜁니다(%s)" % type(e).__name__)

    for code, name in rems:
        if not CODE.match(code):
            log.append("삭제 건너뜀 %s: 코드 형식이 올바르지 않습니다" % code)
            continue
        hit = [w for w in watch if w["sym"].split(".")[0] == code]
        if not hit:
            log.append("삭제 건너뜀 %s: 목록에 없습니다" % code)
            continue
        w = hit[0]
        if w["group"] in PROTECTED_GROUPS:
            log.append("삭제 건너뜀 %s(%s): 검증 비교 기준·시장 폭에 쓰는 ETF라 삭제하지 않습니다" % (code, w["name"]))
            continue
        watch.remove(w)
        changed = True
        log.append("삭제: %s (%s)" % (w["name"], w["sym"]))

    n_add = 0
    for code, name in adds:
        if n_add >= MAX_ADD:
            log.append("추가 건너뜀 %s: 한 번에 %d개까지만 추가합니다" % (code, MAX_ADD))
            continue
        if not CODE.match(code):
            log.append("추가 건너뜀 %s: 코드는 영문 대문자·숫자 6자리여야 합니다" % code)
            continue
        if any(w["sym"].split(".")[0] == code for w in watch):
            log.append("추가 건너뜀 %s: 이미 목록에 있습니다" % code)
            continue
        if len(watch) >= MAX_WATCH:
            log.append("추가 건너뜀 %s: 전체 종목이 %d개를 넘을 수 없습니다" % (code, MAX_WATCH))
            continue
        sym, short = yahoo_symbol(code)
        if not sym:
            log.append("추가 건너뜀 %s: 야후에서 시세를 찾지 못했습니다(코드를 확인하세요)" % code)
            continue
        if code in cmap:
            group, nm = "stock", name or cmap[code].get("name") or short or code
        else:
            nm = name or short or code
            group = "inverse" if "인버스" in nm else "leverage" if "레버리지" in nm else "etf"
        lev = 2 if group == "leverage" else 1
        watch.append({"sym": sym, "name": nm, "market": "KR", "lev": lev, "group": group, "names": [code]})
        n_add += 1
        changed = True
        log.append("추가: %s (%s) · %s" % (nm, sym, {"stock": "개별주", "etf": "기타 ETF", "leverage": "레버리지 ETF", "inverse": "인버스 ETF"}[group]))

    if changed:
        tmp = UNI + ".tmp"
        with open(tmp, "w", encoding="utf8") as f:
            json.dump(uni, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, UNI)
    if not log:
        log.append("변경할 내용이 없습니다.")
    for line in log:
        print(line)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf8") as f:
            f.write("changed=%s\n" % ("true" if changed else "false"))
    summ = os.environ.get("GITHUB_STEP_SUMMARY")
    if summ:
        with open(summ, "a", encoding="utf8") as f:
            f.write("### 종목 변경 결과\n\n" + "\n".join("- " + x for x in log) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
