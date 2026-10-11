#!/usr/bin/env node
// 인증 확인 기록 만들기 — 배포된 주소에 실제 요청을 보내고, 요청·응답을 나란히 Markdown으로 적는다.
// 사용: BASE=https://내-주소 node scripts/verify-auth.mjs > evidence.md
//
// - 시험용 계정 3개(chk_a·chk_b·chk_c + 무작위 꼬리)를 새로 만든다. 비밀번호는 실행할 때마다 무작위로 만들고 어디에도 출력하지 않는다.
// - chk_a와 chk_b는 같은 비밀번호로 만든다(저장된 해시가 서로 다른지 DB에서 확인하기 위해).
// - 세션 값은 앞 4글자만 남기고 가린다. 비밀번호는 "(가림)"으로 바꿔 적는다.
// - 맨 끝에서 모든 응답 본문·머리글에 비밀번호 원문이 한 번도 나오지 않았는지 센다.
// - chk_c는 비밀번호 바꾸기와 계정 삭제 시험에 쓰고 지운다. chk_a·chk_b는 DB 확인용으로 남긴다.

import crypto from 'node:crypto';

const BASE = (process.env.BASE || '').replace(/\/$/, '');
if (!BASE) { console.error('BASE 환경변수에 주소를 넣으세요.'); process.exit(2); }

const tail = crypto.randomBytes(3).toString('hex');
const PW = `Pw-${crypto.randomBytes(18).toString('base64url')}`; // A·B 공통, 출력하지 않음
const PW_C = `Pc-${crypto.randomBytes(18).toString('base64url')}`;
const PW_C2 = `Pn-${crypto.randomBytes(18).toString('base64url')}`;
const SECRETS = [PW, PW_C, PW_C2];
const IDS = { a: `chk_a_${tail}`, b: `chk_b_${tail}`, c: `chk_c_${tail}` };

const out = [];
const p = (s = '') => out.push(s);
const seenBodies = [];
const seenTokens = [];
let pass = 0; let fail = 0;
const results = [];

const mask = (t) => (t ? `${t.slice(0, 4)}…(가림)` : '(없음)');
function maskText(s) {
  let r = String(s);
  for (const x of SECRETS) r = r.split(x).join('(가림)');
  for (const t of seenTokens) r = r.split(t).join(mask(t));
  return r;
}
const short = (s, n = 700) => (s.length > n ? `${s.slice(0, n)} …(이하 ${s.length - n}자 생략)` : s);

// 한 번의 요청: 머리글·본문·응답을 기록한다
async function req(label, method, path, { cookie, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (method !== 'GET' && h['X-Requested-With'] === undefined) h['X-Requested-With'] = 'pds-diary';
  if (h['X-Requested-With'] === null) delete h['X-Requested-With'];
  if (cookie) h.Cookie = `${cookie.name}=${cookie.value}`;
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  let got = null;
  for (const sc of setCookie) {
    const m = /^([^=]+)=([^;]*)/.exec(sc);
    if (m && m[2]) { got = { name: m[1], value: m[2], attrs: sc.slice(m[0].length) }; seenTokens.push(m[2]); }
  }
  seenBodies.push(text, setCookie.join('\n'), [...res.headers.entries()].map((e) => e.join(': ')).join('\n'));
  let json = null;
  try { json = JSON.parse(text); } catch { /* html 등 */ }
  // 기록
  p(`**${label}**`);
  p('```http');
  p(`${method} ${path}`);
  for (const [k, v] of Object.entries(h)) {
    if (k === 'Cookie') p(`Cookie: ${cookie.name}=${mask(cookie.value)}`);
    else p(`${k}: ${v}`);
  }
  if (body !== undefined) {
    const b = { ...body };
    for (const k of ['password', 'current_password', 'new_password']) if (k in b) b[k] = '(가림)';
    p('');
    p(JSON.stringify(b));
  }
  p('');
  p(`→ HTTP ${res.status}`);
  for (const sc of setCookie) {
    const m = /^([^=]+)=([^;]*)(.*)$/.exec(sc);
    p(`Set-Cookie: ${m[1]}=${m[2] ? mask(m[2]) : ''}${m[3]}`);
  }
  if (raw) p(short(text.replace(/\s+/g, ' '), 300));
  else p(maskText(short(text)));
  p('```');
  return { status: res.status, json, text, cookie: got };
}

function check(id, desc, ok, note = '') {
  results.push({ id, desc, ok, note });
  if (ok) pass++; else fail++;
  p(`> ${ok ? '✅ 통과' : '❌ 실패'} — ${id} ${desc}${note ? ` (${note})` : ''}`);
  p('');
}

const now = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());

// ======================================================================
p(`# 인증 확인 기록 (자동 실행)`);
p('');
p(`- 대상: ${BASE}`);
p(`- 실행 시각: ${now()} (Asia/Seoul)`);
p(`- 시험 계정: \`${IDS.a}\`, \`${IDS.b}\`, \`${IDS.c}\` — 비밀번호는 실행 때 무작위로 만들었고 이 문서·로그 어디에도 적지 않았다. \`${IDS.a}\`와 \`${IDS.b}\`는 같은 비밀번호다.`);
p('- 세션 값은 앞 4글자만 남기고 `…(가림)`으로 적었다. 요청 본문의 비밀번호 칸은 `(가림)`으로 바꿔 적었다.');
p('');

// ---------- 0. 로그인 없이 ----------
p('## 0. 로그인하지 않은 상태');
p('');
let r = await req('첫 화면 HTML (로그인 없이)', 'GET', '/?plan=1', { raw: true });
check('C03/C97', '첫 화면은 로그인 화면(로그인 폼 포함), 자료는 HTML에 없음',
  r.status === 200 && r.text.includes('id="auth-screen"') && r.text.includes('id="auth-form"'));
r = await req('자료 API를 로그인 없이 직접 요청', 'GET', '/api/plans');
check('C97/C124', '로그인 없이 자료 요청 → 401', r.status === 401);

// ---------- 1. 가입 ----------
p('## 1. 가입 (카드 1)');
p('');
r = await req(`가입: ${IDS.a}`, 'POST', '/api/auth/signup', { body: { login_id: IDS.a, password: PW } });
check('C94', '새 계정 만들기 → 201', r.status === 201);
const cA0 = r.cookie;
check('C112', '세션 값은 쿠키(HttpOnly)로만 오고 응답 본문·주소에 없음',
  !!cA0 && /HttpOnly/i.test(cA0.attrs) && !r.text.includes(cA0.value));
r = await req(`같은 아이디로 다시 가입: ${IDS.a}`, 'POST', '/api/auth/signup', { body: { login_id: IDS.a, password: PW } });
check('C98', '같은 아이디 두 번째 가입 → 409', r.status === 409);
r = await req(`대문자로 바꿔 다시 가입: ${IDS.a.toUpperCase()}`, 'POST', '/api/auth/signup', { body: { login_id: IDS.a.toUpperCase(), password: PW } });
check('C98', '대소문자만 바꾼 같은 아이디 → 409', r.status === 409);
r = await req(`가입: ${IDS.b} (${IDS.a}와 같은 비밀번호)`, 'POST', '/api/auth/signup', { body: { login_id: IDS.b, password: PW } });
check('C104 준비', '같은 비밀번호로 두 번째 계정 → 201', r.status === 201);
const cB = r.cookie;
r = await req(`가입: ${IDS.c}`, 'POST', '/api/auth/signup', { body: { login_id: IDS.c, password: PW_C } });
const cC0 = r.cookie;

// ---------- 2. 로그인 실패 문구 ----------
p('## 2. 로그인 실패 안내 문구 (카드 1)');
p('');
const wrongPw = await req(`있는 아이디 + 틀린 비밀번호`, 'POST', '/api/auth/login', { body: { login_id: IDS.a, password: `${PW}x` } });
const noUser = await req(`없는 아이디`, 'POST', '/api/auth/login', { body: { login_id: `nobody_${tail}`, password: PW } });
check('C99', '두 경우 상태 코드와 문구가 똑같음',
  wrongPw.status === 401 && noUser.status === 401 && wrongPw.text === noUser.text, `둘 다 ${wrongPw.status} ${wrongPw.text}`);

// ---------- 3. 로그인 → 로그아웃 → 같은 값으로 다시 ----------
p('## 3. 로그인·로그아웃과 같은 값으로 다시 요청 (카드 3)');
p('');
r = await req(`로그인: ${IDS.a}`, 'POST', '/api/auth/login', { body: { login_id: IDS.a, password: PW } });
check('C95', '만든 계정으로 로그인 → 200', r.status === 200);
const cA1 = r.cookie;
const maxAge = Number((/Max-Age=(\d+)/i.exec(cA1.attrs) || [])[1]);
check('C111', '세션 값에 만료가 있음', maxAge > 0, `Max-Age=${maxAge}초 = ${(maxAge / 86400).toFixed(2)}일, 응답의 session_expires_at=${r.json && r.json.session_expires_at}`);
const beforeMe = await req('[로그아웃 전] 같은 쿠키로 /api/auth/me', 'GET', '/api/auth/me', { cookie: cA1 });
const before = await req('[로그아웃 전] 같은 쿠키로 내 계획 목록', 'GET', '/api/plans', { cookie: cA1 });
r = await req('로그아웃', 'POST', '/api/auth/logout', { cookie: cA1 });
check('C96', '로그아웃 → 200, 서버 세션 1개 지움', r.status === 200 && r.json && r.json.sessions_ended === 1);
const afterMe = await req('[로그아웃 뒤] 같은 쿠키 값으로 /api/auth/me', 'GET', '/api/auth/me', { cookie: cA1 });
const after = await req('[로그아웃 뒤] 같은 쿠키 값으로 내 계획 목록', 'GET', '/api/plans', { cookie: cA1 });
check('C109/C110', '같은 주소·같은 방식·같은 쿠키 값: 로그아웃 전 200, 뒤 401 (두 주소 모두)',
  beforeMe.status === 200 && before.status === 200 && afterMe.status === 401 && after.status === 401,
  `/api/auth/me 전 ${beforeMe.status} → 뒤 ${afterMe.status}, /api/plans 전 ${before.status} → 뒤 ${after.status}`);

// ---------- 4. 비밀번호 바꾸면 이전 값 끊김 ----------
p('## 4. 비밀번호를 바꾸면 이전에 발급한 값이 끊김 (카드 3)');
p('');
r = await req(`다른 기기에서 로그인했다고 치고 ${IDS.c} 로그인 한 번 더`, 'POST', '/api/auth/login', { body: { login_id: IDS.c, password: PW_C } });
const cC1 = r.cookie;
const c0ok = await req('[바꾸기 전] 첫 번째 쿠키로 /api/auth/me', 'GET', '/api/auth/me', { cookie: cC0 });
r = await req('첫 번째 쿠키로 비밀번호 바꾸기', 'POST', '/api/auth/password', { cookie: cC0, body: { current_password: PW_C, new_password: PW_C2 } });
const cC2 = r.cookie;
check('C114 준비', '비밀번호 바꾸기 → 200, 이전 세션 2개 모두 끊음', r.status === 200 && r.json.sessions_ended === 2);
const c0after = await req('[바꾼 뒤] 첫 번째 쿠키(옛 값)로 같은 요청', 'GET', '/api/auth/me', { cookie: cC0 });
const c1after = await req('[바꾼 뒤] 다른 기기 쿠키(옛 값)로 같은 요청', 'GET', '/api/auth/me', { cookie: cC1 });
const c2after = await req('[바꾼 뒤] 새로 받은 쿠키로 같은 요청', 'GET', '/api/auth/me', { cookie: cC2 });
check('C114', '비밀번호를 바꾸면 옛 값 둘 다 401, 새 값만 200',
  c0ok.status === 200 && c0after.status === 401 && c1after.status === 401 && c2after.status === 200);
r = await req('옛 비밀번호로 로그인', 'POST', '/api/auth/login', { body: { login_id: IDS.c, password: PW_C } });
check('C114', '옛 비밀번호는 더 이상 통하지 않음 → 401', r.status === 401);

// ---------- 5. 자료 넣기 ----------
p('## 5. 두 계정에 자료 넣기 (카드 4)');
p('');
r = await req(`로그인: ${IDS.a}`, 'POST', '/api/auth/login', { body: { login_id: IDS.a, password: PW } });
const cA = r.cookie;
const plan = (title) => ({ title, start_date: '2026-10-12', end_date: '2026-10-16', priority: 2, success_criteria: '시험용', estimated_minutes: 60 });
const task = (planId, title) => ({ plan_id: planId, title, due_date: '2026-10-13', priority: 2, tags: ['시험'], estimated_minutes: 30 });
const log = { started_at: '2026-10-12T10:00:00+09:00', ended_at: '2026-10-12T10:30:00+09:00', actual_minutes: 30, blocker: '' };
const A = {}; const B = {};
A.plan = (await req('A: 계획 만들기', 'POST', '/api/plans', { cookie: cA, body: plan('A의 계획') })).json.id;
A.task1 = (await req('A: 할 일 1', 'POST', '/api/tasks', { cookie: cA, body: task(A.plan, 'A 할 일 1') })).json.id;
A.task2 = (await req('A: 할 일 2', 'POST', '/api/tasks', { cookie: cA, body: task(A.plan, 'A 할 일 2') })).json.id;
A.log = (await req('A: 실행 기록', 'POST', `/api/tasks/${A.task1}/logs`, { cookie: cA, body: log })).json.id;
B.plan = (await req('B: 계획 만들기', 'POST', '/api/plans', { cookie: cB, body: plan('B의 계획') })).json.id;
B.task1 = (await req('B: 할 일 1', 'POST', '/api/tasks', { cookie: cB, body: task(B.plan, 'B 할 일 1') })).json.id;
B.task2 = (await req('B: 할 일 2', 'POST', '/api/tasks', { cookie: cB, body: task(B.plan, 'B 할 일 2') })).json.id;
B.log = (await req('B: 실행 기록', 'POST', `/api/tasks/${B.task1}/logs`, { cookie: cB, body: log })).json.id;
check('C116', '두 계정에 각각 계획 1·할 일 2·실행 기록 1을 넣음', [A.plan, A.task1, A.task2, A.log, B.plan, B.task1, B.task2, B.log].every(Boolean),
  `A: 계획 #${A.plan}, 할 일 #${A.task1}·#${A.task2}, 기록 #${A.log} / B: 계획 #${B.plan}, 할 일 #${B.task1}·#${B.task2}, 기록 #${B.log}`);

// 자료 건수 세기: 각자 내보내기
async function snapshot(who, cookie) {
  const res = await fetch(`${BASE}/api/export`, { headers: { Cookie: `${cookie.name}=${cookie.value}` } });
  const j = await res.json();
  seenBodies.push(JSON.stringify(j));
  const live = j.tasks.filter((t) => !t.deleted_at);
  return {
    who, plans: j.plans.length, revisions: j.plan_revisions.length, tasks: live.length, logs: j.work_logs.length,
    completions: j.task_completions.length,
    sig: JSON.stringify([j.plans.map((x) => [x.id, x.title, x.updated_at]), j.tasks.map((x) => [x.id, x.title, x.updated_at, x.deleted_at])]),
    ids: { plans: j.plans.map((x) => x.id), tasks: j.tasks.map((x) => x.id), logs: j.work_logs.map((x) => x.id) },
  };
}
const fmtSnap = (s) => `계획 ${s.plans} · 계획 이력 ${s.revisions} · 할 일 ${s.tasks} · 실행 기록 ${s.logs} · 완료 기록 ${s.completions}`;

// ---------- 6. 남의 자료: 양방향 읽기·수정·삭제 ----------
async function attack(me, meCookie, other, otherCookie, otherName) {
  const pre = await snapshot(otherName, otherCookie);
  p(`${otherName}의 자료 (거절 시험 전, ${otherName} 본인 내보내기로 셈): ${fmtSnap(pre)}`);
  p('');
  const st = [];
  st.push((await req(`읽기: ${otherName}의 할 일 #${other.task1}의 실행 기록`, 'GET', `/api/tasks/${other.task1}/logs`, { cookie: meCookie })).status);
  st.push((await req(`읽기: ${otherName}의 계획 #${other.plan}에 딸린 할 일 목록`, 'GET', `/api/tasks?plan_id=${other.plan}`, { cookie: meCookie })).status);
  st.push((await req(`읽기: ${otherName}의 계획 #${other.plan} 수정 이력`, 'GET', `/api/plans/${other.plan}/revisions`, { cookie: meCookie })).status);
  st.push((await req(`읽기: ${otherName}의 계획 #${other.plan} 돌아보기 숫자`, 'GET', `/api/plans/${other.plan}/review`, { cookie: meCookie })).status);
  const readOk = st.every((s) => s === 404);
  const st2 = [];
  st2.push((await req(`수정: ${otherName}의 할 일 #${other.task1} 고치기`, 'PUT', `/api/tasks/${other.task1}`, { cookie: meCookie, body: { title: '남이 고침', due_date: '2026-10-20', priority: 1, tags: [], estimated_minutes: 1 } })).status);
  st2.push((await req(`수정: ${otherName}의 계획 #${other.plan} 고치기`, 'PUT', `/api/plans/${other.plan}`, { cookie: meCookie, body: { ...plan('남이 고친 계획'), change_note: '남이 고침' } })).status);
  st2.push((await req(`수정: ${otherName}의 할 일 #${other.task2} 완료로 바꾸기`, 'POST', `/api/tasks/${other.task2}/complete`, { cookie: meCookie, headers: { 'Idempotency-Key': crypto.randomUUID() } })).status);
  st2.push((await req(`수정: ${otherName}의 계획 #${other.plan}에 할 일 끼워 넣기`, 'POST', '/api/tasks', { cookie: meCookie, body: task(other.plan, '남이 넣은 할 일') })).status);
  const updOk = st2.every((s) => s === 404);
  const st3 = [];
  st3.push((await req(`삭제: ${otherName}의 할 일 #${other.task2} 지우기`, 'DELETE', `/api/tasks/${other.task2}`, { cookie: meCookie })).status);
  st3.push((await req(`삭제: ${otherName}의 실행 기록 #${other.log} 지우기`, 'DELETE', `/api/logs/${other.log}`, { cookie: meCookie })).status);
  const delOk = st3.every((s) => s === 404);
  const post = await snapshot(otherName, otherCookie);
  p(`${otherName}의 자료 (거절 시험 뒤): ${fmtSnap(post)}`);
  p('');
  return { readOk, updOk, delOk, same: pre.sig === post.sig && fmtSnap(pre) === fmtSnap(post), pre, post, st, st2, st3 };
}

p('## 6. 남의 자료 읽기·수정·삭제 — A가 B를 (카드 4)');
p('');
const ab = await attack(A, cA, B, cB, 'B');
check('C117', 'A → B 읽기 4가지 모두 404', ab.readOk, ab.st.join(', '));
check('C118', 'A → B 수정 4가지 모두 404', ab.updOk, ab.st2.join(', '));
check('C119', 'A → B 삭제 2가지 모두 404', ab.delOk, ab.st3.join(', '));
check('C122', '거절 앞뒤로 B의 자료 건수·제목·고친 시각이 그대로', ab.same, `전: ${fmtSnap(ab.pre)} / 뒤: ${fmtSnap(ab.post)}`);

p('## 7. 반대 방향 — B가 A를 (카드 4)');
p('');
const ba = await attack(B, cB, A, cA, 'A');
check('C120', 'B → A 읽기·수정·삭제 모두 404', ba.readOk && ba.updOk && ba.delOk, [...ba.st, ...ba.st2, ...ba.st3].join(', '));
check('C122', '거절 앞뒤로 A의 자료 건수·제목·고친 시각이 그대로', ba.same, `전: ${fmtSnap(ba.pre)} / 뒤: ${fmtSnap(ba.post)}`);
check('C121', '모든 거절이 404(존재 자체를 감춤)', [ab, ba].every((x) => [...x.st, ...x.st2, ...x.st3].every((s) => s === 404)));

// ---------- 8. 주소·헤더·본문에 남의 계정 적기 ----------
p('## 8. 주소·헤더·본문에 다른 계정을 적어 보내기 (카드 4)');
p('');
const bUser = (await req('B의 사용자 번호 확인(B 본인)', 'GET', '/api/auth/me', { cookie: cB })).json.user;
const aUser = (await req('A의 사용자 번호 확인(A 본인)', 'GET', '/api/auth/me', { cookie: cA })).json.user;
const spoof = await req(`A의 쿠키 + 주소 ?user_id=${bUser.id}&login_id=${bUser.login_id} + 머리글 X-User-Id: ${bUser.id}`, 'GET',
  `/api/plans?user_id=${bUser.id}&login_id=${bUser.login_id}`, { cookie: cA, headers: { 'X-User-Id': String(bUser.id), 'X-Login-Id': bUser.login_id } });
const spoofIds = (spoof.json || []).map((x) => String(x.id));
check('C123', '주소·머리글에 B를 적어도 A의 계획만 돌아옴', spoof.status === 200 && spoofIds.length > 0 && spoofIds.every((i) => i === String(A.plan)) && !spoofIds.includes(String(B.plan)),
  `돌아온 계획 ID: [${spoofIds.join(', ')}], A의 계획 #${A.plan}, B의 계획 #${B.plan}`);
const preB = await snapshot('B', cB);
const sp2 = await req(`A의 쿠키 + 본문에 user_id: ${bUser.id} 를 넣어 계획 만들기`, 'POST', '/api/plans', { cookie: cA, body: { ...plan('본문에 B를 적은 계획'), user_id: bUser.id, login_id: bUser.login_id } });
const postB = await snapshot('B', cB);
const aPlans = (await req('A가 자기 계획 목록 보기', 'GET', '/api/plans', { cookie: cA })).json.map((x) => String(x.id));
check('C123', '본문에 B를 적어도 계획은 A의 것으로 만들어지고, B의 자료는 그대로',
  sp2.status === 201 && aPlans.includes(String(sp2.json.id)) && preB.sig === postB.sig,
  `새 계획 #${sp2.json && sp2.json.id}는 A 목록에 있음, B: ${fmtSnap(preB)} → ${fmtSnap(postB)}`);

// ---------- 9. 로그인 없이 직접 ----------
p('## 9. 로그인하지 않고 자료를 직접 요청 (카드 4)');
p('');
const anon = [];
anon.push((await req('로그인 없이: 할 일 실행 기록 읽기', 'GET', `/api/tasks/${A.task1}/logs`)).status);
anon.push((await req('로그인 없이: 내보내기', 'GET', '/api/export')).status);
anon.push((await req('로그인 없이: 할 일 지우기', 'DELETE', `/api/tasks/${A.task1}`)).status);
anon.push((await req('로그인 없이: 홈 목록', 'GET', '/api/home')).status);
check('C124', '로그인 없이 보낸 자료 요청 4가지 모두 401', anon.every((s) => s === 401), anon.join(', '));

// ---------- 10. 목록에 남의 자료가 섞이지 않음 ----------
p('## 10. 목록 응답에 남의 자료가 섞이지 않음 (카드 4)');
p('');
const listA = await req('A: 계획 목록', 'GET', '/api/plans', { cookie: cA });
const tasksA = await req('A: 할 일 목록', 'GET', `/api/tasks?plan_id=${A.plan}`, { cookie: cA });
const homeA = await fetch(`${BASE}/api/home`, { headers: { Cookie: `${cA.name}=${cA.value}` } }).then((x) => x.json());
const sumA = await fetch(`${BASE}/api/plans-summary`, { headers: { Cookie: `${cA.name}=${cA.value}` } }).then((x) => x.json());
const snapA = await snapshot('A', cA);
const snapB = await snapshot('B', cB);
const bTaskIds = new Set(snapB.ids.tasks.map(String));
const bPlanIds = new Set(snapB.ids.plans.map(String));
const bLogIds = new Set(snapB.ids.logs.map(String));
const leak = [
  ...listA.json.map((x) => String(x.id)).filter((i) => bPlanIds.has(i)),
  ...tasksA.json.map((x) => String(x.id)).filter((i) => bTaskIds.has(i)),
  ...[...homeA.today, ...homeA.upcoming].map((x) => String(x.id)).filter((i) => bTaskIds.has(i)),
  ...homeA.week_logs.map((x) => String(x.id)).filter((i) => bLogIds.has(i)),
  ...sumA.map((x) => String(x.id)).filter((i) => bPlanIds.has(i)),
  ...snapA.ids.plans.map(String).filter((i) => bPlanIds.has(i)),
  ...snapA.ids.tasks.map(String).filter((i) => bTaskIds.has(i)),
];
p(`- A의 응답에 나온 ID — 계획 목록 [${listA.json.map((x) => x.id).join(', ')}], 할 일 목록 [${tasksA.json.map((x) => x.id).join(', ')}], 홈 [${[...homeA.today, ...homeA.upcoming].map((x) => x.id).join(', ')}], 계획 요약 [${sumA.map((x) => x.id).join(', ')}], 내보내기 할 일 [${snapA.ids.tasks.join(', ')}]`);
p(`- B의 ID — 계획 [${snapB.ids.plans.join(', ')}], 할 일 [${snapB.ids.tasks.join(', ')}], 실행 기록 [${snapB.ids.logs.join(', ')}]`);
p('');
check('C125', 'A가 부른 목록 5종(계획·할 일·홈·요약·내보내기)에 B의 ID가 하나도 없음', leak.length === 0, leak.length ? `섞인 ID: ${leak.join(', ')}` : '겹치는 ID 0개');

// ---------- 11. CSRF·무차별 대입 ----------
p('## 11. 덤: 다른 사이트에서 온 쓰기 요청, 비밀번호 연속 실패');
p('');
r = await req('X-Requested-With 머리글 없이 할 일 지우기(다른 사이트 흉내)', 'DELETE', `/api/tasks/${A.task1}`, { cookie: cA, headers: { 'X-Requested-With': null } });
check('덤', '이 앱 화면이 붙이는 머리글이 없는 쓰기 요청 → 403', r.status === 403);
const brute = [];
for (let i = 1; i <= 6; i++) {
  const x = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pds-diary' }, body: JSON.stringify({ login_id: `nobody_${tail}`, password: `guess-${i}-xxxx` }) });
  seenBodies.push(await x.text());
  brute.push(x.status);
}
p(`없는 아이디 \`nobody_${tail}\`로 틀린 비밀번호를 연달아 보낸 응답 코드(2장의 "없는 아이디" 시도 1번에 이어 6번): ${brute.join(', ')}`);
p('');
check('덤', '15분 안에 5번 틀린 뒤에는 429로 막힘(아이디가 있든 없든 같게)', brute.includes(429));

// ---------- 12. 계정 삭제 ----------
p('## 12. 계정 삭제 (카드 5)');
p('');
await req(`${IDS.c}: 계획 하나 만들기`, 'POST', '/api/plans', { cookie: cC2, body: plan('C의 계획') });
r = await req(`${IDS.c}: 계정 삭제`, 'DELETE', '/api/account', { cookie: cC2, body: { password: PW_C2, confirm: '계정 삭제' } });
const delOk = r.status === 200 && r.json.deleted;
const afterDel = await req('[삭제 뒤] 같은 쿠키로 /api/auth/me', 'GET', '/api/auth/me', { cookie: cC2 });
const loginDel = await req('[삭제 뒤] 같은 아이디·비밀번호로 로그인', 'POST', '/api/auth/login', { body: { login_id: IDS.c, password: PW_C2 } });
check('C134', '계정을 지우면 내 자료가 함께 지워지고, 그 쿠키·비밀번호는 더 통하지 않음', delOk && afterDel.status === 401 && loginDel.status === 401,
  `지운 자료: ${JSON.stringify(r.json && r.json.removed)}`);

// ---------- 13. 원문 누출 검사 ----------
p('## 13. 응답 어디에도 비밀번호 원문이 없는지');
p('');
const all = seenBodies.join('\n');
const pwHits = SECRETS.reduce((n, s) => n + all.split(s).length - 1, 0);
check('C105/C106', `받은 응답 ${seenBodies.length / 3 | 0}여 개의 본문·머리글 전체에서 비밀번호 원문 등장 횟수`, pwHits === 0, `${pwHits}회`);
const urlHits = seenTokens.filter((t) => out.join('\n').includes(t)).length;
check('C115', '이 기록 문서 안에 세션 값 원문 등장 횟수', urlHits === 0, `${urlHits}회`);

// ---------- 요약 ----------
const head = [];
head.push('## 요약');
head.push('');
head.push(`통과 ${pass} · 실패 ${fail}`);
head.push('');
head.push('| 기준 | 내용 | 결과 |');
head.push('|---|---|---|');
for (const x of results) head.push(`| ${x.id} | ${x.desc.replace(/\|/g, '/')} | ${x.ok ? '✅' : '❌'} |`);
head.push('');
const firstSection = out.findIndex((l) => l.startsWith('## 0.'));
out.splice(firstSection, 0, ...head);

let text = out.join('\n');
for (const t of seenTokens) text = text.split(t).join(mask(t));
for (const s of SECRETS) text = text.split(s).join('(가림)');
process.stdout.write(text + '\n');
if (fail) process.exitCode = 1;
