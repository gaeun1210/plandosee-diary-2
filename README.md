# 플랜두씨 다이어리 2 (과제 7)

과제 6에서 만든 **플랜두씨 다이어리**(계획 → 실제로 한 일 → 돌아보기)에 **가입·로그인**을 붙여, 내 기록을 나만 보게 만든 판입니다.

- 이어서 쓴 과제 6 최종 제출: <https://plandosee-diary-ten.vercel.app> · 커밋 [`a7da53e`](https://github.com/gaeun1210/plandosee-diary/commit/a7da53e7f118ac85d87c7c5c0b0ce4331ab4ae11)
  - 이 저장소는 과제 6 저장소의 Git 이력을 그대로 가져와 그 위에 쌓았습니다. `git log`에서 `a7da53e`가 조상으로 보입니다.
  - 과제 6 주소·저장소·DB는 건드리지 않았습니다(과제 6 제출 화면이 그대로 남도록).
- 제출문(인증 구현 설명서·확인 기록·5일 기록): [SUBMISSION.md](SUBMISSION.md)

## 무엇이 달라졌나

| | 과제 6 | 과제 7 |
|---|---|---|
| 첫 화면 | 다이어리(누구나) | 로그인 화면 |
| 자료 주인 | 없음(모두 공용) | 모든 표에 `user_id`, 모든 SQL에 주인 조건 |
| 비밀번호 | — | bcryptjs 3.0.3 (비용 12) |
| 로그인 기억 | — | 무작위 세션 값(HttpOnly 쿠키) + DB 세션 표, 7일 만료 |
| 새 화면 | — | 로그인·가입, 계정(비밀번호 바꾸기·과제 6 자료 가져오기·내보내기·계정 삭제), 5일 실험 |

## 구조

```
server.js                   Express 서버 + API. 인증 라우트(/api/auth/*)와 주인 확인이 모두 여기
lib/auth.js                 비밀번호 해시(bcrypt)·세션 값·쿠키 도구
api/index.js                Vercel 서버리스 함수 입구 (server.js를 그대로 씀)
vercel.json                 Vercel 설정 (화면 폴더·싱가포르 지역(DB와 같은 곳)·보안 헤더)
db/schema.sql               표·제약·트리거 v3 (서버 시작 때 자동 적용, 여러 번 실행해도 안전)
contracts/pds-schema-v3.json 표·규칙·인증 방식 정리 (v2는 과제 6 것 그대로 둠)
public/index.html           화면 (로그인 화면 + 다이어리)
public/auth.js              로그인·가입·로그아웃·계정 메뉴
public/app.js               다이어리 화면 (과제 6 코드 + 로그인 뒤에만 시작)
public/exp.js               5일 실험 화면
scripts/verify-auth.mjs     인증 확인 32가지를 실제 요청으로 돌리고 기록(비밀값 가림)을 만드는 스크립트
.github/workflows/verify.yml 위 스크립트를 CI(임시 DB)와 배포 주소에 돌림
docs/evidence/              배포 주소에 돌린 확인 기록
```

## 배포 (무료)

과제 6 DB(Supabase `plandosee_diary`)와는 따로, 새 PostgreSQL을 씁니다. 둘 중 하나:

- **Neon (Vercel에서 바로 만들기, 이번 배포에 사용)**: Vercel → Add New → Project → `plandosee-diary-2` Import → Framework Preset **Other** → Deploy. 그다음 프로젝트의 **Storage → Create Database → Neon**(지역 Seoul 또는 가까운 곳) → 이 프로젝트에 연결하면 `DATABASE_URL`이 환경변수로 자동으로 들어갑니다. `PGSSL`은 넣지 않습니다(인증서까지 검증). 연결한 뒤 **Deployments → Redeploy** 한 번.
- **Supabase 새 프로젝트**: New project(지역 Seoul) → **Connect → Session pooler** 주소의 `[YOUR-PASSWORD]`를 DB 비밀번호로 바꿔 Vercel 환경변수 `DATABASE_URL`에, `PGSSL`=`no-verify`. (무료 요금제는 계정당 동시에 켜 둘 수 있는 프로젝트가 2개까지입니다.)

1. 위 방법으로 DB 주소를 Vercel 환경변수에만 넣습니다. 이 주소가 비밀값입니다.
2. Deploy(또는 Redeploy).
3. 새 시크릿 창에서 배포 주소를 열면 로그인 화면이 나옵니다. 표는 첫 요청 때 자동으로 생깁니다.

로그인을 위한 별도 비밀키(JWT 서명키 등)는 없습니다. 세션 값은 서명하지 않은 무작위 값이고, 서버는 DB에 그 해시가 있는지로만 확인합니다. 따라서 환경변수는 과제 6과 같은 `DATABASE_URL`, `PGSSL` 두 개뿐입니다.

내 컴퓨터에서: `cp .env.example .env` → 값 채우기 → `npm install` → `npm run dev` → http://localhost:3000

## 확인 스크립트

```bash
BASE=https://배포-주소 node scripts/verify-auth.mjs > 확인기록.md
```
시험 계정 3개를 무작위 비밀번호로 만들어 가입·로그인·로그아웃·비밀번호 변경·남의 자료 읽기/수정/삭제(양방향)·로그인 없는 요청·목록 섞임·계정 삭제를 확인합니다. 비밀번호는 어디에도 출력하지 않고, 세션 값은 앞 4글자만 남깁니다.
GitHub의 Actions → verify-auth → Run workflow에 배포 주소를 넣으면 같은 확인을 하고 결과를 `docs/evidence/`에 커밋합니다.

## 비밀값 점검

```bash
# Git 기록 전체에서 실제 접속 주소(비밀번호가 들어간 형태)·Supabase 키 모양 찾기
# ([YOUR-PASSWORD] 같은 자리표시는 빼고, 검사식이 자기 자신에 걸리지 않게 [s]처럼 적었다)
git log -p --all | grep -nE "postgres(ql)?://[^@[:space:]]+:[^@[:space:][]+@|sb_[s]ecret_|service_[r]ole|eyJ[h]bGci" || echo "Git 기록 깨끗"
# 배포되는 화면 파일
grep -rnE "postgres(ql)?://|sb_[s]ecret_|service_[r]ole" public/ || echo "배포되는 화면 파일 깨끗"
```

## 과제 6에서 그대로 가져온 것

계획·할 일·실행 기록·돌아보기, 타이머·칸반 보드·캘린더, 연두 노트 표지 디자인, 배경 음악, AI로 만든 그림(거북이·포춘쿠키·별·클로버). 자세한 출처는 과제 6 README에 있습니다. 모든 사용자 글자는 `textContent`로만 화면에 넣습니다.
