# 연결 테스트 문제 기록

실제 Eureka·GitHub 연결 테스트(`pnpm smoke`)에서 나온 문제와 해결 방법을 정리한다.
새 문제가 생기면 같은 형식으로 아래에 추가한다.

- 테스트 저장소: `ehgjs0866/personal_MCP_test` (비공개, GitHub 무료 요금제)
- 테스트 PR: #1 `feat/pass`, #2 `feat/fail`, #7 `feat/draft`(이후 병합), #9 `feat/fail`(같은 브랜치로 다시 연 PR)
- 실행 방법: `app` 폴더에서 `pnpm smoke github` / `pnpm smoke eureka`

## 요약

| # | 문제 | 상태 | 해결 방식 |
| --- | --- | --- | --- |
| 1 | 클라우드 환경에서 Eureka 접속 불가 | 우회 | 키가 있는 사용자 PC에서 실행 |
| 2 | fine-grained 토큰으로 검사 결과 조회 403 | 우회 | classic 토큰 사용 |
| 3 | 무료 요금제 비공개 저장소에서 필수 검사 설정 확인 불가 | 해결 | 이유 구분 + rulesets 조회 + DeskPet 대체 목록 (D-13) |
| 4 | 같은 커밋에 같은 이름의 검사가 여러 번 실행됨 | 해결 | 이름별 최신 실행만 판정 |
| 5 | 필수가 아닌 검사의 실패가 아무 표시 없이 무시됨 | 해결 | 차단하지 않고 경고로 알림 (D-14) |
| 6 | 병합된 PR이 `merged (draft)`로 표시됨 | 원인 확인 | GitHub의 정상 상태. 코드 변경 없음 |
| 7 | REST 연결에서 `consistency=unverified` | 알려진 제한 | 추후 비교 API로 개선 |
| 8 | Eureka 키 역할이 `guest`, 업무에 description 필드 없음 | 확인 필요 | 쓰기 전에 권한 확인, C-08 확정 |
| 9 | 수정한 `smoke.ts`가 PC에 반영되지 않음 (단계 ID 미출력) | 해결 | 파일 재생성 후 다시 반영, 반영 후 전체 대조 |
| 10 | Gemini: smoke는 성공, demo에서는 Guide·출력 모두 `bad request (400)` | 해결 | SDK의 서버 timeout 헤더 제거, 시간 제한은 abortSignal로 |
| 11 | 데모를 반복 실행할수록 DB 기록이 계속 쌓임 | 해결 | 보존 정책(축약·기간·개수 상한) + SQLite 공간 회수 |
| 12 | 확인 질문에 "확인", "approve", "confirm"은 승인으로 인식되지 않음 | 의도한 동작 (보류) | 승인 답변은 보수적으로 판정. 입력 정규화는 파이프라인 쪽에서 통일 예정 |
| 13 | `pnpm server`를 실행해도 아무 출력이 없음 | 해결 | pnpm 자체 명령과 이름 충돌 → `pnpm harness`로 변경 |

---

## 1. 클라우드 환경에서 Eureka 접속 불가

**증상**
```
✗ 세션 확인 실패 — EUREKA_AUTH_ERROR: 403 Host not in allowlist: api.eureka.codes.
```

**원인**
- Claude 작업 환경(클라우드)의 네트워크 허용 목록에 `api.eureka.codes`가 없다.
- 403이지만 Eureka 서버가 아니라 중간 프록시가 보낸 응답이다. 키 문제가 아니다.

**해결**
- 연결 테스트는 사용자 PC에서 실행한다. 키가 PC의 `.env`에만 있으므로 보안상으로도 이쪽이 맞다.

**참고**
- 사용자 PC에서도 Eureka 403이 나오면 그때는 키 오류이거나 base URL(`flw-d1` 개발 / `flw-v1` 운영)이 키와 맞지 않는 경우다.

---

## 2. fine-grained 토큰으로 검사 결과 조회 403

**증상**
```
✗ checks: unavailable/unknown
    → GITHUB_AUTH_ERROR: 403 Resource not accessible by personal access token
- 지금 승인한다면 차단 사유: cannot_approve_own_pr, checks_unavailable
```

**원인**
- fine-grained 토큰(`github_pat_…`, 길이 93)으로는 check-runs API(`/commits/{sha}/check-runs`)가 거부됐다.
- fine-grained 토큰에서는 이 API에 필요한 권한을 줄 수 없거나 제한적인 것으로 보인다.

**해결**
- classic 토큰(길이 40)으로 바꿨다. 비공개 저장소는 `repo` 범위, 공개 저장소는 `public_repo` 범위.
- 이 범위는 쓰기도 가능하지만 `RestGitHubTransport`는 기본값 `allowWrites=false`라 승인 요청을 보내지 않는다.

**코드 쪽 동작 확인**
- 결과를 읽지 못했을 때 통과로 보지 않고 `checks_unavailable`로 승인을 막았다. 의도한 동작이다.

**남은 선택지**
- fine-grained 토큰을 유지해야 하면 Actions API(`/actions/runs?head_sha=…` → jobs, "Actions: Read" 권한)로 검사 결과를 읽는 대체 경로를 추가할 수 있다. 아직 구현하지 않았다.

---

## 3. 무료 요금제 비공개 저장소에서 필수 검사 설정 확인 불가

**증상**
```
- 필수 검사 설정: unknown, 실패 1, 진행 중 0
- 지금 승인한다면 차단 사유: cannot_approve_own_pr, required_checks_unverified
```
GitHub 화면에서는 검사가 실패했는데도 "Merge pull request" 버튼이 활성화되어 있었다. 보호 규칙이 걸려 있지 않다는 뜻이다.

**원인**
- GitHub 무료 요금제의 비공개 저장소는 브랜치 보호 규칙(classic)과 Rulesets를 쓸 수 없다.
- 설정 조회 API가 "규칙 없음"(404 "Branch not protected")이 아니라 403 "Upgrade to GitHub Pro or make this repository public…"을 돌려준다.
- 기존 코드는 이 403을 이유 구분 없이 `unknown`으로만 처리해서, 왜 확인이 안 되는지 알 수 없었다.

**해결** (README D-13, 사용자 결정 2026-10-05)
1. `unknown`을 이유별로 나눈다.

   | 이유 코드 | 판단 근거 | 의미 |
   | --- | --- | --- |
   | `plan_unsupported` | 403 + "Upgrade to GitHub Pro / make this repository public" | 요금제상 보호 기능 없음 |
   | `insufficient_permission` | 그 외 401·403·404 | 설정은 있을 수 있지만 볼 권한 없음 |
   | `lookup_failed` | 네트워크·서버 오류 | 일시적 조회 실패 |

2. 필수 검사 설정을 조회할 때 Rulesets(`/rules/branches/{branch}`, 읽기 권한으로 조회 가능)와 classic protection(관리자 권한 필요)을 함께 본다. 한쪽만 확인되면 `partial`로 표시하고 승인을 막는다.
3. `plan_unsupported`일 때만 DeskPet 대체 목록을 쓴다. 출처는 `deskpet_config`로 표시한다.
   ```
   # .env
   DESKPET_REQUIRED_CHECKS=ehgjs0866/personal_MCP_test=test
   ```
   권한 부족·조회 실패일 때는 GitHub에 실제 설정이 있을 수 있으므로 대체 목록을 쓰지 않고 계속 막는다.
4. smoke 출력에 이유와 GitHub 응답 문구를 함께 표시한다.

**해결 후 출력 (PR #9)**
```
- DeskPet 대체 필수 검사: ehgjs0866/personal_MCP_test=[test] (GitHub 요금제 미지원일 때만 사용)
- 필수 검사 설정: configured [test], 출처 deskpet_config (요금제상 GitHub 보호 기능 없음)
- 지금 승인한다면 차단 사유: cannot_approve_own_pr, required_check_failed:test
```

**관련 코드**
- `packages/gateways/src/github/RestGitHubTransport.ts` — `requiredChecks()`
- `packages/gateways/src/github/GitHubReviewGateway.ts` — `normalizeRequired()`
- `packages/gateways/src/github/requiredChecksConfig.ts` — `.env` 형식 파서
- 테스트: `packages/gateways/test/restGithub.test.ts`, `tests/e2e/requiredChecks.test.ts`

---

## 4. 같은 커밋에 같은 이름의 검사가 여러 번 실행됨

**증상**
```
- 검사 결과: 실행 2개, 실패 2 [test, test], 진행 중 0
```

**원인**
- PR #9의 head(`293300b`)는 PR #2의 head와 같은 커밋이다. 같은 `feat/fail` 브랜치로 PR을 다시 열었다.
- GitHub Actions는 PR마다 `pull_request` 이벤트로 워크플로를 따로 실행하므로, 같은 커밋에 `test` 실행 기록이 두 개 쌓였다. "Re-run jobs"를 눌러도 같은 현상이 생긴다.
- check-runs API는 그 커밋의 실행을 모두 돌려준다.

**문제점**
- 승인 조건 검사가 같은 이름의 실행 중 목록의 첫 번째 것만 봤다.

  | 상황 | GitHub 기준 (최신 실행) | 수정 전 코드 |
  | --- | --- | --- |
  | 예전 실행 성공 → 새 실행 실패 | 실패 | 첫 번째가 성공이면 통과로 볼 수 있음 (위험) |
  | 예전 실행 실패 → 다시 돌려 성공 | 성공 | 실패로 보고 막음 (불필요한 차단) |

**해결**
- 검사 실행의 id와 시작·완료 시각을 함께 읽는다.
- 같은 이름의 실행이 여러 개면 최신 실행 하나만 판정에 쓴다 (`latestRunsByName`).
  - 최신 판단 순서: 시작 시각 → 완료 시각 → 숫자 id
  - 순서를 판단할 근거가 없으면 보수적으로 가장 나쁜 결과를 쓴다 (진행 중 > 실패 > 성공).
- 필수 검사 판정(`approvalBlockers`)과 경고(`approvalWarnings`), 리뷰 요약 사실 모두 같은 규칙을 쓴다.
- smoke 출력에 제외한 중복 수를 표시한다.

**해결 후 기대 출력 (PR #9)**
```
- 검사 결과: 실행 1개 (같은 이름의 이전 실행 1개 제외), 실패 1 [test], 진행 중 0
```

**직접 확인하는 방법**
```
gh api repos/ehgjs0866/personal_MCP_test/commits/293300b/check-runs --jq ".check_runs[] | {id, name, conclusion, started_at}"
```

**관련 코드**
- `packages/contracts/src/reviewPolicy.ts` — `latestRunsByName()`
- `packages/contracts/src/review.ts` — check run에 `id`, `startedAt`, `completedAt` 추가
- 테스트: `packages/contracts/test/reviewPolicy.test.ts`

---

## 5. 필수가 아닌 검사의 실패가 무시됨

**증상**
- 필수 검사 설정이 확인된 상태에서 필수가 아닌 검사(예: `lint`)가 실패해도 리뷰 요약이나 승인 확인 질문에 아무 언급이 없었다.

**원인**
- Liability 문서는 "필수 검사"만 승인 차단 기준으로 정한다. 그 외 검사는 다루지 않았다.

**해결** (README D-14, 사용자 결정 2026-10-05)
- 승인은 막지 않고 경고(`approvalWarnings`)로 알린다.
- 리뷰 요약: "필수는 아니지만 실패한 검사가 있어요: lint."
- 승인 확인 질문: "참고로 필수는 아니지만 lint 검사가 실패했어요. NewLine/DeskPet PR 42번, 현재 커밋 a1b2c3d을 승인할까요?"
- 필수 검사 설정 자체를 확인하지 못한 경우는 이미 승인을 막으므로 경고를 따로 만들지 않는다.

**관련 코드**
- `packages/contracts/src/reviewPolicy.ts` — `approvalWarnings()`
- `packages/output/src/fallback.ts` — 경고 문구
- 테스트: `tests/e2e/requiredChecks.test.ts`

---

## 6. 병합된 PR이 `merged (draft)`로 표시됨 — 원인 확인

**증상**
```
✓ PR #7 "Feat/draft" — merged (draft), head b1de7f7
- 지금 승인한다면 차단 사유: pr_merged, pr_draft, cannot_approve_own_pr, required_checks_unverified
```

**원인**
- 병합 테스트용 `feat/merge` 브랜치를 `main`이 아니라 이전 작업 브랜치에서 만들었다. 그래서 이 브랜치에 `feat/pass`, `feat/fail`, `feat/draft` 커밋까지 9개가 함께 들어 있었다.
- `feat/merge` PR을 병합하자 그 커밋들이 모두 `main`에 들어갔다.
- GitHub는 다른 PR의 head 커밋이 base 브랜치에 들어가면 그 PR도 "merged"로 자동 표시한다. 초안 PR #7도 head(`b1de7f7`)가 `main`에 포함되어, 초안 상태(`draft: true`)를 유지한 채 merged가 됐다.
- 즉 `merged` + `draft`는 GitHub에서 실제로 생길 수 있는 정상 상태다. 코드 버그가 아니다.

**코드 쪽 판단**
- 차단 사유 `pr_merged`와 `pr_draft`를 둘 다 보고하는 것은 사실 그대로다. 음성 안내는 `pr_merged`를 먼저 보므로 "이미 병합되어 승인할 수 없어요"로 나온다. 변경하지 않는다.

**테스트 저장소 운영 팁**
- 테스트 브랜치는 항상 최신 `main`에서 만든다.
  ```
  git checkout main
  git pull
  git checkout -b feat/새브랜치
  ```
- 다른 브랜치에서 만들면 그 브랜치의 커밋이 PR에 같이 딸려 들어가고, 병합할 때 다른 PR까지 merged로 바뀐다.
- 이번 병합으로 `feat/fail`(FAIL_ME)과 `Delete src/app.js` 커밋도 `main`에 들어갔다. 최종 병합 커밋(`c4f59ac`)은 검사를 통과했지만, 새 브랜치를 만들기 전에 `main`의 `src/app.js` 상태를 한 번 확인한다.

---

## 7. REST 연결에서 `consistency=unverified` — 알려진 제한

**증상**
```
✓ PR #1 "feat/pass test commit" — open, head 66de5ff, consistency=unverified
```

**원인**
- GitHub의 PR 파일 목록 API는 커밋 SHA를 함께 주지 않는다.
- 설계 원칙("시작 SHA를 임의로 복사하지 않는다")에 따라 변경 파일 자료를 "버전 확인됨"으로 표시하지 않는다.

**영향**
- 승인 차단 사유에는 들어가지 않는다. 리뷰 자료의 버전 일관성 표시만 `unverified`로 남는다.

**개선 방향**
- 비교 API(`/compare/{base}...{head}`)로 바꾸면 응답에 SHA가 있어 `verified`로 만들 수 있다. 아직 구현하지 않았다.

---

## 8. Eureka 연결 결과 — 키 역할 `guest`, description 필드 없음

**출력**
```
✓ 세션 확인: workspace sid=10540, roles=guest
✓ 업무 2건 (total=2, completeness=complete)
- description 필드가 있는 업무 0/2건 (README C-08 확인용)
```

**확인된 것**
- 읽기(세션, 템플릿, 업무 목록, 업무 상태)는 개발 환경 `flw-d1`에서 정상 동작한다.
- 업무 응답에 `description` 필드가 없다. README C-08(리마인더용 description이 Eureka에 없음)이 실제로 확인됐다. 지금 코드는 description이 없으면 생략하고 업무 이름으로 대신하지 않는다.

**확인이 필요한 것**
- 키의 역할이 `guest`다. 단계 완료(`POST /_api_/stages/{id}/status`) 같은 쓰기가 403으로 거부될 수 있다.
- 실제 쓰기 테스트 전에 Eureka 관리자에게 쓰기 가능한 역할인지 확인하거나, 쓰기 가능한 키를 받는다.
- 403이 오면 코드는 `EUREKA_AUTH_ERROR`(전송됨, 명시적 실패)로 기록하고 재시도하지 않는다. GitHub 승인은 그대로 유지된다.

---

## 9. 수정한 파일이 PC에 반영되지 않음

**증상**
- smoke에 단계 ID 출력을 추가했는데, PC에서 실행하면 예전 형식(`stages: 이름:상태 / …`)이 그대로 나왔다.

**원인**
- 클라우드 작업 공간에서 PC로 파일을 보낼 때, 같은 경로에 이전에 보낸 파일이 있으면 예전 내용이 다시 전달되는 경우가 있었다. 전송 결과는 "written"으로 성공 표시라 바로 드러나지 않았다.
- 같은 이유로 `deskpet-harness-mvp.bundle`도 한 커밋 뒤처져 있었다.

**해결**
- 보낼 파일을 지우고 새로 만든 뒤 다시 반영했다.
- PC의 파일 77개와 bundle을 다시 읽어 와 최신 코드와 전부 대조했다. 차이 0건, bundle head = 최신 커밋.
- 앞으로는 PC에 반영한 뒤 실제로 바뀌었는지 다시 읽어 와 대조한다.

---

## 10. Gemini 호출이 demo에서만 400

**증상**
- `pnpm smoke llm`은 Guide 단계 제안·출력 문장 모두 성공 (약 2.8초, 4.7초).
- `pnpm demo 11 --ask "..."`에서는 LLM 보조 Guide가 차단(`unsupported_intent`)으로 끝나고, 출력도 `model_error:bad request (400)`로 고정 문구.

**원인**
- Google GenAI SDK는 `httpOptions.timeout`(ms)을 `X-Server-Timeout` 헤더(초)로도 보낸다.
- smoke는 15초, demo는 Guide 4초·출력 5초로 호출했다. 짧은 서버 timeout 값이 400으로 거부된 것으로 판단 (두 경로의 차이는 시간 제한 값뿐).
- demo는 Guide 차단 이유(`llm_unavailable:bad_request`)를 출력하지 않아 원인이 바로 보이지 않았다.

**해결**
- `httpOptions.timeout`을 보내지 않고, 시간 제한은 `abortSignal`로 클라이언트에서 건다. 테스트로 고정.
- 시간 상한 기본값을 실측에 맞춰 늘림: Guide 8초(`llmGuideTimeoutMs`), 출력 8초(`LLM_OUTPUT_TIMEOUT_MS`).
- 400·404 오류에는 짧은 진단 메시지를 붙인다 (키처럼 보이는 문자열은 지움).
- demo 차단 출력에 Guide 근거(`guideRefs`)를 함께 표시.

---

## 11. 데모를 반복 실행할수록 DB 기록이 계속 쌓임

**증상**
- `DESKPET_STORE_PATH`를 켜고 `pnpm demo 12`를 반복하면 operation 목록이 실행마다 3건씩 늘어난다 (8 → 11 → 13건).

**원인**
- 실행마다 새 요청(requestId)이므로 새 operation이 생기는 것 자체는 정상이다.
- 문제는 지우는 규칙이 없었던 것: 종료된 operation은 용량(4MB)이 찰 때만 축약됐고, 축약 기록·턴 결과·닫힌 질문·파이프라인 순서는 지워지지 않았다. 임베디드 보드에서는 저장 공간과 플래시 수명 문제가 된다.
- 데모 끝의 목록도 이번 실행이 아닌 저장소 전체를 보여 줘서 "같은 요청이 계속 쌓이는" 것처럼 보였다.

**해결**
- 보존 정책 추가 (docs/persistent-store.md §보존 정책). 진행 중·결과 불명·복구 중 기록은 지우지 않는다.
- SQLite `auto_vacuum=INCREMENTAL` + 삭제 뒤 공간 회수.
- 데모는 시작할 때 정리하고 정리 건수를 보여 준다. 끝의 목록은 이번 실행 것만 보여 준다. `pnpm db`에 파일·WAL 크기 표시.
- 400번 요청 시뮬레이션에서 레코드 수·파일 사용량이 일정 수준에서 멈추는 것을 테스트로 고정.

## 12. 확인 질문에 "확인", "approve", "confirm"은 승인으로 인식되지 않음

**현상**
- "승인"은 승인으로 처리되지만 "확인", "통과", "approval"은 "잘 듣지 못했어요"로 다시 묻는다.

**판단 (의도한 동작, 보류)**
- 쓰기 확인은 애매하면 실행하지 않는 쪽이 안전하다. "확인"은 "확인해 볼게"처럼 승인이 아닌 뜻으로도 자주 쓰인다.
- 허용 단어: 응, 네, 예, 그래, 좋아, 맞아, ㅇㅇ, 승인, 완료해, 진행해, yes, ok, okay (`packages/harness/src/policy/inputPolicy.ts`).
- 음성 입력은 파이프라인(라우터)에서 의도를 정규화해 넘기므로, 단어 목록은 팀과 입력 형식을 맞출 때 함께 정한다.

---

## 13. `pnpm server`를 실행해도 아무 출력이 없음

**원인**: `server`는 pnpm 자체 명령 이름(store server)이라 package.json 스크립트보다 먼저 처리되어 아무것도 실행되지 않았다. 앞서 `pnpm store`와 같은 문제.
**해결**: 스크립트 이름을 `pnpm harness`로 변경 (`pnpm run server`처럼 run을 붙이는 방법도 있지만 혼동을 피하려고 이름을 바꿈). 이 세션에서 `pnpm server`가 출력 없이 끝나는 것을 재현해 확인했다.

---

## 참고: 의도한 동작 (문제 아님)

| 출력 | 이유 |
| --- | --- |
| `cannot_approve_own_pr` | GitHub는 본인 PR 승인을 허용하지 않는다. 승인까지 시험하려면 다른 계정이 PR을 열어야 한다 |
| `pr_draft`, `pr_merged`, `pr_closed` | PR 상태에 따른 정상 차단 |
| 조회 실패 시 승인 차단 | 확인할 수 없는 조건은 통과로 보지 않는다 (Liability §Confirmation and Execution 1) |
| 승인 성공 후 PR이 merge되지 않음 | DeskPet은 승인(`submit_approval`)만 한다. merge는 설계 범위 밖의 별도 행위다. 2026-10-05 PR #11(작성자 hansung222)에 실제 승인 성공: review 5410644915, `APPROVED`, 커밋 c80b5f5. GitHub 화면에서도 "1 approval" 확인 |
