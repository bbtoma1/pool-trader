"""배포 폴더(_site)를 만든다: 앱 파일과 data/ 만 복사한다(tools, 서버, 문서, 비밀 파일은 제외)."""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "_site")
FILES = ["index.html", "styles.css", "app.js", "engine.js", "bt-worker.js", "sw.js", "manifest.webmanifest", "icon.svg"]
DATA_SKIP = {"corp_codes.json"}  # 내부 매핑 캐시는 배포하지 않음(다음 실행에서 다시 받음)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "data", "px"))
    for f in FILES:
        shutil.copy2(os.path.join(ROOT, f), os.path.join(OUT, f))
    data = os.path.join(ROOT, "data")
    for fn in os.listdir(data):
        p = os.path.join(data, fn)
        if os.path.isfile(p) and fn not in DATA_SKIP:
            shutil.copy2(p, os.path.join(OUT, "data", fn))
    px = os.path.join(data, "px")
    for fn in os.listdir(px):
        shutil.copy2(os.path.join(px, fn), os.path.join(OUT, "data", "px", fn))
    open(os.path.join(OUT, ".nojekyll"), "w").close()
    n = sum(len(fs) for _, _, fs in os.walk(OUT))
    print("_site 생성: 파일 %d개" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
