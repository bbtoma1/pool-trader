"""배포 직전 개인정보·비밀 점검. 발견되면 종료 코드 1 로 배포를 중단시킨다. 일치한 값은 화면에 출력하지 않는다(위치와 종류만).

점검: 이메일, 로컬 사용자 경로, 키·토큰 형태(이름=값, 40자 영숫자), 비밀 파일 이름(.env, config.json, *.pem, .wrangler 등)
사용법: python tools/privacy_check.py [폴더 ...]     (기본: 저장소 루트)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".wrangler", "_site"}
TEXT_EXT = {".py", ".js", ".json", ".html", ".css", ".md", ".yml", ".yaml", ".txt", ".webmanifest", ".svg", ".bat", ".toml", ""}
BAD_NAMES = re.compile(r"(^\.env($|\.)|^config\.json$|\.pem$|\.key$|^id_rsa|\.sqlite$|\.db$)", re.I)
ALLOWED_EMAIL = re.compile(r"(noreply|no-reply)@|@(example\.(com|org)|users\.noreply\.github\.com)$", re.I)

EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
WINPATH = re.compile(r"[A-Za-z]:\\\\?Users\\\\?[^\\\s\"']+", re.I)
POSIXHOME = re.compile(r"/(Users|home)/[A-Za-z0-9._\-]+/")
KV = re.compile(r"""(?i)(api[_-]?key|crtfc_key|secret|token|password|passwd|authorization)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{16,})""")
LONG = re.compile(r"\b[A-Za-z0-9]{40}\b")
ENV_REF = re.compile(r"(?i)(secrets\.|environ|getenv|\$\{\{|\$env:|<.*>|여기에|your[_-]?key)")


def has_letter_digit(s):
    return any(c.isalpha() for c in s) and any(c.isdigit() for c in s)


def scan_file(path, rel, findings):
    try:
        with open(path, "r", encoding="utf8", errors="ignore") as f:
            for n, line in enumerate(f, 1):
                if len(line) > 4000:  # 시세 JSON 같은 한 줄 데이터는 숫자 배열이라 형태만 검사
                    line = line[:4000]
                for m in EMAIL.finditer(line):
                    if not ALLOWED_EMAIL.search(m.group(0)):
                        findings.append((rel, n, "이메일 주소"))
                if WINPATH.search(line) or POSIXHOME.search(line):
                    findings.append((rel, n, "로컬 사용자 경로"))
                for m in KV.finditer(line):
                    if not ENV_REF.search(line) and has_letter_digit(m.group(2)):
                        findings.append((rel, n, "키·토큰 형태(%s=…)" % m.group(1)))
                for m in LONG.finditer(line):
                    if has_letter_digit(m.group(0)) and not ENV_REF.search(line):
                        findings.append((rel, n, "40자 영숫자 문자열(키 형태)"))
    except OSError:
        pass


def main(argv):
    roots = [os.path.abspath(a) for a in argv] or [ROOT]
    findings, names = [], []
    count = 0
    for base in roots:
        for d, dirs, files in os.walk(base):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            for fn in files:
                p = os.path.join(d, fn)
                rel = os.path.relpath(p, base)
                if BAD_NAMES.search(fn):
                    names.append(rel)
                    continue
                if os.path.splitext(fn)[1].lower() in TEXT_EXT:
                    count += 1
                    scan_file(p, rel, findings)
    # 이 스크립트 자신의 패턴 정의는 제외
    findings = [f for f in findings if os.path.basename(f[0]) != "privacy_check.py"]
    print("점검 파일 %d개" % count)
    for n in names:
        print("금지 파일: %s" % n)
    for rel, n, kind in findings[:50]:
        print("의심: %s:%d  %s" % (rel, n, kind))
    if names or findings:
        print("개인정보·비밀 점검 실패: 배포를 중단합니다.")
        return 1
    print("개인정보·비밀 점검 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
