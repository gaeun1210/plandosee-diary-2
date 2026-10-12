'use strict';
// 5일 실험 화면 (과제 7 카드 5)
// 1일차에 질문·지표·단위·계산 규칙·계획 규칙·처리 규칙을 한 번 정하고(서버가 고정),
// 서울 날짜로 서로 다른 5일을 기록한다. 2일차 기록 뒤·3일차 기록 앞에 계획 규칙을 한 번만 바꾼다.
// 합계·평균은 서버가 계산하고, 화면에는 손으로 더해 볼 수 있게 식을 함께 보여 준다.
// app.js의 el·api·toast·openDialog를 그대로 쓴다.

(() => {
  const $e = (s) => document.querySelector(s);
  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
  const dow = (ymd) => WEEKDAY[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
  const fmtT = (iso) => new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
  const n1 = (v) => (v == null ? '–' : Number(v).toFixed(1));
  let st = null;

  const EXAMPLE = {
    question: '하루 마감 할 일을 3개까지만 잡으면, 그날 마감 할 일을 끝내는 비율이 올라갈까?',
    metric_name: '하루 완료율',
    unit: '%',
    calc_rule: '그날(서울 날짜) 마감인 할 일 중, 밤에 기록할 때 완료된 할 일 수 ÷ 그날 마감인 할 일 수 × 100',
    plan_rule: '하루 마감 할 일은 개수 제한 없이 생각나는 대로 붙인다',
    missing_rule: '그날 마감 할 일이 0개면 "값 없음"으로 두고, 합계·평균에서 뺀다(0으로 채우지 않는다)',
    duplicate_rule: '하루에 한 번만 센다. 같은 날 두 번째 저장은 거절되고, 고칠 때는 그날 기록을 고친다',
    outlier_rule: '0~100 밖의 값은 저장하지 않는다. 범위 안에서 튀는 값은 그대로 두고 메모에 이유를 적는다',
    rounding_rule: '값과 평균 모두 소수 첫째 자리까지(둘째 자리에서 반올림, 0.05 → 0.1)',
    value_min: '0', value_max: '100', week_start: '월',
  };

  async function load() {
    try {
      st = await api('/api/experiment');
      render();
    } catch (e) { toast(`5일 실험을 불러오지 못했습니다: ${e.message}`, true); }
  }
  window.loadExperiment = load;

  function ruleLine(k, v) { return el('div', {}, el('dt', { text: k }), el('dd', { text: v })); }

  function render() {
    const body = $e('#exp-body');
    const actions = $e('#exp-actions');
    actions.replaceChildren();
    if (!st.experiment) {
      body.replaceChildren(el('section', { class: 'card exp-empty' },
        el('h2', { text: '아직 실험을 정하지 않았어요' }),
        el('p', { text: '오늘이 1일차입니다. 답하려는 질문 한 문장, 볼 지표 하나와 단위, 계산 규칙, 계획 규칙을 정하면 고정됩니다.' }),
        el('button', { type: 'button', class: 'btn-primary', text: '1일차: 실험 정하기', onclick: openSetup })));
      return;
    }
    const x = st.experiment;
    const ch = st.rule_change;
    const days = st.days;
    const byNo = Object.fromEntries(days.map((d) => [d.day_no, d]));

    // 다음 할 일 버튼
    if (st.next.finished) actions.append(el('span', { class: 'pill-done', text: '5일 기록 완료' }));
    else if (st.next.needs_rule_change) actions.append(el('button', { type: 'button', class: 'btn-primary', text: '3일차 전: 계획 규칙 바꾸기', onclick: openRule }));
    else if (st.next.recorded_today) actions.append(el('span', { class: 'pill-wait', text: `오늘은 기록했어요 · ${st.next.day_no}일차는 내일 이후에` }));
    else actions.append(el('button', { type: 'button', class: 'btn-primary', text: `오늘 ${st.next.day_no}일차 기록하기`, onclick: () => openDay(null) }));
    if (!days.length) actions.append(el('button', { type: 'button', class: 'btn-line', text: '설정 지우고 다시 정하기', onclick: resetExp }));
    else actions.append(el('button', { type: 'button', class: 'btn-line', text: '제출용 기록 받기 (.md)', onclick: downloadMd }));

    // 고정한 내용
    const fixed = el('section', { class: 'card exp-fixed' },
      el('div', { class: 'ch' }, el('h2', { text: '1일차에 고정한 것' }), el('span', { class: 'muted', text: `${fmtT(x.created_at)} 고정 · 바꿀 수 없음` })),
      el('p', { class: 'exp-q', text: `“${x.question}”` }),
      el('dl', { class: 'props exp-props' },
        ruleLine('관찰 지표', `${x.metric_name} (단위: ${x.unit})`),
        ruleLine('계산 규칙', x.calc_rule),
        ruleLine('계획 규칙 (1·2일차)', x.plan_rule),
        ruleLine('계획 규칙 (3~5일차)', ch ? ch.new_rule : '아직 바꾸지 않음 — 2일차 기록 뒤에 바꿉니다'),
        ruleLine('값이 빠졌을 때', x.missing_rule),
        ruleLine('값이 중복될 때', x.duplicate_rule),
        ruleLine('값이 튈 때', `${x.outlier_rule} (허용 범위 ${x.value_min}~${x.value_max} ${x.unit})`),
        ruleLine('반올림', x.rounding_rule),
        ruleLine('주 시작 요일', `${x.week_start}요일`)));

    // 시간 순서: 1일차 → 2일차 → 규칙 변경 → 3·4·5일차
    const items = [];
    const dayItem = (no) => {
      const d = byNo[no];
      if (!d) {
        return el('li', { class: 'tl-day tl-empty' }, el('span', { class: 'tl-no', text: `${no}일차` }),
          el('span', { class: 'muted', text: '아직 기록 없음' }));
      }
      const s = d.diary_snapshot || {};
      const isToday = d.day_date === st.today_seoul;
      return el('li', { class: 'tl-day' },
        el('span', { class: 'tl-no', text: `${no}일차` }),
        el('div', { class: 'tl-main' },
          el('p', { class: 'tl-date', text: `${d.day_date.replaceAll('-', '.')} (${dow(d.day_date)}) · 규칙 ${d.rule_version}판 · 기록 #${d.id}` }),
          el('p', { class: 'tl-val' }, d.value == null
            ? el('b', { class: 'miss', text: `값 없음 — ${d.missing_reason}` })
            : el('b', { text: `${n1(d.value)} ${x.unit}` })),
          el('p', { class: 'tl-snap muted', text: `그날 다이어리(저장할 때): 완료 체크 ${s.completed_today ?? '–'}개 · 마감 할 일 ${s.planned ?? '–'}개 중 ${s.done ?? '–'}개 완료${s.done_rate != null ? ` (완료율 ${n1(s.done_rate)}%)` : ''} · 실제로 한 시간 ${s.actual_minutes_today ?? 0}분` }),
          d.note ? el('p', { class: 'tl-note', text: d.note }) : null,
          el('p', { class: 'tl-time muted', text: `저장 ${fmtT(d.created_at)}${d.updated_at !== d.created_at ? ` · 고침 ${fmtT(d.updated_at)}` : ''}` })),
        isToday ? el('button', { type: 'button', class: 'mini', text: '고치기', onclick: () => openDay(d) }) : null);
    };
    items.push(dayItem(1), dayItem(2));
    if (ch) {
      const d1 = days.find((d) => String(d.id) === String(ch.day1_id));
      const d2 = days.find((d) => String(d.id) === String(ch.day2_id));
      items.push(el('li', { class: 'tl-rule' },
        el('span', { class: 'tl-no', text: '규칙 변경' }),
        el('div', { class: 'tl-main' },
          el('p', { class: 'tl-date', text: `${fmtT(ch.changed_at)} 바꿈 · 근거: 1일차 기록 #${ch.day1_id}(${d1 ? d1.day_date : '?'}), 2일차 기록 #${ch.day2_id}(${d2 ? d2.day_date : '?'})` }),
          el('p', {}, el('s', { text: ch.old_rule }), ' → ', el('b', { text: ch.new_rule })),
          el('p', { class: 'tl-note', text: `이유: ${ch.reason}` }))));
    } else {
      items.push(el('li', { class: 'tl-rule tl-empty' }, el('span', { class: 'tl-no', text: '규칙 변경' }),
        el('span', { class: 'muted', text: '2일차 기록 뒤, 3일차 기록 전에 한 번' })));
    }
    items.push(dayItem(3), dayItem(4), dayItem(5));
    const timeline = el('section', { class: 'card exp-timeline' },
      el('div', { class: 'ch' }, el('h2', { text: '5일 기록' }), el('span', { class: 'muted', text: `서울 날짜 기준 · 오늘 ${st.today_seoul}` })),
      el('ol', { class: 'etl' }, items));

    // 비교: 같은 지표·같은 단위·같은 계산 규칙
    const vals = (from, to) => days.filter((d) => d.day_no >= from && d.day_no <= to && d.value != null).map((d) => n1(d.value));
    const formula = (arr, sum, avg) => (arr.length ? `(${arr.join(' + ')}) = ${n1(sum)}, ${n1(sum)} ÷ ${arr.length} = ${n1(avg)}` : '기록 없음');
    const s = st.stats;
    const row = (label, arr, n, sum, avg) => el('tr', {},
      el('th', { scope: 'row', text: label }), el('td', { text: String(n) }), el('td', { text: sum == null ? '–' : n1(sum) }),
      el('td', {}, el('b', { text: avg == null ? '–' : `${n1(avg)} ${x.unit}` })), el('td', { class: 'formula', text: formula(arr, sum, avg) }));
    const compare = el('section', { class: 'card exp-compare' },
      el('div', { class: 'ch' }, el('h2', { text: '규칙 바꾸기 전과 후' }), el('span', { class: 'muted', text: `지표 ${x.metric_name} · 단위 ${x.unit} · 계산 규칙 동일` })),
      el('div', { class: 'tbl-wrap' }, el('table', { class: 'exp-table' },
        el('thead', {}, el('tr', {}, ['', '센 날', '합계', '평균', '손으로 더해 보기'].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {},
          row('전 (1·2일차)', vals(1, 2), s.before_n, s.before_sum, s.before_avg),
          row('후 (3~5일차)', vals(3, 5), s.after_n, s.after_sum, s.after_avg),
          row('5일 전체', vals(1, 5), s.all_n, s.all_sum, s.all_avg)))),
      el('p', { class: 'exp-diff' }, s.change == null ? '전과 후 평균이 모두 있어야 비교할 수 있어요.'
        : `후 평균 − 전 평균 = ${n1(s.after_avg)} − ${n1(s.before_avg)} = ${s.change > 0 ? '+' : ''}${n1(s.change)} ${x.unit}`
          + (s.change < 0 ? ' (나빠진 결과도 그대로 둡니다)' : '')),
      el('p', { class: 'hint', text: '값 없음인 날은 더하지도, 세지도 않습니다(빠진 값 규칙). 평균은 서버가 PostgreSQL ROUND로 소수 첫째 자리에 맞춥니다.' }));

    body.replaceChildren(fixed, timeline, compare);
  }

  // ---------- 제출용 Markdown ----------
  function downloadMd() {
    const x = st.experiment; const ch = st.rule_change; const s = st.stats;
    const fmtFull = (iso) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
    const L = [];
    L.push('# 5일 실험 기록 (플랜두씨 다이어리 2에서 내보냄)', '');
    L.push(`- 내보낸 시각: ${fmtFull(new Date().toISOString())} (Asia/Seoul)`);
    L.push(`- 1일차에 고정한 시각: ${fmtFull(x.created_at)}`, '');
    L.push('## 1일차에 고정한 것', '');
    L.push(`- 답하려는 질문: ${x.question}`);
    L.push(`- 관찰 지표: ${x.metric_name}`);
    L.push(`- 단위: ${x.unit}`);
    L.push(`- 계산 규칙: ${x.calc_rule}`);
    L.push(`- 처음 계획 규칙(1·2일차): ${x.plan_rule}`);
    L.push(`- 값이 빠졌을 때: ${x.missing_rule}`);
    L.push(`- 값이 중복될 때: ${x.duplicate_rule}`);
    L.push(`- 값이 유난히 튈 때: ${x.outlier_rule} (허용 범위 ${x.value_min}~${x.value_max} ${x.unit})`);
    L.push(`- 반올림: ${x.rounding_rule}`);
    L.push(`- 주 시작 요일: ${x.week_start}요일`, '');
    L.push('## 기록 (시간 순서)', '');
    L.push('| 순서 | 무엇 | 날짜(서울) | 값 | 계획 규칙 | 저장 시각 | 메모 |', '|---|---|---|---|---|---|---|');
    const dayRow = (d) => `| ${d.day_no}일차 | 기록 #${d.id} | ${d.day_date} (${dow(d.day_date)}) | ${d.value == null ? `값 없음(${d.missing_reason})` : `${n1(d.value)} ${x.unit}`} | ${d.rule_version}판 | ${fmtFull(d.created_at)} | ${(d.note || '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`;
    st.days.filter((d) => d.day_no <= 2).forEach((d) => L.push(dayRow(d)));
    if (ch) L.push(`| 규칙 변경 | 변경 #${ch.id} (근거: 기록 #${ch.day1_id}·#${ch.day2_id}) | — | — | ${ch.old_rule} → **${ch.new_rule}** | ${fmtFull(ch.changed_at)} | 이유: ${ch.reason.replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
    st.days.filter((d) => d.day_no >= 3).forEach((d) => L.push(dayRow(d)));
    L.push('', '## 바꾸기 전과 후 (같은 지표·같은 단위·같은 계산 규칙)', '');
    const vals = (a, b) => st.days.filter((d) => d.day_no >= a && d.day_no <= b && d.value != null).map((d) => n1(d.value));
    const f = (arr, sum, avg) => (arr.length ? `(${arr.join(' + ')}) = ${n1(sum)}, ${n1(sum)} ÷ ${arr.length} = ${n1(avg)}` : '기록 없음');
    L.push('| 구간 | 센 날 | 합계 | 평균 | 손으로 더한 식 |', '|---|---|---|---|---|');
    L.push(`| 전 (1·2일차) | ${s.before_n} | ${s.before_sum == null ? '–' : n1(s.before_sum)} | ${s.before_avg == null ? '–' : n1(s.before_avg)} ${x.unit} | ${f(vals(1, 2), s.before_sum, s.before_avg)} |`);
    L.push(`| 후 (3~5일차) | ${s.after_n} | ${s.after_sum == null ? '–' : n1(s.after_sum)} | ${s.after_avg == null ? '–' : n1(s.after_avg)} ${x.unit} | ${f(vals(3, 5), s.after_sum, s.after_avg)} |`);
    L.push(`| 5일 전체 | ${s.all_n} | ${s.all_sum == null ? '–' : n1(s.all_sum)} | ${s.all_avg == null ? '–' : n1(s.all_avg)} ${x.unit} | ${f(vals(1, 5), s.all_sum, s.all_avg)} |`);
    if (s.change != null) L.push('', `후 평균 − 전 평균 = ${n1(s.after_avg)} − ${n1(s.before_avg)} = ${s.change > 0 ? '+' : ''}${n1(s.change)} ${x.unit}`);
    const blob = new Blob([L.join('\n') + '\n'], { type: 'text/markdown;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `5day-experiment-${st.today_seoul}.md` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- 1일차 설정 ----------
  function openSetup() {
    const d = $e('#exp-setup-dialog');
    d.querySelector('form').reset();
    openDialog(d);
  }
  $e('#exp-example').addEventListener('click', () => {
    const f = $e('#exp-setup-form');
    for (const [k, v] of Object.entries(EXAMPLE)) f[k].value = v;
  });
  $e('#exp-setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = f.querySelector('.form-error');
    const body = Object.fromEntries(new FormData(f).entries());
    if (!confirm('이대로 고정할까요? 저장한 뒤에는 바꿀 수 없습니다.')) return;
    try {
      st = await api('/api/experiment', { method: 'POST', body });
      f.closest('dialog').close();
      toast('1일차 실험 설정을 고정했습니다. 오늘 밤 1일차를 기록하세요.');
      render();
    } catch (ex) { err.textContent = ex.message; }
  });
  async function resetExp() {
    if (!confirm('기록이 없으니 설정을 지우고 다시 정할 수 있어요. 지울까요?')) return;
    try { await api('/api/experiment', { method: 'DELETE' }); await load(); } catch (ex) { toast(ex.message, true); }
  }

  // ---------- 하루 기록 ----------
  let editing = null;
  const dayForm = $e('#exp-day-form');
  dayForm.missing.addEventListener('change', () => {
    dayForm.querySelector('.missing-only').hidden = !dayForm.missing.checked;
    dayForm.value.disabled = dayForm.missing.checked;
  });
  async function openDay(day) {
    editing = day;
    const x = st.experiment;
    dayForm.reset();
    dayForm.value.disabled = false;
    dayForm.querySelector('.missing-only').hidden = true;
    $e('#exp-day-title').textContent = day ? `${day.day_no}일차 기록 고치기 (오늘만 가능)` : `${st.next.day_no}일차 기록 (오늘 ${st.today_seoul})`;
    $e('#exp-day-hint').textContent = `계산 규칙: ${x.calc_rule}`;
    $e('#exp-value-label').textContent = `${x.metric_name} (${x.unit}, ${x.value_min}~${x.value_max})`;
    if (day) {
      if (day.value == null) { dayForm.missing.checked = true; dayForm.missing.dispatchEvent(new Event('change')); dayForm.missing_reason.value = day.missing_reason || ''; }
      else dayForm.value.value = String(day.value);
      dayForm.note.value = day.note || '';
    }
    const box = $e('#exp-diary-today');
    box.replaceChildren(el('span', { class: 'muted', text: '오늘 다이어리 숫자를 불러오는 중…' }));
    openDialog($e('#exp-day-dialog'));
    try {
      const s = await api('/api/experiment/diary-today');
      box.replaceChildren(...[
        el('p', { text: `오늘(${s.date}) 완료로 체크한 할 일 ${s.completed_today}개(마감일 상관없이) · 오늘 마감 할 일 ${s.planned}개 중 ${s.done}개 완료${s.done_rate != null ? ` → 완료율 ${n1(s.done_rate)}%` : ' → 마감 할 일이 없어 완료율 없음'} · 오늘 실제로 한 시간 ${s.actual_minutes_today}분` }),
        el('button', { type: 'button', class: 'mini', text: `완료한 수 ${s.completed_today}개 넣기`, onclick: () => { dayForm.value.value = String(s.completed_today); } }),
        s.done_rate != null ? el('button', { type: 'button', class: 'mini', text: '완료율 넣기', onclick: () => { dayForm.value.value = n1(s.done_rate); } }) : null,
        el('button', { type: 'button', class: 'mini', text: `실제 시간 ${s.actual_minutes_today}분 넣기`, onclick: () => { dayForm.value.value = String(s.actual_minutes_today); } })].filter(Boolean));
    } catch { box.replaceChildren(); }
  }
  dayForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = dayForm.querySelector('.form-error');
    const body = dayForm.missing.checked
      ? { value: null, missing_reason: dayForm.missing_reason.value, note: dayForm.note.value }
      : { value: dayForm.value.value === '' ? '' : Number(dayForm.value.value), note: dayForm.note.value };
    if (!dayForm.missing.checked && dayForm.value.value === '') { err.textContent = '값을 적거나 "오늘은 값이 없음"을 고르세요.'; return; }
    try {
      if (editing) await api(`/api/experiment/days/${editing.id}`, { method: 'PUT', body });
      else await api('/api/experiment/days', { method: 'POST', body });
      dayForm.closest('dialog').close();
      toast(editing ? '오늘 기록을 고쳤습니다.' : '오늘 기록을 저장했습니다.');
      await load();
    } catch (ex) { err.textContent = ex.message; }
  });

  // ---------- 규칙 바꾸기 ----------
  function openRule() {
    const f = $e('#exp-rule-form');
    f.reset();
    $e('#exp-old-rule').textContent = st.experiment.plan_rule;
    openDialog($e('#exp-rule-dialog'));
  }
  $e('#exp-rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = f.querySelector('.form-error');
    try {
      await api('/api/experiment/rule-change', { method: 'POST', body: { new_rule: f.new_rule.value, reason: f.reason.value } });
      f.closest('dialog').close();
      toast('계획 규칙을 바꿨습니다. 다음 기록부터 3일차입니다.');
      await load();
    } catch (ex) { err.textContent = ex.message; }
  });
})();
