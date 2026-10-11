'use strict';
// 인증 도구 모음 — 비밀번호(bcrypt), 세션 값(무작위 32바이트), 쿠키
// 비밀번호 원문과 세션 값 원문은 어디에도 저장하거나 기록(console)하지 않는다.

const crypto = require('crypto');
const bcrypt = require('bcryptjs'); // bcryptjs 3.0.3 — 소금값(salt)을 계정마다 새로 만들어 해시 안에 함께 넣어 준다

const BCRYPT_COST = 12;                 // 2^12번 반복. 이 서버에서 한 번 계산에 약 0.3초
const SESSION_HOURS = 24 * 7;           // 로그인 뒤 7일이 지나면 끊긴다(절대 만료, 연장 없음)
const SESSION_MS = SESSION_HOURS * 3600 * 1000;
const FAIL_WINDOW_MIN = 15;             // 같은 아이디로 15분 안에
const FAIL_LIMIT = 5;                   // 5번 틀리면 잠시 막는다

// 없는 아이디로 로그인할 때도 bcrypt 비교를 한 번 해서, 응답 시간으로 아이디가 있는지 알아내기 어렵게 한다.
// 아무도 모르는 무작위 문자열의 해시이며 비밀값이 아니다.
const DUMMY_HASH = '$2b$12$eiprde/.zNnZphQnw6hyGe69oyKzyj1XbkqOGSDqhvZx1lF4alo0C';

const LOGIN_ID_RE = /^[a-z0-9_]{4,20}$/;

function normalizeLoginId(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

// 가입·비밀번호 바꾸기 때 쓰는 검사. 문제가 있으면 안내 문장, 없으면 null.
function passwordProblem(pw, loginId) {
  if (typeof pw !== 'string' || pw.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (pw.length > 64) return '비밀번호는 64자 이하로 정해 주세요.';
  if (bcrypt.truncates(pw)) return '비밀번호가 너무 깁니다(72바이트 초과). 조금 줄여 주세요.';
  if (loginId && pw.toLowerCase().includes(loginId)) return '비밀번호에 아이디를 넣지 마세요.';
  return null;
}

const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_COST);
const checkPassword = (pw, hash) => bcrypt.compare(typeof pw === 'string' ? pw : '', hash || DUMMY_HASH);

// 세션 값: 브라우저에는 원문, DB에는 SHA-256만
const newSessionToken = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

// https에서는 __Host- 접두어(Secure·Path=/·Domain 없음을 브라우저가 강제)를 쓴다. 내 컴퓨터(http)에서는 접두어 없이.
const cookieName = (req) => (req.secure ? '__Host-pds_sid' : 'pds_sid');

function readSessionToken(req) {
  const raw = req.headers.cookie || '';
  const name = cookieName(req);
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
    }
  }
  return null;
}

function setSessionCookie(req, res, token, expiresAt) {
  const attrs = [
    `${cookieName(req)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}`,
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (req.secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${cookieName(req)}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (req.secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

module.exports = {
  BCRYPT_COST, SESSION_HOURS, SESSION_MS, FAIL_WINDOW_MIN, FAIL_LIMIT, LOGIN_ID_RE,
  normalizeLoginId, passwordProblem, hashPassword, checkPassword,
  newSessionToken, tokenHash, readSessionToken, setSessionCookie, clearSessionCookie,
};
