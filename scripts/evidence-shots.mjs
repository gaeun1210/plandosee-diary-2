#!/usr/bin/env node
// 남길 것 화면 캡처 — 배포 주소를 실제 브라우저로 열어 화면을 찍는다.
// 사용: BASE=https://배포-주소 OUT=docs/evidence/shots node scripts/evidence-shots.mjs
// 시험 계정 1개를 무작위 비밀번호로 만들어 쓰고, 마지막에 계정 삭제까지 한다. 비밀번호는 출력하지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = (process.env.BASE || '').replace(/\/$/, '');
const OUT = process.env.OUT || 'docs/evidence/shots';
fs.mkdirSync(OUT, { recursive: true });
const ID = `shot_${crypto.randomBytes(3).toString('hex')}`;
const PW = `Ps-${crypto.randomBytes(18).toString('base64url')}`;
const log = [];
const note = (k, v) => { log.push({ k, v }); };

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: true });
const page = await ctx.newPage();
const shot = async (name, opts = {}) => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts }); };
const api = (p, method = 'GET', body) => page.evaluate(async ([p, method, body]) => {
  const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pds-diary' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.text() };
}, [p, method, body]);

// 1. 로그인 없이 자료 화면 주소
await page.goto(`${BASE}/?plan=1#tasks`);
await shot('01-login-without-session');
note('01', `로그인 없이 ${BASE}/?plan=1#tasks 를 열었을 때 화면`);
await page.goto(`${BASE}/api/plans`);
await shot('02-api-without-session', { clip: { x: 0, y: 0, width: 1280, height: 160 } });

// 2. 가입
await page.goto(`${BASE}/`);
await page.click('#tab-signup');
await page.fill('#auth-form [name=login_id]', ID);
await page.fill('#auth-form [name=password]', PW);
await page.fill('#auth-form [name=password2]', PW);
await shot('03-signup-form');
await page.click('#auth-submit');
await page.waitForSelector('.desk:not([hidden])');
// 시험 자료 한 건
await api('/api/plans', 'POST', { title: '증거용 시험 계획', start_date: '2026-10-19', end_date: '2026-10-19', priority: 2, success_criteria: '캡처용', estimated_minutes: 30 });
await page.goto(`${BASE}/`);
await page.waitForSelector('.desk:not([hidden])');
await shot('04-after-signup-home');

// 3. 같은 아이디로 다시 가입
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'ko-KR' });
const p2 = await ctx2.newPage();
await p2.goto(`${BASE}/`);
await p2.click('#tab-signup');
await p2.fill('#auth-form [name=login_id]', ID);
await p2.fill('#auth-form [name=password]', PW);
await p2.fill('#auth-form [name=password2]', PW);
await p2.click('#auth-submit');
await p2.waitForTimeout(1500);
await p2.screenshot({ path: path.join(OUT, '05-duplicate-signup.png') });
// 4. 로그인 실패 문구 두 가지
await p2.click('#tab-login');
await p2.fill('#auth-form [name=login_id]', ID);
await p2.fill('#auth-form [name=password]', `${PW}x`);
await p2.click('#auth-submit');
await p2.waitForTimeout(1500);
await p2.screenshot({ path: path.join(OUT, '06-login-wrong-password.png') });
await p2.fill('#auth-form [name=login_id]', `nobody_${ID.slice(5)}`);
await p2.fill('#auth-form [name=password]', PW);
await p2.click('#auth-submit');
await p2.waitForTimeout(1500);
await p2.screenshot({ path: path.join(OUT, '07-login-no-such-id.png') });
await ctx2.close();

// 5. 로그아웃 → 같은 주소 다시 열기
const plans = JSON.parse((await api('/api/plans')).body);
const pid = plans[0].id;
await page.click('#btn-logout');
await page.waitForSelector('#auth-screen:not([hidden])');
await page.goto(`${BASE}/?plan=${pid}#tasks`);
await page.waitForTimeout(1200);
await shot('08-after-logout-same-url');
note('08', `로그아웃 뒤 ${BASE}/?plan=${pid}#tasks 를 열었을 때 화면`);

// 6. 다시 로그인
await page.fill('#auth-form [name=login_id]', ID);
await page.fill('#auth-form [name=password]', PW);
await shot('09-login-form');
await page.click('#auth-submit');
await page.waitForSelector('.desk:not([hidden])');
await page.goto(`${BASE}/?plan=${pid}#plan`);
await page.waitForTimeout(1500);
await shot('10-after-login-plan');

// 7. 계정 창 (내보내기·계정 삭제 안내)
await page.click('#btn-account');
await page.waitForTimeout(800);
await shot('11-account-dialog');
await page.evaluate(() => document.querySelector('#delete-form').scrollIntoView());
await shot('12-account-delete-notice');
await page.keyboard.press('Escape');
const exp = await api('/api/export');
fs.writeFileSync(path.join(OUT, '13-export-sample.json'), exp.body);
note('13', `내보내기 응답 HTTP ${exp.status}, ${exp.body.length}바이트`);

// 8. 계정 삭제
const del = await api('/api/account', 'DELETE', { password: PW, confirm: '계정 삭제' });
note('14', `계정 삭제 응답 HTTP ${del.status} ${del.body}`);
await page.goto(`${BASE}/`);
await page.waitForTimeout(1200);
await shot('14-after-account-delete');

// 9. 휴대폰 크기 로그인 화면
const m = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, locale: 'ko-KR' });
const mp = await m.newPage();
await mp.goto(`${BASE}/`);
await mp.waitForTimeout(1200);
await mp.screenshot({ path: path.join(OUT, '15-login-mobile.png') });
await m.close();

await browser.close();
let txt = JSON.stringify({ base: BASE, test_id: ID, at: new Date().toISOString(), log }, null, 2);
txt = txt.split(PW).join('(가림)');
fs.writeFileSync(path.join(OUT, 'shots-log.json'), txt);
const all = fs.readdirSync(OUT).map((f) => fs.readFileSync(path.join(OUT, f), 'latin1')).join('');
if (all.includes(PW)) { console.error('비밀번호가 결과에 들어감'); process.exit(1); }
console.log('done', ID);
