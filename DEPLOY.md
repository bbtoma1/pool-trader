# GitHub Pages 배포 절차

무료·PC 없이 운영하는 구성입니다. GitHub Actions 가 시세를 주기적으로 갱신해 GitHub Pages 로 배포합니다.
계정 가입·로그인 승인·키 입력은 **직접** 하셔야 합니다. `<...>` 는 본인 값으로 바꾸세요.

## 0. 먼저 알아둘 점
- **공개 저장소**여야 무료 Pages 를 쓸 수 있습니다. 코드와 시세 데이터가 공개됩니다. 개인 입력(현금·보유)은 기기 브라우저에만 저장되어 올라가지 않습니다.
- 배포된 앱은 누구나 열 수 있습니다. 투자 권유가 아니라는 문구가 화면에 있습니다.
- 시세는 비공식 출처(야후)라, 접근이 막히면 이전 데이터를 유지합니다(우회하지 않음).
- GitHub cron 은 UTC 기준이며 수 분~수십 분 늦을 수 있습니다. 정확한 실시간 시세용이 아닙니다.

## 1. 준비물 설치 (최초 1회)
```powershell
winget install Git.Git GitHub.cli
```
설치 후 터미널을 새로 엽니다.

## 2. 커밋 이메일을 noreply 주소로 (개인 이메일 노출 방지)
GitHub 의 Settings → Emails 에서 "Keep my email addresses private"를 켜고, 표시되는 `<숫자>+<계정>@users.noreply.github.com` 주소를 사용합니다.
```powershell
cd D:\Claude\app\trader
git init -b main
git config user.name "<계정>"
git config user.email "<숫자>+<계정>@users.noreply.github.com"
```

## 3. 배포 전 점검 (실패하면 올리지 마세요)
```powershell
python tools/privacy_check.py
```
"개인정보·비밀 점검 통과"가 나와야 합니다. 같은 점검이 Actions 에서도 매번 실행되고, 실패하면 배포가 중단됩니다.

## 4. 저장소 만들고 올리기
```powershell
gh auth login
```
브라우저에서 코드를 승인합니다(직접).
```powershell
git add .
git status
```
`git status` 에서 `data/px/`, `.claude/`, `_site/`, 키·설정 파일이 **목록에 없는지** 확인한 뒤:
```powershell
git commit -m "초기 커밋"
gh repo create <저장소> --public --source . --push
```

## 5. 비밀 값 등록 (국내 적정가를 쓸 때만)
`DART_API_KEY` 는 GitHub 저장소의 Settings → Secrets and variables → Actions → New repository secret 에서 등록합니다.
영문·숫자 40자인지 확인하세요. 값은 채팅·코드·스크린샷에 붙여넣지 마세요. 키를 등록하지 않아도 앱은 동작하고, 적정가만 갱신되지 않습니다.

## 6. Pages 켜기
저장소 Settings → Pages → Build and deployment → Source 를 **GitHub Actions** 로 선택합니다.
또는
```powershell
gh api -X POST repos/<계정>/<저장소>/pages -f build_type=workflow
```

## 7. 첫 실행
```powershell
gh workflow run update-data.yml -f fund=true
gh run watch
```
첫 실행은 전체 이력을 새로 받아 몇 분 걸립니다. 성공하면 `https://<계정>.github.io/<저장소>/` 에서 열립니다.
폰에서는 이 주소를 열고 브라우저 메뉴의 "홈 화면에 추가"를 선택합니다.

## 8. 운영
- 평일 국내 장중(10분), 장 마감 후 1회, 일요일(적정가) 자동 실행. 글로벌 변수(미 금리·달러·VIX 등)는 같은 실행에서 함께 갱신됩니다. 수동 실행은 Actions 탭 → update-data → Run workflow.
- 상단 칩이 "N시간 전"으로 오래되면 Actions 탭의 최근 실행 로그를 확인합니다.
- 저장소 활동이 60일 없으면 예약 실행이 멈출 수 있습니다. Actions 탭에서 다시 켜세요.
- "in progress deployment" 오류가 나면 잠시 뒤 다시 실행하면 됩니다(동시 실행 방지 설정이 있음).

## 9. 자주 막히는 곳
| 증상 | 대응 |
|---|---|
| 앱은 열리는데 데이터 없음 | 첫 워크플로 실행이 끝났는지, `data/manifest.json` 이 배포됐는지 확인 |
| 개인정보 점검 실패 | 로그에 나온 파일·줄을 수정(값은 출력되지 않음). 이메일은 noreply 만 허용 |
| 적정가가 갱신 안 됨 | `DART_API_KEY` Secret 이 40자 영숫자인지, 호출 제한 로그가 없는지 확인 |
| 시세 수집 일부 실패 | 정상 동작(기존 값 유지). 계속되면 해당 종목 코드를 확인 |
| 폰에서 옛 화면이 보임 | 서비스 워커 캐시. 새로고침을 한 번 더 하거나 홈 화면 앱을 닫고 다시 열기 |
