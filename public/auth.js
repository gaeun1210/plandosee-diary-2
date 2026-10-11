'use strict';
// 로그인 화면·계정 메뉴 (과제 7)
// 처음에는 로그인 화면만 보인다. /api/auth/me 가 200이면(로그인한 상태) 다이어리를 켜고, 401이면 로그인 화면을 그대로 둔다.
// 비밀번호는 화면 코드 어디에도 저장하지 않고(변수에 잠깐 담았다가 요청에 실어 보낸 뒤 입력칸을 비운다), 세션 값은 HttpOnly 쿠키라 읽을 수도 없다.

(() => {
  const q = (s) => document.querySelector(s);
  const authScreen = q('#auth-screen');
  const desk = q('.desk');
  const form = q('#auth-form');
  const errBox = q('#auth-error');
  let mode = 'login';

  async function call(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pds-diary' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* 빈 응답 */ }
    return { ok: res.ok, status: res.status, data };
  }
  const fmt = (iso) => new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));

  function showLogin() {
    desk.hidden = true;
    authScreen.hidden = false;
    document.title = '로그인 · 플랜두씨 다이어리 2';
    setTimeout(() => form.login_id.focus(), 0);
  }

  let started = false;
  function showDiary(me) {
    authScreen.hidden = true;
    desk.hidden = false;
    document.title = '플랜두씨 다이어리 2';
    q('#who-name').textContent = me.user.login_id;
    q('#acc-name').textContent = me.user.login_id;
    q('#public-notice').textContent = `${me.user.login_id}님만 볼 수 있는 다이어리입니다 · 로그인 유지: ${fmt(me.session_expires_at)}까지`;
    q('#acc-session').textContent = `이 브라우저의 로그인은 ${fmt(me.session_expires_at)}에 끝납니다(로그인 뒤 7일). 그 뒤에는 다시 로그인해야 합니다.`;
    if (!started) { started = true; window.startDiary(); }
  }

  // 로그인이 끊기면 화면에 남은 내 자료를 지우기 위해 새로 불러온다(로그인 화면만 남는다).
  let lost = false;
  window.onAuthLost = () => { if (!lost) { lost = true; location.replace('/'); } };

  function setMode(m) {
    mode = m;
    q('#tab-login').setAttribute('aria-selected', String(m === 'login'));
    q('#tab-signup').setAttribute('aria-selected', String(m === 'signup'));
    q('#auth-title').textContent = m === 'login' ? '로그인' : '새로 가입';
    q('#auth-submit').textContent = m === 'login' ? '로그인' : '가입하고 시작하기';
    document.querySelectorAll('.only-signup').forEach((n) => { n.hidden = m !== 'signup'; });
    form.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    errBox.textContent = '';
  }
  q('#tab-login').addEventListener('click', () => setMode('login'));
  q('#tab-signup').addEventListener('click', () => setMode('signup'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    const loginId = form.login_id.value.trim().toLowerCase();
    const password = form.password.value;
    if (mode === 'signup') {
      if (!/^[a-z0-9_]{4,20}$/.test(loginId)) { errBox.textContent = '아이디는 영어 소문자·숫자·밑줄(_)로 4~20자입니다.'; return; }
      if (password.length < 8) { errBox.textContent = '비밀번호는 8자 이상이어야 합니다.'; return; }
      if (password !== form.password2.value) { errBox.textContent = '두 비밀번호가 서로 다릅니다.'; return; }
    } else if (!loginId || !password) { errBox.textContent = '아이디와 비밀번호를 적어 주세요.'; return; }
    const btn = q('#auth-submit');
    btn.disabled = true;
    try {
      const r = await call(mode === 'login' ? '/api/auth/login' : '/api/auth/signup', 'POST', { login_id: loginId, password });
      form.password.value = '';
      form.password2.value = '';
      if (!r.ok) { errBox.textContent = (r.data && r.data.error) || `요청이 실패했습니다 (${r.status}).`; return; }
      // 로그인 성공: 화면을 새로 불러 이전 사람의 화면 상태가 섞이지 않게 한다.
      location.reload();
    } catch {
      errBox.textContent = '서버에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.';
    } finally {
      btn.disabled = false;
    }
  });

  q('#btn-logout').addEventListener('click', async () => {
    await call('/api/auth/logout', 'POST').catch(() => {});
    location.replace('/');
  });

  // ---------- 계정 메뉴 ----------
  const accDialog = q('#account-dialog');
  async function loadImports() {
    const r = await call('/api/imports');
    const list = q('#import-list');
    list.replaceChildren();
    if (r.ok) {
      for (const imp of r.data) {
        const c = imp.counts;
        const li = document.createElement('li');
        li.textContent = `${fmt(imp.imported_at)} 가져옴 — ${imp.source}. 계획 ${c.plans}·판 ${c.plan_revisions}·할 일 ${c.tasks}·완료 ${c.task_completions}·실행 기록 ${c.work_logs}·돌아보기 ${c.reviews}건`
          + (imp.source_exported_at ? ` (원본 내보낸 시각 ${fmt(imp.source_exported_at)})` : '');
        list.append(li);
      }
    }
  }
  function openAccount(focusImport) {
    accDialog.querySelectorAll('.form-error').forEach((n) => { n.textContent = ''; });
    accDialog.showModal();
    loadImports();
    if (focusImport) q('#import-form input[type=file]').focus();
  }
  q('#btn-account').addEventListener('click', () => openAccount(false));
  q('#btn-import-empty').addEventListener('click', () => openAccount(true));

  q('#import-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = q('#import-error');
    err.textContent = '';
    const file = e.target.file.files[0];
    if (!file) { err.textContent = '파일을 골라 주세요.'; return; }
    if (file.size > 2 * 1024 * 1024) { err.textContent = '파일이 너무 큽니다(2MB까지).'; return; }
    let data;
    try { data = JSON.parse(await file.text()); } catch { err.textContent = 'JSON 파일을 읽지 못했습니다.'; return; }
    const r = await call('/api/import/t06', 'POST', data);
    if (!r.ok) { err.textContent = (r.data && r.data.error) || `가져오지 못했습니다 (${r.status}).`; return; }
    const c = r.data.imported.counts;
    alert(`가져왔습니다: 계획 ${c.plans}개, 할 일 ${c.tasks}개, 실행 기록 ${c.work_logs}건, 돌아보기 ${c.reviews}건`);
    location.replace('/');
  });

  q('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = f.querySelector('.form-error');
    err.textContent = '';
    if (f.new_password.value !== f.new_password2.value) { err.textContent = '새 비밀번호 두 칸이 서로 다릅니다.'; return; }
    const r = await call('/api/auth/password', 'POST', { current_password: f.current_password.value, new_password: f.new_password.value });
    f.reset();
    if (!r.ok) { err.textContent = (r.data && r.data.error) || `바꾸지 못했습니다 (${r.status}).`; return; }
    err.textContent = '';
    alert(`비밀번호를 바꿨습니다. 이전 로그인 ${r.data.sessions_ended}개를 모두 끊고 이 브라우저만 새로 로그인했습니다.`);
    location.replace('/');
  });

  q('#delete-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = f.querySelector('.form-error');
    err.textContent = '';
    if (f.confirm.value.trim() !== '계정 삭제') { err.textContent = '확인 칸에 "계정 삭제"를 그대로 적어 주세요.'; return; }
    if (!confirm('정말 지울까요? 이 계정과 모든 기록이 지워지고 되돌릴 수 없습니다.')) return;
    const r = await call('/api/account', 'DELETE', { password: f.password.value, confirm: f.confirm.value.trim() });
    f.reset();
    if (!r.ok) { err.textContent = (r.data && r.data.error) || `지우지 못했습니다 (${r.status}).`; return; }
    const c = r.data.removed;
    alert(`계정을 지웠습니다. 함께 지운 자료: 계획 ${c.plans}개, 할 일 ${c.tasks}개, 실행 기록 ${c.work_logs}건, 돌아보기 ${c.reviews}건, 5일 실험 기록 ${c.experiment_days}건`);
    location.replace('/');
  });

  // ---------- 시작: 로그인했는지 서버에 묻는다 ----------
  (async () => {
    try {
      const r = await call('/api/auth/me');
      if (r.ok) showDiary(r.data);
      else showLogin();
    } catch {
      showLogin();
      errBox.textContent = '서버에 닿지 못했습니다. 잠시 뒤 새로고침해 주세요.';
    }
  })();
})();
