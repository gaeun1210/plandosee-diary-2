-- 플랜두씨 다이어리 스키마 (v3 — 과제 7: 계정·세션·주인 칸·5일 실험)
-- 과제 6(v2)의 표는 그대로 두고, 모든 자료 표에 주인(user_id)을 붙였다. 과제 7은 새 DB에서 시작한다.
-- 날짜 규칙: 날짜만 있는 값(DATE)은 서울 달력 날짜, 시각(TIMESTAMPTZ)은 UTC로 저장하고 화면에서 Asia/Seoul로 보여 준다.
-- 시간 단위: 모든 *_minutes 칸은 '분'(정수).
-- 서버가 시작될 때마다 실행되므로 모든 문장은 여러 번 실행해도 안전해야 한다.

-- ===== 계정 =====
-- 비밀번호 원문은 어디에도 저장하지 않는다. password_hash는 bcrypt(비용 12, 계정마다 다른 소금값) 결과다.
CREATE TABLE IF NOT EXISTS users (
  id                  BIGSERIAL PRIMARY KEY,
  login_id            TEXT NOT NULL CHECK (login_id ~ '^[a-z0-9_]{4,20}$'),
  password_hash       TEXT NOT NULL CHECK (password_hash ~ '^\$2[aby]\$\d{2}\$.{53}$'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 같은 아이디로 두 번 가입할 수 없다 (대소문자는 가입 때 소문자로 맞춘다).
CREATE UNIQUE INDEX IF NOT EXISTS users_login_id_key ON users(login_id);

-- 세션: 브라우저 쿠키에는 무작위 값(32바이트)만, DB에는 그 값의 SHA-256만 둔다.
-- 로그아웃하면 이 줄을 지우므로 같은 쿠키 값으로 다시 와도 찾을 줄이 없어 거절된다.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- 로그인 실패 기록(무차별 대입 늦추기). 아이디가 있든 없든 똑같이 센다.
CREATE TABLE IF NOT EXISTS login_failures (
  id        BIGSERIAL PRIMARY KEY,
  login_key TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_failures_key_idx ON login_failures(login_key, at);

-- ===== 다이어리 (과제 6 표 + 주인 칸) =====
CREATE TABLE IF NOT EXISTS plans (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_revision  INT NOT NULL DEFAULT 1,
  title             TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,
  priority          SMALLINT NOT NULL CHECK (priority BETWEEN 1 AND 3),
  success_criteria  TEXT NOT NULL CHECK (char_length(success_criteria) BETWEEN 1 AND 1000),
  estimated_minutes INT NOT NULL CHECK (estimated_minutes BETWEEN 0 AND 100000),
  carried_lesson    TEXT CHECK (carried_lesson IS NULL OR char_length(carried_lesson) <= 300),
  carried_from_review_id BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS plans_user_idx ON plans(user_id);

-- 계획의 모든 판(版). 1판이 처음 세운 계획이며, 고칠 때마다 새 판이 쌓인다. 지우거나 고칠 수 없다.
CREATE TABLE IF NOT EXISTS plan_revisions (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id           BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  revision_no       INT NOT NULL,
  title             TEXT NOT NULL,
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,
  priority          SMALLINT NOT NULL,
  success_criteria  TEXT NOT NULL,
  estimated_minutes INT NOT NULL,
  carried_lesson    TEXT,
  change_note       TEXT CHECK (change_note IS NULL OR char_length(change_note) <= 300),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, revision_no)
);

-- 이력은 고칠 수 없다. 지우기는 '계정 삭제' 트랜잭션(pds.purge=on)에서만 허락한다.
CREATE OR REPLACE FUNCTION forbid_revision_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('pds.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'plan_revisions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plan_revisions_append_only ON plan_revisions;
CREATE TRIGGER plan_revisions_append_only
  BEFORE UPDATE OR DELETE ON plan_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_revision_change();

CREATE TABLE IF NOT EXISTS tasks (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id           BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  due_date          DATE NOT NULL,
  priority          SMALLINT NOT NULL CHECK (priority BETWEEN 1 AND 3),
  tags              TEXT[] NOT NULL DEFAULT '{}',
  estimated_minutes INT NOT NULL CHECK (estimated_minutes BETWEEN 0 AND 100000),
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_plan_idx ON tasks(plan_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks(user_id);

-- 완료 기록. 할 일이 '완료'인지는 되돌리지 않은 완료 기록이 있는지로 정한다.
CREATE TABLE IF NOT EXISTS task_completions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id         BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reopened_at     TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);
-- 한 할 일에 되돌리지 않은 완료 기록은 한 건만 있을 수 있다 (연속 클릭·동시 요청 중복 방지).
CREATE UNIQUE INDEX IF NOT EXISTS one_open_completion_per_task
  ON task_completions(task_id) WHERE reopened_at IS NULL;

-- 실행 기록. 계획·할 일 표와 분리되어 있어 저장해도 계획 값을 덮어쓰지 않는다.
CREATE TABLE IF NOT EXISTS work_logs (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id        BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ NOT NULL,
  actual_minutes INT NOT NULL CHECK (actual_minutes BETWEEN 0 AND 100000),
  blocker        TEXT NOT NULL DEFAULT '' CHECK (char_length(blocker) <= 1000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS work_logs_task_idx ON work_logs(task_id);
CREATE INDEX IF NOT EXISTS work_logs_user_idx ON work_logs(user_id);

-- 돌아보기. 저장할 때의 집계 숫자와 고칠 점 한 줄을 남기고, 넘긴 다음 계획을 가리킨다.
CREATE TABLE IF NOT EXISTS reviews (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id            BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  snapshot           JSONB NOT NULL,
  lesson             TEXT NOT NULL CHECK (char_length(lesson) BETWEEN 1 AND 300),
  carried_to_plan_id BIGINT UNIQUE REFERENCES plans(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 돌고 있는 타이머. 사람마다 하나만 돌 수 있다. 정지하면 지워지고 work_logs에 기록 한 건이 생긴다.
CREATE TABLE IF NOT EXISTS running_timer (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  task_id    BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 과제 6 자료를 가져온 기록 (어느 제출의 어떤 내보내기 파일을 옮겼는지)
CREATE TABLE IF NOT EXISTS imports (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source             TEXT NOT NULL,
  source_exported_at TIMESTAMPTZ,
  counts             JSONB NOT NULL,
  id_map             JSONB NOT NULL,
  imported_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== 5일 실험 (카드 5) =====
-- 1일차에 한 번 정하면 고칠 수 없다(트리거). 기록이 하나도 없을 때만 지우고 다시 정할 수 있다(서버에서 확인).
CREATE TABLE IF NOT EXISTS experiments (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  question       TEXT NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  metric_name    TEXT NOT NULL CHECK (char_length(metric_name) BETWEEN 1 AND 100),
  unit           TEXT NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 20),
  calc_rule      TEXT NOT NULL CHECK (char_length(calc_rule) BETWEEN 1 AND 500),
  plan_rule      TEXT NOT NULL CHECK (char_length(plan_rule) BETWEEN 1 AND 300),
  missing_rule   TEXT NOT NULL CHECK (char_length(missing_rule) BETWEEN 1 AND 300),
  duplicate_rule TEXT NOT NULL CHECK (char_length(duplicate_rule) BETWEEN 1 AND 300),
  outlier_rule   TEXT NOT NULL CHECK (char_length(outlier_rule) BETWEEN 1 AND 300),
  rounding_rule  TEXT NOT NULL CHECK (char_length(rounding_rule) BETWEEN 1 AND 300),
  week_start     TEXT NOT NULL CHECK (week_start IN ('월','일')),
  value_min      NUMERIC(12,1) NOT NULL,
  value_max      NUMERIC(12,1) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (value_max > value_min)
);

CREATE OR REPLACE FUNCTION forbid_experiment_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'experiments are fixed on day 1';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS experiments_fixed ON experiments;
CREATE TRIGGER experiments_fixed BEFORE UPDATE ON experiments
  FOR EACH ROW EXECUTE FUNCTION forbid_experiment_update();

-- 하루 기록. 날짜는 저장하는 순간의 서울 날짜로 서버가 정한다(직접 고를 수 없음).
CREATE TABLE IF NOT EXISTS experiment_days (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  experiment_id  BIGINT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  day_no         SMALLINT NOT NULL CHECK (day_no BETWEEN 1 AND 5),
  day_date       DATE NOT NULL,
  rule_version   SMALLINT NOT NULL CHECK (rule_version IN (1,2)),
  value          NUMERIC(12,1),
  missing_reason TEXT CHECK (missing_reason IS NULL OR char_length(missing_reason) <= 300),
  note           TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  diary_snapshot JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, day_no),
  UNIQUE (experiment_id, day_date),
  CHECK ((value IS NULL) = (missing_reason IS NOT NULL)),
  CHECK ((day_no <= 2 AND rule_version = 1) OR (day_no >= 3 AND rule_version = 2))
);

-- 계획 규칙 변경: 실험마다 한 번, 2일차 기록 뒤·3일차 기록 앞에만. 1·2일차 기록을 직접 가리킨다.
CREATE TABLE IF NOT EXISTS experiment_rule_changes (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  experiment_id BIGINT NOT NULL UNIQUE REFERENCES experiments(id) ON DELETE CASCADE,
  day1_id       BIGINT NOT NULL REFERENCES experiment_days(id) ON DELETE CASCADE,
  day2_id       BIGINT NOT NULL REFERENCES experiment_days(id) ON DELETE CASCADE,
  old_rule      TEXT NOT NULL,
  new_rule      TEXT NOT NULL CHECK (char_length(new_rule) BETWEEN 1 AND 300),
  reason        TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
