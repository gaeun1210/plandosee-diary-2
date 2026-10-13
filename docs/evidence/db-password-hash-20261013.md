# DB에 저장된 비밀번호 모습 (카드 2)

- 확인한 곳: Neon Console → `neon-bronze-kettle` → 브랜치 `main` → 데이터베이스 `neondb` → SQL Editor
- 확인한 사람·시각: 본인(김가은), 2026-10-13 19:43 (Asia/Seoul)
- 대상 계정: 확인 스크립트가 만든 시험 계정 두 개. **두 계정은 같은 비밀번호로 가입했다**(비밀번호는 실행 때 무작위로 만들어 어디에도 적지 않았다).
  [auth-check-20261012-1626.md](auth-check-20261012-1626.md) 1장 참고.

실행한 조회:

```sql
select id, login_id, password_hash, length(password_hash) as len
from users where login_id like 'chk\_%' order by id;
```

결과(2 rows, 136ms):

| id | login_id | password_hash | len |
|---|---|---|---|
| 1 | chk_a_790963 | `$2b$12$aT0yHlH7zj4PoVQNUEN4MO7srz.XUZvJEnGDfocxsXvAMyHJAWJpm` | 60 |
| 4 | chk_b_790963 | `$2b$12$2zALm/Qw0vtCVmTGH1f4ruo/AAm2OlOI52n3e1Sz0yi4YpnO/77Nq` | 60 |

읽는 법:

- `$2b$` = bcrypt, `12$` = 비용 12(2¹²번 반복), 그다음 22글자 = 소금값(salt), 나머지 31글자 = 해시.
- 입력한 비밀번호 글자는 어디에도 보이지 않는다(T07-C103).
- 같은 비밀번호인데 소금값(`aT0yHlH7zj4PoVQNUEN4MO` / `2zALm/Qw0vtCVmTGH1f4ru`)이 달라 저장된 값 전체가 다르다(T07-C104).
- `chk_c_790963`은 같은 확인에서 계정 삭제 시험으로 지웠으므로 나오지 않는다. id 2·3이 비어 있는 것은 같은 아이디 두 번째 가입 시도(409로 거절)에서 번호만 쓰이고 줄은 생기지 않았기 때문이다.
- 이 해시는 비밀번호가 아니며 되돌릴 수 없다. 시험 계정 비밀번호는 무작위 24글자 이상이라 이 값으로 추측하기 어렵다.
