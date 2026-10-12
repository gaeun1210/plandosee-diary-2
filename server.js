'use strict';
// 플랜두씨 다이어리 2 서버 — Express + PostgreSQL + 로그인(bcrypt 비밀번호, DB 세션)
// 비밀값(DATABASE_URL)은 환경변수로만 받고, 어떤 응답·로그에도 내보내지 않는다.
// 비밀번호·세션 값 원문도 응답·로그에 내보내지 않는다.
//
// 주인 확인 원칙: 로그인한 사람의 ID(req.user.id)는 오직 세션 쿠키에서만 얻는다.
// 주소·헤더·본문에 적힌 user_id 같은 값은 읽지 않는다. 모든 SQL은 첫 번째 값($1)으로 이 ID를 받고
// WHERE ... user_id = $1 조건을 붙인다. 남의 자료는 '없는 자료'와 똑같이 404로 답한다.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const auth = require('./lib/auth');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 환경변수가 없습니다. .env.example을 참고하세요.');
  if (require.main === module) process.exit(1);
  throw new Error('DATABASE_URL 환경변수가 없습니다.');
}
// Vercel(서버리스)에서는 요청마다 짧게 켜졌다 꺼지므로 연결을 적게 쓴다.
const SERVERLESS = Boolean(process.env.VERCEL);

// PGSSL: 비우면 암호화+인증서 검증(Neon — Vercel Storage에서 만든 DB 포함), no-verify면 암호화는 하되 인증서 검증 생략(Supabase 풀러), disable이면 암호화 없음(내 컴퓨터).
const SSL_MODE = process.env.PGSSL || 'verify';
// 접속 문자열의 sslmode 값이 아래 ssl 설정을 덮어쓰지 않도록 떼어 낸다.
// (Neon 주소의 channel_binding 값도 같은 이유로 떼어 낸다)
const DB_URL = process.env.DATABASE_URL
  .replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
const pool = new Pool({
  connectionString: DB_URL,
  ssl: SSL_MODE === 'disable' ? false : { rejectUnauthorized: SSL_MODE !== 'no-verify' },
  max: SERVERLESS ? 1 : 5,
  idleTimeoutMillis: SERVERLESS ? 5000 : 10000,
});

// 표 만들기(schema.sql)는 처음 한 번만. 여러 서버가 동시에 켜져도 겹치지 않게 잠금을 건다.
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      // 잠금은 트랜잭션 안에서만 유지되는 것(xact)을 쓴다 → Neon·Supabase의 트랜잭션 풀러를 거쳐도 잠금이 남지 않는다.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(707070)');
        await c.query(SCHEMA_SQL);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// 본문 크기: 보통 32KB, 과제 6 자료 가져오기만 2MB
const smallJson = express.json({ limit: '32kb' });
const bigJson = express.json({ limit: '2mb' });
app.use((req, res, next) => (req.path === '/api/import/t06' ? bigJson : smallJson)(req, res, next));

// 보안 헤더: 인라인 스크립트 금지, 스크립트는 같은 출처에서만.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "media-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// 개인 자료가 들어 있는 API 응답은 브라우저·중간 서버에 남기지 않는다.
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
// API를 처리하기 전에 표가 준비되어 있는지 확인한다.
app.use(['/api', '/healthz'], (req, res, next) => { ensureSchema().then(() => next(), next); });

// 다른 사이트가 내 브라우저의 쿠키를 빌려 쓰기 요청을 보내지 못하게(CSRF):
// 바꾸는 요청(POST·PUT·DELETE)에는 이 앱의 화면만 붙이는 머리글이 있어야 한다.
// 다른 출처의 페이지는 이 머리글을 붙이려면 사전 확인(CORS)을 거쳐야 하는데, 이 서버는 허락하지 않는다.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('X-Requested-With') !== 'pds-diary') {
    return res.status(403).json({ error: '허용되지 않은 요청입니다.' });
  }
  next();
});

// ---------- 입력 검사 ----------
class BadRequest extends Error {}
const bad = (msg) => { throw new BadRequest(msg); };

function text(v, name, { min = 1, max = 200, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    bad(`${name}을(를) 입력하세요.`);
  }
  if (typeof v !== 'string') bad(`${name} 형식이 잘못되었습니다.`);
  const s = v.trim();
  if (s.length < min && !(optional && s.length === 0)) bad(`${name}을(를) 입력하세요.`);
  if (s.length > max) bad(`${name}은(는) ${max}자 이하로 적어 주세요.`);
  return optional && s.length === 0 ? null : s;
}
function date(v, name) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(`${name}은(는) YYYY-MM-DD 형식이어야 합니다.`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) bad(`${name}이(가) 없는 날짜입니다.`);
  return v;
}
function timestamp(v, name) {
  // 서울 시간(+09:00)을 붙인 ISO 문자열을 받는다.
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    bad(`${name} 형식이 잘못되었습니다.`);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) bad(`${name}이(가) 없는 시각입니다.`);
  return d.toISOString();
}
function int(v, name, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) bad(`${name}은(는) ${min}~${max} 사이 정수여야 합니다.`);
  return n;
}
function num(v, name) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e9) bad(`${name}은(는) 숫자여야 합니다.`);
  return n;
}
function id(v, name = 'ID') { return int(v, name, 1, Number.MAX_SAFE_INTEGER); }
function tags(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))];
  if (out.length > 10) bad('태그는 10개까지 넣을 수 있습니다.');
  out.forEach((t) => { if (t.length > 30) bad('태그 하나는 30자 이하로 적어 주세요.'); });
  return out;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(v) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) bad('Idempotency-Key 헤더에 UUID가 필요합니다.');
  return v.toLowerCase();
}
function planFields(b) {
  const f = {
    title: text(b.title, '계획 이름', { max: 120 }),
    start_date: date(b.start_date, '시작일'),
    end_date: date(b.end_date, '종료일'),
    priority: int(b.priority, '우선순위', 1, 3),
    success_criteria: text(b.success_criteria, '성공 기준', { max: 1000 }),
    estimated_minutes: int(b.estimated_minutes, '예상 시간(분)', 0, 100000),
  };
  if (f.end_date < f.start_date) bad('종료일은 시작일과 같거나 뒤여야 합니다.');
  return f;
}
function taskFields(b) {
  return {
    title: text(b.title, '할 일', { max: 200 }),
    due_date: date(b.due_date, '마감일'),
    priority: int(b.priority, '우선순위', 1, 3),
    tags: tags(b.tags),
    estimated_minutes: int(b.estimated_minutes, '예상 시간(분)', 0, 100000),
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ======================================================================
// 인증
// ======================================================================
const LOGIN_FAIL_MSG = '아이디 또는 비밀번호가 맞지 않습니다.';
const NEED_LOGIN = { error: '로그인이 필요합니다.' };

async function startSession(db, req, res, userId) {
  const token = auth.newSessionToken();
  const expiresAt = new Date(Date.now() + auth.SESSION_MS);
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)',
    [auth.tokenHash(token), userId, expiresAt]);
  auth.setSessionCookie(req, res, token, expiresAt);
  return expiresAt;
}

// 세션 확인: 쿠키 값의 해시가 sessions 표에 있고, 만료 시각 전이어야 한다.
async function currentUser(req) {
  const token = auth.readSessionToken(req);
  if (!token) return null;
  const { rows: [u] } = await pool.query(
    `SELECT u.id, u.login_id, u.created_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [auth.tokenHash(token)]);
  return u || null;
}

// 가입: 아이디 형식 확인 → 비밀번호 규칙 확인 → bcrypt 해시 → 같은 아이디가 있으면 409
app.post('/api/auth/signup', wrap(async (req, res) => {
  const b = req.body || {};
  const loginId = auth.normalizeLoginId(b.login_id);
  if (!auth.LOGIN_ID_RE.test(loginId)) bad('아이디는 영어 소문자·숫자·밑줄(_)로 4~20자입니다.');
  const problem = auth.passwordProblem(b.password, loginId);
  if (problem) bad(problem);
  const hash = await auth.hashPassword(b.password);
  const result = await tx(async (c) => {
    const { rows: [u] } = await c.query(
      `INSERT INTO users (login_id, password_hash) VALUES ($1,$2)
       ON CONFLICT (login_id) DO NOTHING RETURNING id, login_id, created_at`, [loginId, hash]);
    if (!u) return null;
    const expiresAt = await startSession(c, req, res, u.id);
    return { user: u, expiresAt };
  });
  if (!result) return res.status(409).json({ error: '이미 쓰이는 아이디입니다. 다른 아이디를 골라 주세요.' });
  res.status(201).json({ user: { id: result.user.id, login_id: result.user.login_id }, session_expires_at: result.expiresAt });
}));

// 로그인: 아이디가 없을 때와 비밀번호만 틀렸을 때 같은 문장·같은 상태 코드(401)로 답한다.
app.post('/api/auth/login', wrap(async (req, res) => {
  const b = req.body || {};
  const loginId = auth.normalizeLoginId(b.login_id).slice(0, 100);
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM login_failures WHERE login_key=$1 AND at > now() - make_interval(mins => $2)`,
    [loginId, auth.FAIL_WINDOW_MIN]);
  if (n >= auth.FAIL_LIMIT) {
    return res.status(429).json({ error: `로그인 시도가 너무 많습니다. ${auth.FAIL_WINDOW_MIN}분 뒤에 다시 시도하세요.` });
  }
  const { rows: [u] } = await pool.query('SELECT id, login_id, password_hash FROM users WHERE login_id=$1', [loginId]);
  // 아이디가 없어도 가짜 해시와 비교해 걸리는 시간을 비슷하게 맞춘다.
  const ok = await auth.checkPassword(b.password, u && u.password_hash);
  if (!u || !ok) {
    await pool.query('INSERT INTO login_failures (login_key) VALUES ($1)', [loginId]);
    return res.status(401).json({ error: LOGIN_FAIL_MSG });
  }
  const expiresAt = await tx(async (c) => {
    await c.query('DELETE FROM login_failures WHERE login_key=$1 OR at < now() - interval \'1 day\'', [loginId]);
    await c.query('DELETE FROM sessions WHERE user_id=$1 AND expires_at <= now()', [u.id]);
    return startSession(c, req, res, u.id);
  });
  res.json({ user: { id: u.id, login_id: u.login_id }, session_expires_at: expiresAt });
}));

// 로그아웃: 브라우저 쿠키만 지우는 게 아니라 서버의 세션 줄을 지운다 → 같은 값으로 다시 와도 401
app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = auth.readSessionToken(req);
  let ended = 0;
  if (token) ({ rowCount: ended } = await pool.query('DELETE FROM sessions WHERE token_hash=$1', [auth.tokenHash(token)]));
  auth.clearSessionCookie(req, res);
  res.json({ logged_out: true, sessions_ended: ended });
}));

app.get('/api/auth/me', wrap(async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json(NEED_LOGIN);
  res.json({ user: { id: u.id, login_id: u.login_id, created_at: u.created_at }, session_expires_at: u.expires_at });
}));

// ----- 여기부터 모든 /api는 로그인이 필요하다 -----
app.use('/api', wrap(async (req, res, next) => {
  const u = await currentUser(req);
  if (!u) return res.status(401).json(NEED_LOGIN);
  req.user = u;
  next();
}));

// 비밀번호 바꾸기: 지금 비밀번호 확인 → 새 해시 저장 → 이 계정의 모든 세션을 끊고 이 브라우저에만 새 세션
app.post('/api/auth/password', wrap(async (req, res) => {
  const b = req.body || {};
  const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await auth.checkPassword(b.current_password, u.password_hash))) {
    return res.status(401).json({ error: '지금 비밀번호가 맞지 않습니다.' });
  }
  const problem = auth.passwordProblem(b.new_password, req.user.login_id);
  if (problem) bad(problem);
  const hash = await auth.hashPassword(b.new_password);
  const out = await tx(async (c) => {
    await c.query('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1', [req.user.id, hash]);
    const { rowCount } = await c.query('DELETE FROM sessions WHERE user_id=$1', [req.user.id]);
    const expiresAt = await startSession(c, req, res, req.user.id);
    return { ended: rowCount, expiresAt };
  });
  res.json({ changed: true, sessions_ended: out.ended, session_expires_at: out.expiresAt });
}));

// 계정 삭제: 비밀번호를 한 번 더 받고, 확인 문장을 적어야 한다. 내 자료는 모두 함께 지워진다(ON DELETE CASCADE).
app.delete('/api/account', wrap(async (req, res) => {
  const b = req.body || {};
  if (b.confirm !== '계정 삭제') bad('확인 칸에 "계정 삭제"를 그대로 적어 주세요.');
  const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await auth.checkPassword(b.password, u.password_hash))) {
    return res.status(401).json({ error: '비밀번호가 맞지 않습니다.' });
  }
  const removed = await tx(async (c) => {
    const { rows: [cnt] } = await c.query(`SELECT
      (SELECT COUNT(*) FROM plans WHERE user_id=$1)::int AS plans,
      (SELECT COUNT(*) FROM tasks WHERE user_id=$1)::int AS tasks,
      (SELECT COUNT(*) FROM work_logs WHERE user_id=$1)::int AS work_logs,
      (SELECT COUNT(*) FROM reviews WHERE user_id=$1)::int AS reviews,
      (SELECT COUNT(*) FROM experiment_days WHERE user_id=$1)::int AS experiment_days`, [req.user.id]);
    await c.query("SELECT set_config('pds.purge', 'on', true)"); // 이 트랜잭션에서만 이력 지우기 허락
    await c.query('DELETE FROM users WHERE id=$1', [req.user.id]);
    return cnt;
  });
  auth.clearSessionCookie(req, res);
  res.json({ deleted: true, removed });
}));

// ======================================================================
// 다이어리 (모든 SQL의 $1 = 로그인한 사람 ID)
// ======================================================================
const PLAN_COLS = `id, current_revision, title, to_char(start_date,'YYYY-MM-DD') AS start_date,
  to_char(end_date,'YYYY-MM-DD') AS end_date, priority, success_criteria, estimated_minutes,
  carried_lesson, carried_from_review_id, created_at, updated_at`;
const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Seoul')::date`;
const NOT_FOUND = {
  plan: { error: '그 계획을 찾을 수 없습니다.' },
  task: { error: '그 할 일을 찾을 수 없습니다.' },
  log: { error: '그 실행 기록을 찾을 수 없습니다.' },
  review: { error: '그 돌아보기를 찾을 수 없습니다.' },
};

// 주인 확인: 내 계획·내 할 일이 아니면 null (→ 404)
async function ownPlan(uid, planId) {
  const { rows: [p] } = await pool.query('SELECT id FROM plans WHERE id=$2 AND user_id=$1', [uid, planId]);
  return p || null;
}
async function ownTask(uid, taskId) {
  const { rows: [t] } = await pool.query('SELECT id FROM tasks WHERE id=$2 AND user_id=$1 AND deleted_at IS NULL', [uid, taskId]);
  return t || null;
}

// ---------- 계획 ----------
app.get('/api/plans', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${PLAN_COLS} FROM plans WHERE user_id=$1 ORDER BY id`, [req.user.id]);
  res.json(rows);
}));

// 모든 계획 한눈에: 계획마다 할 일 수·완료 수·예상·실제 시간 (지운 할 일은 빼고 센다)
app.get('/api/plans-summary', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.id,
      COUNT(t.id)::int AS planned,
      COUNT(c.id)::int AS done,
      COALESCE(SUM(t.estimated_minutes), 0)::int AS estimated_minutes,
      COALESCE(SUM(w.actual_minutes), 0)::int AS actual_minutes,
      COALESCE(SUM(w.log_count), 0)::int AS log_count
    FROM plans p
    LEFT JOIN tasks t ON t.plan_id = p.id AND t.deleted_at IS NULL
    LEFT JOIN task_completions c ON c.task_id = t.id AND c.reopened_at IS NULL
    LEFT JOIN (SELECT task_id, SUM(actual_minutes) AS actual_minutes, COUNT(*) AS log_count
               FROM work_logs WHERE user_id = $1 GROUP BY task_id) w ON w.task_id = t.id
    WHERE p.user_id = $1
    GROUP BY p.id ORDER BY p.id`, [req.user.id]);
  res.json(rows);
}));

app.post('/api/plans', wrap(async (req, res) => {
  const uid = req.user.id;
  const f = planFields(req.body || {});
  const plan = await tx(async (c) => {
    const { rows: [p] } = await c.query(
      `INSERT INTO plans (user_id,title,start_date,end_date,priority,success_criteria,estimated_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${PLAN_COLS}`,
      [uid, f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes]);
    await c.query(
      `INSERT INTO plan_revisions (user_id,plan_id,revision_no,title,start_date,end_date,priority,success_criteria,estimated_minutes,change_note)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,'처음 세운 계획')`,
      [uid, p.id, f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes]);
    return p;
  });
  res.status(201).json(plan);
}));

app.put('/api/plans/:id', wrap(async (req, res) => {
  const uid = req.user.id;
  const planId = id(req.params.id);
  const f = planFields(req.body || {});
  const note = text(req.body.change_note, '고친 이유', { max: 300, optional: true });
  const plan = await tx(async (c) => {
    // 주인 확인을 먼저 하고, 내 계획이 아니면 아무것도 쓰지 않고 끝낸다.
    const { rows: [cur] } = await c.query(
      'SELECT current_revision, carried_lesson FROM plans WHERE id=$2 AND user_id=$1 FOR UPDATE', [uid, planId]);
    if (!cur) return null;
    const rev = cur.current_revision + 1;
    await c.query(
      `INSERT INTO plan_revisions (user_id,plan_id,revision_no,title,start_date,end_date,priority,success_criteria,estimated_minutes,carried_lesson,change_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uid, planId, rev, f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes, cur.carried_lesson, note]);
    const { rows: [p] } = await c.query(
      `UPDATE plans SET current_revision=$3, title=$4, start_date=$5, end_date=$6, priority=$7,
         success_criteria=$8, estimated_minutes=$9, updated_at=now()
       WHERE id=$2 AND user_id=$1 RETURNING ${PLAN_COLS}`,
      [uid, planId, rev, f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes]);
    return p;
  });
  if (!plan) return res.status(404).json(NOT_FOUND.plan);
  res.json(plan);
}));

app.get('/api/plans/:id/revisions', wrap(async (req, res) => {
  const planId = id(req.params.id);
  if (!(await ownPlan(req.user.id, planId))) return res.status(404).json(NOT_FOUND.plan);
  const { rows } = await pool.query(
    `SELECT id, plan_id, revision_no, title, to_char(start_date,'YYYY-MM-DD') AS start_date,
       to_char(end_date,'YYYY-MM-DD') AS end_date, priority, success_criteria, estimated_minutes,
       carried_lesson, change_note, created_at
     FROM plan_revisions WHERE user_id=$1 AND plan_id=$2 ORDER BY revision_no DESC`, [req.user.id, planId]);
  res.json(rows);
}));

// ---------- 할 일 ----------
// $1 = 로그인한 사람. 할 일 목록·한 건 조회·집계가 모두 이 한 덩어리를 거치므로 주인 조건이 빠질 수 없다.
const TASK_SELECT = `
  SELECT t.id, t.plan_id, t.title, to_char(t.due_date,'YYYY-MM-DD') AS due_date, t.priority, t.tags,
    t.estimated_minutes, t.created_at, t.updated_at,
    c.completed_at,
    (c.id IS NOT NULL) AS done,
    (c.id IS NULL AND t.due_date < ${TODAY_SQL}) AS delayed,
    COALESCE(w.actual_minutes, 0)::int AS actual_minutes,
    COALESCE(w.log_count, 0)::int AS log_count,
    COALESCE(w.blocked, false) AS blocked
  FROM tasks t
  LEFT JOIN task_completions c ON c.task_id = t.id AND c.reopened_at IS NULL
  LEFT JOIN (
    SELECT task_id, SUM(actual_minutes) AS actual_minutes, COUNT(*) AS log_count,
           bool_or(btrim(blocker) <> '') AS blocked
    FROM work_logs WHERE user_id = $1 GROUP BY task_id
  ) w ON w.task_id = t.id
  WHERE t.deleted_at IS NULL AND t.user_id = $1`;

// 정렬 기준은 여기 적힌 것만 쓴다. 값이 같으면 마지막에 ID 오름차순으로 순서를 고정한다.
const SORTS = {
  due: 't.due_date ASC, t.priority ASC, t.id ASC',
  priority: 't.priority ASC, t.due_date ASC, t.id ASC',
  estimate: 't.estimated_minutes DESC, t.due_date ASC, t.id ASC',
  created: 't.created_at DESC, t.id DESC',
};

app.get('/api/tasks', wrap(async (req, res) => {
  const q = req.query;
  const where = [];
  const params = [req.user.id];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

  const planId = id(q.plan_id, '계획 ID');
  // 남의 계획 번호로 목록을 부르면 빈 목록이 아니라 404 (계획이 있는지조차 알려 주지 않는다)
  if (!(await ownPlan(req.user.id, planId))) return res.status(404).json(NOT_FOUND.plan);
  add('t.plan_id = ?', planId);
  if (q.q) {
    const s = text(q.q, '검색어', { max: 100 }).replace(/[\\%_]/g, (m) => '\\' + m);
    add(`(t.title ILIKE ? OR array_to_string(t.tags, ' ') ILIKE $${params.length + 1})`, `%${s}%`);
  }
  if (q.status === 'todo') where.push('c.id IS NULL');
  else if (q.status === 'done') where.push('c.id IS NOT NULL');
  else if (q.status === 'delayed') where.push(`c.id IS NULL AND t.due_date < ${TODAY_SQL}`);
  else if (q.status === 'blocked') where.push('COALESCE(w.blocked,false)');
  else if (q.status && q.status !== 'all') bad('상태 거르기 값이 잘못되었습니다.');
  if (q.priority) add('t.priority = ?', int(q.priority, '우선순위', 1, 3));
  if (q.tag) add('? = ANY(t.tags)', text(q.tag, '태그', { max: 30 }));

  const sortKey = q.sort || 'due';
  if (!SORTS[sortKey]) bad('정렬 기준이 잘못되었습니다.');
  const sql = `${TASK_SELECT} ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY ${SORTS[sortKey]}`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

async function taskById(uid, taskId) {
  const { rows: [t] } = await pool.query(`${TASK_SELECT} AND t.id = $2`, [uid, taskId]);
  return t;
}

app.post('/api/tasks', wrap(async (req, res) => {
  const uid = req.user.id;
  const b = req.body || {};
  const planId = id(b.plan_id, '계획 ID');
  const f = taskFields(b);
  if (!(await ownPlan(uid, planId))) return res.status(404).json(NOT_FOUND.plan);
  const { rows: [t] } = await pool.query(
    `INSERT INTO tasks (user_id,plan_id,title,due_date,priority,tags,estimated_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [uid, planId, f.title, f.due_date, f.priority, f.tags, f.estimated_minutes]);
  res.status(201).json(await taskById(uid, t.id));
}));

app.put('/api/tasks/:id', wrap(async (req, res) => {
  const uid = req.user.id;
  const taskId = id(req.params.id);
  const f = taskFields(req.body || {});
  // 주인 조건(user_id=$1)이 UPDATE 문 안에 있어, 남의 할 일이면 한 줄도 바뀌지 않고 rowCount=0 → 404
  const { rowCount } = await pool.query(
    `UPDATE tasks SET title=$3, due_date=$4, priority=$5, tags=$6, estimated_minutes=$7, updated_at=now()
     WHERE id=$2 AND user_id=$1 AND deleted_at IS NULL`,
    [uid, taskId, f.title, f.due_date, f.priority, f.tags, f.estimated_minutes]);
  if (!rowCount) return res.status(404).json(NOT_FOUND.task);
  res.json(await taskById(uid, taskId));
}));

app.delete('/api/tasks/:id', wrap(async (req, res) => {
  const uid = req.user.id;
  const taskId = id(req.params.id);
  const { rowCount } = await pool.query(
    'UPDATE tasks SET deleted_at=now(), updated_at=now() WHERE id=$2 AND user_id=$1 AND deleted_at IS NULL', [uid, taskId]);
  if (!rowCount) return res.status(404).json(NOT_FOUND.task);
  await pool.query('DELETE FROM running_timer WHERE user_id=$1 AND task_id=$2', [uid, taskId]);
  res.json({ deleted: true });
}));

// 완료: 같은 키로 다시 오거나(재전송), 이미 완료인데 또 오면(연속 클릭) 새 기록을 만들지 않는다.
app.post('/api/tasks/:id/complete', wrap(async (req, res) => {
  const uid = req.user.id;
  const taskId = id(req.params.id);
  const key = uuid(req.get('Idempotency-Key'));
  if (!(await ownTask(uid, taskId))) return res.status(404).json(NOT_FOUND.task);
  const { rowCount } = await pool.query(
    `INSERT INTO task_completions (user_id, task_id, idempotency_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [uid, taskId, key]);
  res.status(rowCount ? 201 : 200).json({ created: rowCount === 1, task: await taskById(uid, taskId) });
}));

app.post('/api/tasks/:id/reopen', wrap(async (req, res) => {
  const uid = req.user.id;
  const taskId = id(req.params.id);
  if (!(await ownTask(uid, taskId))) return res.status(404).json(NOT_FOUND.task);
  await pool.query(
    'UPDATE task_completions SET reopened_at=now() WHERE user_id=$1 AND task_id=$2 AND reopened_at IS NULL', [uid, taskId]);
  res.json({ task: await taskById(uid, taskId) });
}));

// ---------- 실행 기록 ----------
const LOG_COLS = 'id, task_id, started_at, ended_at, actual_minutes, blocker, created_at';

app.get('/api/tasks/:id/logs', wrap(async (req, res) => {
  const uid = req.user.id;
  const taskId = id(req.params.id);
  if (!(await ownTask(uid, taskId))) return res.status(404).json(NOT_FOUND.task);
  const { rows } = await pool.query(
    `SELECT ${LOG_COLS} FROM work_logs WHERE user_id=$1 AND task_id=$2 ORDER BY started_at DESC, id DESC`, [uid, taskId]);
  res.json(rows);
}));

app.post('/api/tasks/:id/logs', wrap(async (req, res) => {
  const uid = req.user.id;
  const taskId = id(req.params.id);
  const b = req.body || {};
  const started = timestamp(b.started_at, '시작 시각');
  const ended = timestamp(b.ended_at, '끝난 시각');
  if (ended < started) bad('끝난 시각은 시작 시각과 같거나 뒤여야 합니다.');
  const minutes = int(b.actual_minutes, '실제 걸린 시간(분)', 0, 100000);
  const blocker = text(b.blocker, '막혔던 이유', { max: 1000, optional: true }) || '';
  if (!(await ownTask(uid, taskId))) return res.status(404).json(NOT_FOUND.task);
  const { rows: [log] } = await pool.query(
    `INSERT INTO work_logs (user_id, task_id, started_at, ended_at, actual_minutes, blocker)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${LOG_COLS}`,
    [uid, taskId, started, ended, minutes, blocker]);
  res.status(201).json(log);
}));

// 한 계획의 실행 기록 전체 (실행 기록 탭)
app.get('/api/plans/:id/logs', wrap(async (req, res) => {
  const uid = req.user.id;
  const planId = id(req.params.id);
  if (!(await ownPlan(uid, planId))) return res.status(404).json(NOT_FOUND.plan);
  const { rows } = await pool.query(
    `SELECT w.id, w.task_id, t.title AS task_title, t.tags AS task_tags, w.started_at, w.ended_at, w.actual_minutes, w.blocker, w.created_at
     FROM work_logs w JOIN tasks t ON t.id = w.task_id
     WHERE w.user_id = $1 AND t.user_id = $1 AND t.plan_id = $2 AND t.deleted_at IS NULL
     ORDER BY w.started_at DESC, w.id DESC`, [uid, planId]);
  res.json(rows);
}));

// 홈 '나의 하루': 내 모든 계획을 합쳐 오늘 할 일·다가오는 할 일·최근 7일 실행 기록 (서울 날짜 기준)
app.get('/api/home', wrap(async (req, res) => {
  const uid = req.user.id;
  const today = `to_char(${TODAY_SQL}, 'YYYY-MM-DD')`;
  const base = `SELECT x.*, p.title AS plan_title FROM (${TASK_SELECT}) x JOIN plans p ON p.id = x.plan_id AND p.user_id = $1`;
  const { rows: todayRows } = await pool.query(`${base}
    WHERE x.due_date = ${today} OR x.delayed
       OR (x.done AND (x.completed_at AT TIME ZONE 'Asia/Seoul')::date = ${TODAY_SQL})
    ORDER BY x.done ASC, x.delayed DESC, x.priority ASC, x.due_date ASC, x.id ASC`, [uid]);
  const { rows: upcoming } = await pool.query(`${base}
    WHERE NOT x.done AND x.due_date > ${today}
    ORDER BY x.due_date ASC, x.priority ASC, x.id ASC LIMIT 8`, [uid]);
  const { rows: weekLogs } = await pool.query(`
    SELECT w.id, w.task_id, w.started_at, w.actual_minutes, t.plan_id, p.title AS plan_title
    FROM work_logs w JOIN tasks t ON t.id = w.task_id JOIN plans p ON p.id = t.plan_id
    WHERE w.user_id = $1 AND t.deleted_at IS NULL AND (w.started_at AT TIME ZONE 'Asia/Seoul')::date > ${TODAY_SQL} - 7
    ORDER BY w.started_at, w.id`, [uid]);
  res.json({ today: todayRows, upcoming, week_logs: weekLogs });
}));

app.delete('/api/logs/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM work_logs WHERE id=$2 AND user_id=$1', [req.user.id, id(req.params.id)]);
  if (!rowCount) return res.status(404).json(NOT_FOUND.log);
  res.json({ deleted: true });
}));

// ---------- 타이머 (사람마다 하나) ----------
const TIMER_SELECT = `SELECT r.task_id, r.started_at, t.title AS task_title, t.plan_id
  FROM running_timer r JOIN tasks t ON t.id = r.task_id WHERE r.user_id = $1`;

app.get('/api/timer', wrap(async (req, res) => {
  const { rows: [t] } = await pool.query(TIMER_SELECT, [req.user.id]);
  res.json({ timer: t || null });
}));

app.post('/api/tasks/:id/timer', wrap(async (req, res) => {
  const uid = req.user.id;
  const taskId = id(req.params.id);
  if (!(await ownTask(uid, taskId))) return res.status(404).json(NOT_FOUND.task);
  const { rowCount } = await pool.query(
    'INSERT INTO running_timer (user_id, task_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [uid, taskId]);
  const { rows: [t] } = await pool.query(TIMER_SELECT, [uid]);
  if (!rowCount) {
    return res.status(409).json({ error: `이미 할 일 #${t.task_id}의 타이머가 돌고 있습니다. 먼저 정지하세요.`, timer: t });
  }
  res.status(201).json({ timer: t });
}));

app.post('/api/timer/stop', wrap(async (req, res) => {
  const uid = req.user.id;
  const blocker = text((req.body || {}).blocker, '막혔던 이유', { max: 1000, optional: true }) || '';
  const log = await tx(async (c) => {
    const { rows: [r] } = await c.query('DELETE FROM running_timer WHERE user_id=$1 RETURNING task_id, started_at', [uid]);
    if (!r) return null;
    const { rows: [l] } = await c.query(
      `INSERT INTO work_logs (user_id, task_id, started_at, ended_at, actual_minutes, blocker)
       VALUES ($1, $2, $3, now(), GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - $3::timestamptz)) / 60))::int, $4)
       RETURNING ${LOG_COLS}`,
      [uid, r.task_id, r.started_at, blocker]);
    return l;
  });
  if (!log) return res.status(404).json({ error: '돌고 있는 타이머가 없습니다.' });
  res.status(201).json(log);
}));

app.delete('/api/timer', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM running_timer WHERE user_id=$1', [req.user.id]);
  res.json({ discarded: rowCount === 1 });
}));

// ---------- 돌아보기 ----------
// 대상: 그 계획에 딸린, 지우지 않은 내 할 일 (기간을 주면 마감일이 그 기간 안에 드는 것만)
function periodFilter(q, params) {
  const parts = [];
  if (q.from) { params.push(date(q.from, '기간 시작')); parts.push(`t.due_date >= $${params.length}`); }
  if (q.to) { params.push(date(q.to, '기간 끝')); parts.push(`t.due_date <= $${params.length}`); }
  return parts.length ? 'AND ' + parts.join(' AND ') : '';
}

async function computeReview(uid, planId, q) {
  const params = [uid, planId];
  const period = periodFilter(q, params);
  const { rows: [r] } = await pool.query(`
    WITH t AS (${TASK_SELECT} AND t.plan_id = $2 ${period})
    SELECT COUNT(*)::int AS planned,
      COUNT(*) FILTER (WHERE done)::int AS done,
      COUNT(*) FILTER (WHERE delayed)::int AS delayed,
      COUNT(*) FILTER (WHERE blocked)::int AS blocked,
      COALESCE(SUM(estimated_minutes),0)::int AS estimated_minutes,
      COALESCE(SUM(actual_minutes),0)::int AS actual_minutes,
      to_char(${TODAY_SQL},'YYYY-MM-DD') AS today_seoul
    FROM t`, params);
  r.diff_minutes = r.actual_minutes - r.estimated_minutes;
  r.from = q.from || null;
  r.to = q.to || null;
  return r;
}

app.get('/api/plans/:id/review', wrap(async (req, res) => {
  const planId = id(req.params.id);
  if (!(await ownPlan(req.user.id, planId))) return res.status(404).json(NOT_FOUND.plan);
  res.json(await computeReview(req.user.id, planId, req.query));
}));

const METRIC_FILTERS = {
  planned: 'true', done: 'done', delayed: 'delayed', blocked: 'blocked',
  estimated: 'true', actual: 'log_count > 0', diff: 'true',
};

// 집계 숫자를 누르면 오는 곳: 그 숫자를 만든 할 일과 실행 기록
app.get('/api/plans/:id/review/evidence', wrap(async (req, res) => {
  const uid = req.user.id;
  const planId = id(req.params.id);
  const metric = req.query.metric;
  if (!METRIC_FILTERS[metric]) bad('집계 항목이 잘못되었습니다.');
  if (!(await ownPlan(uid, planId))) return res.status(404).json(NOT_FOUND.plan);
  const params = [uid, planId];
  const period = periodFilter(req.query, params);
  const { rows: tasks } = await pool.query(
    `SELECT * FROM (${TASK_SELECT} AND t.plan_id = $2 ${period}) x WHERE ${METRIC_FILTERS[metric]}
     ORDER BY due_date ASC, id ASC`, params);
  const ids = tasks.map((t) => t.id);
  const { rows: logs } = ids.length ? await pool.query(
    `SELECT id, task_id, started_at, ended_at, actual_minutes, blocker FROM work_logs
     WHERE user_id = $1 AND task_id = ANY($2::bigint[]) ORDER BY started_at ASC, id ASC`, [uid, ids]) : { rows: [] };
  res.json({ metric, tasks, logs });
}));

app.get('/api/plans/:id/reviews', wrap(async (req, res) => {
  const planId = id(req.params.id);
  if (!(await ownPlan(req.user.id, planId))) return res.status(404).json(NOT_FOUND.plan);
  const { rows } = await pool.query(
    `SELECT id, plan_id, snapshot, lesson, carried_to_plan_id, created_at FROM reviews
     WHERE user_id=$1 AND plan_id=$2 ORDER BY id DESC`, [req.user.id, planId]);
  res.json(rows);
}));

app.post('/api/plans/:id/reviews', wrap(async (req, res) => {
  const uid = req.user.id;
  const planId = id(req.params.id);
  const b = req.body || {};
  const lesson = text(b.lesson, '고칠 점', { max: 300 });
  if (!(await ownPlan(uid, planId))) return res.status(404).json(NOT_FOUND.plan);
  const snapshot = await computeReview(uid, planId, { from: b.from || undefined, to: b.to || undefined });
  const { rows: [r] } = await pool.query(
    `INSERT INTO reviews (user_id, plan_id, snapshot, lesson) VALUES ($1,$2,$3,$4)
     RETURNING id, plan_id, snapshot, lesson, carried_to_plan_id, created_at`,
    [uid, planId, snapshot, lesson]);
  res.status(201).json(r);
}));

// 고칠 점을 다음 계획으로 넘긴다. 한 돌아보기는 한 번만 넘길 수 있다(carried_to_plan_id UNIQUE + 잠금).
app.post('/api/reviews/:id/carry', wrap(async (req, res) => {
  const uid = req.user.id;
  const reviewId = id(req.params.id);
  const f = planFields(req.body || {});
  const result = await tx(async (c) => {
    const { rows: [r] } = await c.query(
      'SELECT id, lesson, carried_to_plan_id FROM reviews WHERE id=$2 AND user_id=$1 FOR UPDATE', [uid, reviewId]);
    if (!r) return { status: 404, body: NOT_FOUND.review };
    if (r.carried_to_plan_id) return { status: 409, body: { error: '이미 다음 계획으로 넘긴 돌아보기입니다.', plan_id: r.carried_to_plan_id } };
    const { rows: [p] } = await c.query(
      `INSERT INTO plans (user_id,title,start_date,end_date,priority,success_criteria,estimated_minutes,carried_lesson,carried_from_review_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${PLAN_COLS}`,
      [uid, f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes, r.lesson, r.id]);
    await c.query(
      `INSERT INTO plan_revisions (user_id,plan_id,revision_no,title,start_date,end_date,priority,success_criteria,estimated_minutes,carried_lesson,change_note)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uid, p.id, f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes, r.lesson, `돌아보기 #${r.id}에서 넘어온 계획`]);
    await c.query('UPDATE reviews SET carried_to_plan_id=$3 WHERE id=$2 AND user_id=$1', [uid, r.id, p.id]);
    return { status: 201, body: p };
  });
  res.status(result.status).json(result.body);
}));

// ======================================================================
// 과제 6 자료 가져오기 — 과제 6 사이트의 "내 자료 전체 내보내기(JSON)" 파일을 내 계정으로 옮긴다
// ======================================================================
const T06_SOURCE = 'T06 최종 제출 https://plandosee-diary-ten.vercel.app (commit a7da53e7f118ac85d87c7c5c0b0ce4331ab4ae11)';

app.post('/api/import/t06', wrap(async (req, res) => {
  const uid = req.user.id;
  const d = req.body || {};
  if (d.format !== 'pds-diary-export') bad('과제 6 다이어리의 내보내기 파일(JSON)이 아닙니다.');
  const LIMITS = { plans: 500, plan_revisions: 5000, tasks: 5000, task_completions: 10000, work_logs: 10000, reviews: 2000 };
  for (const [k, max] of Object.entries(LIMITS)) {
    if (!Array.isArray(d[k])) bad(`파일에 ${k} 목록이 없습니다.`);
    if (d[k].length > max) bad(`${k}가 너무 많습니다(${max}개까지).`);
  }
  const ts = (v, name) => (v == null ? null : timestamp(String(v), name));
  const out = await tx(async (c) => {
    const { rows: [{ n }] } = await c.query('SELECT COUNT(*)::int AS n FROM plans WHERE user_id=$1', [uid]);
    if (n > 0) return { status: 409, body: { error: '이미 계획이 있는 계정에는 가져올 수 없습니다(중복 방지). 새 계정에서 가져오세요.' } };
    const map = { plans: {}, tasks: {}, reviews: {} };
    for (const p of [...d.plans].sort((a, b) => a.id - b.id)) {
      const f = planFields(p);
      const { rows: [np] } = await c.query(
        `INSERT INTO plans (user_id,current_revision,title,start_date,end_date,priority,success_criteria,estimated_minutes,carried_lesson,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,now()),COALESCE($11,now())) RETURNING id`,
        [uid, int(p.current_revision, '판 번호', 1, 100000), f.title, f.start_date, f.end_date, f.priority, f.success_criteria,
          f.estimated_minutes, text(p.carried_lesson, '고칠 점', { max: 300, optional: true }), ts(p.created_at, '만든 시각'), ts(p.updated_at, '고친 시각')]);
      map.plans[p.id] = np.id;
    }
    const planOf = (oldId) => map.plans[oldId] || bad(`계획 #${oldId}을(를) 파일에서 찾을 수 없습니다.`);
    for (const r of d.plan_revisions) {
      const f = planFields(r);
      await c.query(
        `INSERT INTO plan_revisions (user_id,plan_id,revision_no,title,start_date,end_date,priority,success_criteria,estimated_minutes,carried_lesson,change_note,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,now()))`,
        [uid, planOf(r.plan_id), int(r.revision_no, '판 번호', 1, 100000), f.title, f.start_date, f.end_date, f.priority,
          f.success_criteria, f.estimated_minutes, text(r.carried_lesson, '고칠 점', { max: 300, optional: true }),
          text(r.change_note, '고친 이유', { max: 300, optional: true }), ts(r.created_at, '만든 시각')]);
    }
    for (const t of [...d.tasks].sort((a, b) => a.id - b.id)) {
      const f = taskFields(t);
      const { rows: [nt] } = await c.query(
        `INSERT INTO tasks (user_id,plan_id,title,due_date,priority,tags,estimated_minutes,deleted_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,now()),COALESCE($10,now())) RETURNING id`,
        [uid, planOf(t.plan_id), f.title, f.due_date, f.priority, f.tags, f.estimated_minutes,
          ts(t.deleted_at, '지운 시각'), ts(t.created_at, '만든 시각'), ts(t.updated_at, '고친 시각')]);
      map.tasks[t.id] = nt.id;
    }
    const taskOf = (oldId) => map.tasks[oldId] || bad(`할 일 #${oldId}을(를) 파일에서 찾을 수 없습니다.`);
    for (const k of d.task_completions) {
      await c.query(
        `INSERT INTO task_completions (user_id,task_id,idempotency_key,completed_at,reopened_at)
         VALUES ($1,$2,$3,COALESCE($4,now()),$5)`,
        [uid, taskOf(k.task_id), uuid(k.idempotency_key), ts(k.completed_at, '완료 시각'), ts(k.reopened_at, '되돌린 시각')]);
    }
    for (const l of d.work_logs) {
      await c.query(
        `INSERT INTO work_logs (user_id,task_id,started_at,ended_at,actual_minutes,blocker,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()))`,
        [uid, taskOf(l.task_id), ts(l.started_at, '시작 시각'), ts(l.ended_at, '끝난 시각'),
          int(l.actual_minutes, '실제 시간', 0, 100000), text(l.blocker, '막혔던 이유', { max: 1000, optional: true }) || '',
          ts(l.created_at, '만든 시각')]);
    }
    for (const r of [...d.reviews].sort((a, b) => a.id - b.id)) {
      const { rows: [nr] } = await c.query(
        `INSERT INTO reviews (user_id,plan_id,snapshot,lesson,carried_to_plan_id,created_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,now())) RETURNING id`,
        [uid, planOf(r.plan_id), r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : {},
          text(r.lesson, '고칠 점', { max: 300 }), r.carried_to_plan_id ? planOf(r.carried_to_plan_id) : null, ts(r.created_at, '만든 시각')]);
      map.reviews[r.id] = nr.id;
    }
    for (const p of d.plans) {
      if (p.carried_from_review_id && map.reviews[p.carried_from_review_id]) {
        await c.query('UPDATE plans SET carried_from_review_id=$3 WHERE id=$2 AND user_id=$1',
          [uid, map.plans[p.id], map.reviews[p.carried_from_review_id]]);
      }
    }
    const counts = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, d[k].length]));
    counts.running_timer_skipped = Array.isArray(d.running_timer) ? d.running_timer.length : 0;
    const { rows: [imp] } = await c.query(
      `INSERT INTO imports (user_id, source, source_exported_at, counts, id_map) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, source, source_exported_at, counts, imported_at`,
      [uid, T06_SOURCE, ts(d.exported_at, '내보낸 시각'), counts, map]);
    return { status: 201, body: { imported: imp, id_map: map } };
  });
  res.status(out.status).json(out.body);
}));

app.get('/api/imports', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, source, source_exported_at, counts, imported_at FROM imports WHERE user_id=$1 ORDER BY id', [req.user.id]);
  res.json(rows);
}));

// ======================================================================
// 5일 실험 (카드 5)
// ======================================================================
const EXP_COLS = `id, question, metric_name, unit, calc_rule, plan_rule, missing_rule, duplicate_rule, outlier_rule,
  rounding_rule, week_start, value_min::float8 AS value_min, value_max::float8 AS value_max, created_at`;
const DAY_COLS = `id, day_no, to_char(day_date,'YYYY-MM-DD') AS day_date, rule_version, value::float8 AS value,
  missing_reason, note, diary_snapshot, created_at, updated_at`;

async function getExperiment(uid) {
  const { rows: [e] } = await pool.query(`SELECT ${EXP_COLS} FROM experiments WHERE user_id=$1`, [uid]);
  return e || null;
}

// 오늘(서울) 마감인 내 할 일로 계산한 숫자: 기록할 때 근거로 함께 저장한다.
async function diaryToday(db, uid) {
  const { rows: [s] } = await db.query(`
    WITH t AS (${TASK_SELECT} AND t.due_date = ${TODAY_SQL})
    SELECT to_char(${TODAY_SQL},'YYYY-MM-DD') AS date,
      COUNT(*)::int AS planned, COUNT(*) FILTER (WHERE done)::int AS done,
      COALESCE(SUM(estimated_minutes),0)::int AS estimated_minutes,
      (SELECT COALESCE(SUM(actual_minutes),0)::int FROM work_logs
        WHERE user_id=$1 AND (started_at AT TIME ZONE 'Asia/Seoul')::date = ${TODAY_SQL}) AS actual_minutes_today
    FROM t`, [uid]);
  s.done_rate = s.planned ? Math.round((s.done / s.planned) * 1000) / 10 : null;
  return s;
}

async function experimentState(uid) {
  const exp = await getExperiment(uid);
  const { rows: [{ today }] } = await pool.query(`SELECT to_char(${TODAY_SQL},'YYYY-MM-DD') AS today`);
  if (!exp) return { experiment: null, days: [], rule_change: null, stats: null, today_seoul: today };
  const { rows: days } = await pool.query(
    `SELECT ${DAY_COLS} FROM experiment_days WHERE user_id=$1 AND experiment_id=$2 ORDER BY day_no`, [uid, exp.id]);
  const { rows: [change] } = await pool.query(
    `SELECT id, day1_id, day2_id, old_rule, new_rule, reason, changed_at FROM experiment_rule_changes
     WHERE user_id=$1 AND experiment_id=$2`, [uid, exp.id]);
  // 합계·평균: 값이 빠진 날(NULL)은 더하지도 세지도 않는다. 평균은 소수 첫째 자리로 반올림(ROUND, 0.05 → 0.1).
  const { rows: [stats] } = await pool.query(`
    SELECT
      COUNT(value) FILTER (WHERE day_no <= 2)::int AS before_n,
      SUM(value) FILTER (WHERE day_no <= 2)::float8 AS before_sum,
      ROUND(AVG(value) FILTER (WHERE day_no <= 2), 1)::float8 AS before_avg,
      COUNT(value) FILTER (WHERE day_no >= 3)::int AS after_n,
      SUM(value) FILTER (WHERE day_no >= 3)::float8 AS after_sum,
      ROUND(AVG(value) FILTER (WHERE day_no >= 3), 1)::float8 AS after_avg,
      COUNT(value)::int AS all_n, SUM(value)::float8 AS all_sum, ROUND(AVG(value), 1)::float8 AS all_avg
    FROM experiment_days WHERE user_id=$1 AND experiment_id=$2`, [uid, exp.id]);
  stats.change = stats.before_avg != null && stats.after_avg != null
    ? Math.round((stats.after_avg - stats.before_avg) * 10) / 10 : null;
  const next = days.length + 1;
  return {
    experiment: exp, days, rule_change: change || null, stats, today_seoul: today,
    next: {
      day_no: next <= 5 ? next : null,
      finished: days.length >= 5,
      recorded_today: days.some((x) => x.day_date === today),
      needs_rule_change: days.length === 2 && !change,
    },
  };
}

app.get('/api/experiment', wrap(async (req, res) => { res.json(await experimentState(req.user.id)); }));
app.get('/api/experiment/diary-today', wrap(async (req, res) => { res.json(await diaryToday(pool, req.user.id)); }));

app.post('/api/experiment', wrap(async (req, res) => {
  const uid = req.user.id;
  const b = req.body || {};
  const f = {
    question: text(b.question, '답하려는 질문', { max: 300 }),
    metric_name: text(b.metric_name, '관찰 지표', { max: 100 }),
    unit: text(b.unit, '단위', { max: 20 }),
    calc_rule: text(b.calc_rule, '계산 규칙', { max: 500 }),
    plan_rule: text(b.plan_rule, '계획 규칙', { max: 300 }),
    missing_rule: text(b.missing_rule, '값이 빠졌을 때', { max: 300 }),
    duplicate_rule: text(b.duplicate_rule, '값이 중복될 때', { max: 300 }),
    outlier_rule: text(b.outlier_rule, '값이 튈 때', { max: 300 }),
    rounding_rule: text(b.rounding_rule, '반올림', { max: 300 }),
    week_start: b.week_start === '일' ? '일' : b.week_start === '월' ? '월' : bad('주 시작 요일은 월 또는 일입니다.'),
    value_min: num(b.value_min, '허용 최솟값'),
    value_max: num(b.value_max, '허용 최댓값'),
  };
  if (f.value_max <= f.value_min) bad('허용 최댓값은 최솟값보다 커야 합니다.');
  const { rows: [e] } = await pool.query(
    `INSERT INTO experiments (user_id,question,metric_name,unit,calc_rule,plan_rule,missing_rule,duplicate_rule,outlier_rule,rounding_rule,week_start,value_min,value_max)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (user_id) DO NOTHING RETURNING id`,
    [uid, f.question, f.metric_name, f.unit, f.calc_rule, f.plan_rule, f.missing_rule, f.duplicate_rule, f.outlier_rule,
      f.rounding_rule, f.week_start, f.value_min, f.value_max]);
  if (!e) return res.status(409).json({ error: '실험은 이미 정해져 있습니다. 1일차에 정한 내용은 바꿀 수 없습니다.' });
  res.status(201).json(await experimentState(uid));
}));

// 기록이 하나도 없을 때만 지우고 다시 정할 수 있다.
app.delete('/api/experiment', wrap(async (req, res) => {
  const uid = req.user.id;
  const { rowCount } = await pool.query(
    `DELETE FROM experiments e WHERE e.user_id=$1
       AND NOT EXISTS (SELECT 1 FROM experiment_days d WHERE d.experiment_id = e.id)`, [uid]);
  if (!rowCount) return res.status(409).json({ error: '이미 기록이 있어 실험 설정을 지울 수 없습니다.' });
  res.json({ deleted: true });
}));

function dayValue(b, exp) {
  if (b.value === null || b.value === undefined || b.value === '') {
    return { value: null, missing_reason: text(b.missing_reason, '값이 빠진 이유', { max: 300 }) };
  }
  // 반올림은 DB(NUMERIC(12,1))가 한다: 소수 둘째 자리에서 반올림(0.05 → 0.1, 음수는 0에서 먼 쪽).
  const v = num(b.value, '값');
  if (v < exp.value_min || v > exp.value_max) {
    bad(`값은 ${exp.value_min}~${exp.value_max} ${exp.unit} 안이어야 합니다(튀는 값 규칙). 다시 확인해 주세요.`);
  }
  return { value: v, missing_reason: null };
}

// 하루 기록: 날짜는 서버가 서울 '오늘'로 정한다. 같은 날 두 번째 기록은 409(중복 규칙), 3일차는 규칙을 바꾼 뒤에만.
app.post('/api/experiment/days', wrap(async (req, res) => {
  const uid = req.user.id;
  const b = req.body || {};
  const note = text(b.note, '메모', { max: 500, optional: true });
  const out = await tx(async (c) => {
    const { rows: [exp] } = await c.query(`SELECT ${EXP_COLS} FROM experiments WHERE user_id=$1 FOR UPDATE`, [uid]);
    if (!exp) return { status: 409, body: { error: '먼저 1일차에 실험(질문·지표·규칙)을 정하세요.' } };
    const v = dayValue(b, exp);
    const { rows: days } = await c.query(
      `SELECT id, day_no, to_char(day_date,'YYYY-MM-DD') AS day_date FROM experiment_days WHERE experiment_id=$1 ORDER BY day_no`, [exp.id]);
    const { rows: [{ today }] } = await c.query(`SELECT to_char(${TODAY_SQL},'YYYY-MM-DD') AS today`);
    if (days.length >= 5) return { status: 409, body: { error: '5일 기록을 모두 마쳤습니다.' } };
    if (days.some((x) => x.day_date === today)) {
      return { status: 409, body: { error: '오늘은 이미 기록했습니다. 하루에 한 번만 셉니다(고치려면 오늘 기록의 "고치기").' } };
    }
    const dayNo = days.length + 1;
    if (dayNo >= 3) {
      const { rows: [ch] } = await c.query('SELECT id FROM experiment_rule_changes WHERE experiment_id=$1', [exp.id]);
      if (!ch) return { status: 409, body: { error: '3일차 기록 전에 계획 규칙을 하나 바꿔 주세요.' } };
    }
    const snap = await diaryToday(c, uid);
    const { rows: [d] } = await c.query(
      `INSERT INTO experiment_days (user_id,experiment_id,day_no,day_date,rule_version,value,missing_reason,note,diary_snapshot)
       VALUES ($1,$2,$3,${TODAY_SQL},$4,$5,$6,$7,$8) RETURNING ${DAY_COLS}`,
      [uid, exp.id, dayNo, dayNo <= 2 ? 1 : 2, v.value, v.missing_reason, note, snap]);
    return { status: 201, body: d };
  });
  res.status(out.status).json(out.body);
}));

// 오늘 기록만 고칠 수 있다(지난 날 기록은 고정).
app.put('/api/experiment/days/:id', wrap(async (req, res) => {
  const uid = req.user.id;
  const dayId = id(req.params.id);
  const b = req.body || {};
  const exp = await getExperiment(uid);
  if (!exp) return res.status(404).json({ error: '그 기록을 찾을 수 없습니다.' });
  const v = dayValue(b, exp);
  const note = text(b.note, '메모', { max: 500, optional: true });
  const { rows: [d] } = await pool.query(
    `UPDATE experiment_days SET value=$3, missing_reason=$4, note=$5, updated_at=now()
     WHERE id=$2 AND user_id=$1 AND day_date = ${TODAY_SQL} RETURNING ${DAY_COLS}`,
    [uid, dayId, v.value, v.missing_reason, note]);
  if (!d) return res.status(404).json({ error: '오늘 내 기록만 고칠 수 있습니다.' });
  res.json(d);
}));

// 계획 규칙 바꾸기: 2일차 기록이 끝난 뒤, 3일차 기록 전에 단 한 번
app.post('/api/experiment/rule-change', wrap(async (req, res) => {
  const uid = req.user.id;
  const b = req.body || {};
  const newRule = text(b.new_rule, '새 계획 규칙', { max: 300 });
  const reason = text(b.reason, '바꾸는 이유', { max: 500 });
  const out = await tx(async (c) => {
    const { rows: [exp] } = await c.query('SELECT id, plan_rule FROM experiments WHERE user_id=$1 FOR UPDATE', [uid]);
    if (!exp) return { status: 409, body: { error: '먼저 실험을 정하세요.' } };
    if (newRule === exp.plan_rule) bad('지금 규칙과 다른 규칙을 적어 주세요.');
    const { rows: days } = await c.query('SELECT id, day_no FROM experiment_days WHERE experiment_id=$1 ORDER BY day_no', [exp.id]);
    const { rows: [ch] } = await c.query('SELECT id FROM experiment_rule_changes WHERE experiment_id=$1', [exp.id]);
    if (ch) return { status: 409, body: { error: '계획 규칙은 한 번만 바꿀 수 있습니다.' } };
    if (days.length !== 2) {
      return { status: 409, body: { error: `규칙은 2일차 기록 뒤, 3일차 기록 앞에만 바꿀 수 있습니다(지금 ${days.length}일 기록).` } };
    }
    const { rows: [r] } = await c.query(
      `INSERT INTO experiment_rule_changes (user_id,experiment_id,day1_id,day2_id,old_rule,new_rule,reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, day1_id, day2_id, old_rule, new_rule, reason, changed_at`,
      [uid, exp.id, days[0].id, days[1].id, exp.plan_rule, newRule, reason]);
    return { status: 201, body: r };
  });
  res.status(out.status).json(out.body);
}));

// ======================================================================
// 내보내기 — 내 자료 전체를 JSON 파일 하나로 (비밀번호 해시·세션은 넣지 않는다)
// ======================================================================
app.get('/api/export', wrap(async (req, res) => {
  const uid = req.user.id;
  const q = (sql) => pool.query(sql, [uid]).then((r) => r.rows);
  const exp = await experimentState(uid);
  const data = {
    format: 'pds-diary-export',
    version: 3,
    schema: 'contracts/pds-schema-v3.json',
    exported_at: new Date().toISOString(),
    account: { login_id: req.user.login_id, created_at: req.user.created_at },
    rules: { date_only: 'YYYY-MM-DD, Asia/Seoul 달력 날짜', timestamps: 'ISO 8601 UTC', duration_unit: 'minutes' },
    plans: await q(`SELECT ${PLAN_COLS} FROM plans WHERE user_id=$1 ORDER BY id`),
    plan_revisions: await q(`SELECT id, plan_id, revision_no, title, to_char(start_date,'YYYY-MM-DD') AS start_date,
      to_char(end_date,'YYYY-MM-DD') AS end_date, priority, success_criteria, estimated_minutes, carried_lesson,
      change_note, created_at FROM plan_revisions WHERE user_id=$1 ORDER BY plan_id, revision_no`),
    tasks: await q(`SELECT id, plan_id, title, to_char(due_date,'YYYY-MM-DD') AS due_date, priority, tags,
      estimated_minutes, deleted_at, created_at, updated_at FROM tasks WHERE user_id=$1 ORDER BY id`),
    task_completions: await q('SELECT id, task_id, idempotency_key, completed_at, reopened_at FROM task_completions WHERE user_id=$1 ORDER BY id'),
    work_logs: await q(`SELECT ${LOG_COLS} FROM work_logs WHERE user_id=$1 ORDER BY id`),
    reviews: await q('SELECT id, plan_id, snapshot, lesson, carried_to_plan_id, created_at FROM reviews WHERE user_id=$1 ORDER BY id'),
    running_timer: await q('SELECT task_id, started_at FROM running_timer WHERE user_id=$1'),
    imports: await q('SELECT id, source, source_exported_at, counts, imported_at FROM imports WHERE user_id=$1 ORDER BY id'),
    experiment: exp.experiment,
    experiment_days: exp.days,
    experiment_rule_change: exp.rule_change,
    experiment_stats: exp.stats,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="pds-diary-${stamp}.json"`);
  res.type('application/json').send(JSON.stringify(data, null, 2));
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res) => res.status(404).json({ error: '없는 주소입니다.' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// 오류 응답에는 내부 정보(쿼리, 접속 문자열)를 싣지 않는다. 로그에도 요청 본문(비밀번호)은 남기지 않는다.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON 형식이 잘못되었습니다.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: '보낸 내용이 너무 깁니다.' });
  if (err.code === '23505') return res.status(409).json({ error: '이미 있는 기록과 겹칩니다.' });
  if (err.code === '23514' || err.code === '22P02' || err.code === '22007' || err.code === '22008' || err.code === '22003') {
    return res.status(400).json({ error: '입력값이 허용 범위를 벗어났습니다.' });
  }
  console.error('[error]', req.method, req.path, err.code || '', err.message);
  res.status(500).json({ error: '서버에서 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.' });
});

// 내 컴퓨터·Render처럼 직접 실행할 때는 서버를 켜고, Vercel에서는 api/index.js가 app을 가져다 쓴다.
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  ensureSchema()
    .then(() => app.listen(port, () => console.log(`플랜두씨 다이어리 2: http://localhost:${port}`)))
    .catch((e) => {
      console.error('시작 실패:', e.code || '', e.message);
      process.exit(1);
    });
}

module.exports = app;
