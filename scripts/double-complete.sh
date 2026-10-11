#!/usr/bin/env bash
# 완료 요청 두 개를 '동시에' 보내 DB가 한 건만 남기는지 확인한다 (버튼 잠금과 무관한 시험).
# 과제 7부터는 로그인이 필요하다. 브라우저 개발자 도구에서 내 쿠키 값을 복사해 SID 환경변수로 넣는다(화면·기록에 남기지 말 것).
# 사용: SID='쿠키값' ./scripts/double-complete.sh https://내-주소 할일ID
set -euo pipefail
BASE="${1:?주소를 주세요}"; TASK="${2:?할 일 ID를 주세요}"
: "${SID:?SID 환경변수에 세션 쿠키 값을 넣어 주세요}"
CK="Cookie: __Host-pds_sid=$SID"
XR="X-Requested-With: pds-diary"
echo "== 되돌려서 진행 중으로 만들기"
curl -s -X POST -H "$CK" -H "$XR" "$BASE/api/tasks/$TASK/reopen" -o /dev/null
for i in 1 2; do
  curl -s -X POST -H "$CK" -H "$XR" "$BASE/api/tasks/$TASK/complete" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)" \
    -w "  요청 $i → HTTP %{http_code}\n" -o /dev/null &
done
wait
echo "== 201 한 번, 200 한 번이 나오면 통과 (201 = 새 완료 기록, 200 = 겹친 요청이라 기록 안 함)"
echo "== 내보내기에서 이 할 일의 reopened_at이 비어 있는 완료 기록 수:"
curl -s -H "$CK" "$BASE/api/export" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('  ',j.task_completions.filter(c=>String(c.task_id)==='$TASK'&&!c.reopened_at).length,'건 (1이면 통과)')})"
