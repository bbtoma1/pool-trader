"""이전 배포본의 data/ 를 내려받아 이어붙일 기반을 만든다(저장소에는 시세 이력을 커밋하지 않기 때문).
- 배포 주소: 환경변수 SITE_URL, 없으면 GITHUB_REPOSITORY(owner/repo)로 https://<owner>.github.io/<repo>/ 를 만든다.
- 받지 못하면(첫 배포 등) 조용히 건너뛴다. 이후 update_data.py 가 전체 이력을 새로 받는다.
"""
import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")


def site_url():
    u = os.environ.get("SITE_URL", "").strip()
    if not u:
        repo = os.environ.get("GITHUB_REPOSITORY", "")
        if "/" not in repo:
            return None
        owner, name = repo.split("/", 1)
        u = "https://%s.github.io/%s/" % (owner.lower(), name)
    return u if u.endswith("/") else u + "/"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "trader-app/0.1 (deploy seed)"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


def save(rel, raw):
    p = os.path.join(DATA, *rel.split("/"))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(raw)


def main():
    base = site_url()
    if not base:
        print("배포 주소를 알 수 없어 건너뜁니다(SITE_URL 또는 GITHUB_REPOSITORY 없음).")
        return 0
    got = 0
    try:
        uni = json.load(open(os.path.join(DATA, "universe.json"), encoding="utf8"))
    except (OSError, ValueError):
        print("universe.json 없음")
        return 0
    syms = list(uni.get("helpers", [])) + [w["sym"] for w in uni["watch"]]
    for rel in ["data/manifest.json", "data/fund.json", "data/fund_status.json", "data/corp_codes.json", "data/macro.json"]:
        try:
            save(rel[len("data/"):], get(base + rel))
            got += 1
        except (urllib.error.URLError, OSError):
            pass
    for s in syms:
        rel = "px/%s.json" % s.replace("^", "_")
        try:
            save(rel, get(base + "data/" + rel))
            got += 1
        except (urllib.error.URLError, OSError):
            pass
    print("이전 배포본에서 %d개 파일을 이어받았습니다." % got if got else "이전 배포본이 없어 새로 수집합니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
