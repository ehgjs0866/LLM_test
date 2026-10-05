# DeskPet Harness MVP

김도헌 담당 영역(LLM Harness, Eureka/GitHub Gateway, 출력 체인, 웹 상태 투영)의 **실행 가능한 MVP 골격**이다.
설계 계약을 코드로 옮기고 골든 시나리오 G-01과 S-04/05/06/07/08을 **fake Gateway 기반 end-to-end 테스트**로 검증한다.

> 이 저장소는 구현 시작점이다. 실제 GitHub/Eureka 쓰기 호출, 실제 LLM, 실제 영속 저장소, 프로세스 간 transport는 포함하지 않는다.

## 설계 원본 (vault, 읽기 전용)

| 문서 | 이 저장소에서의 역할 |
| --- | --- |
| `wiki/deskpet_harness_guide_Liability.md` | 실행 정책 원본 (확인·재시도·복구·기록) |
| `wiki/deskpet-harness-message-contracts.md` | DTO·메서드·전송 경계 계약 |
| `wiki/deskpet-harness-guide-sensor.md` | Guide/Sensor 입출력 계약 |
| `wiki/deskpet-pr-review-golden-scenario.md` | G-01, S-01~S-12 |
| `wiki/eureka-process.md`, `eureka-desk-pet-guide.pdf` | Eureka REST API |
| `wiki/deskpet-interface-contracts.md` | 팀 공통 타입 (RouteDecision 등), timeout 제안값 |
| `mermaid-diagram.png`, `mermaid-diagram (1).png` | 기록·메시지 / 서비스·Gateway 클래스 다이어그램 |

vault 파일은 생성·수정·삭제하지 않는다. 문서와 코드가 충돌하면 아래 "문서 충돌과 잠정 처리"에 기록하고 담당자에게 보고한다.

## 구조

```
packages/
  contracts/   zod 스키마와 타입 (Envelope, Harness, Records, Review, Guide/Sensor, Output, Projection)
  harness/     HarnessService, Guide(규칙), Sensor(결정적), OperationStore(port + in-memory), DispatchOwner, policy
  gateways/    eureka/ (REST 클라이언트 + fake), github/ (GitHubTransport port + fake, ReviewGateway)
  output/      OutputService, HarnessOutputMapper, 고정 문구 fallback, OutputModel port(mock)
  projector/   RequestStateProjector (revision, epoch, tombstone, snapshot)
tests/e2e/     G-01, S-04/05, S-06/07, S-08
```

## 실행

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm check       # 위 세 개
```

비밀값(`EUREKA_API_KEY`, `GITHUB_TOKEN`)은 `.env`에 둔다. `.env`는 `.gitignore` 대상이며 코드는 키를 로그·기록·에러 메시지에 넣지 않는다. 기본 Eureka base URL은 개발 환경 `flw-d1`이다.

## 연결 테스트 (읽기 전용)

실제 Eureka·GitHub에 GET 요청만 보낸다. 승인·단계 완료 같은 쓰기는 호출하지 않으며, `RestGitHubTransport`는 기본값 `allowWrites=false`라 승인 요청을 보내지 않는다.

```bash
pnpm install
pnpm smoke           # Eureka + GitHub
pnpm smoke eureka    # Eureka만
pnpm smoke github    # GitHub만
```

`.env` 항목은 `.env.example` 참고. `GITHUB_TEST_REPO`/`GITHUB_TEST_PR`이 있으면 해당 PR의 리뷰 묶음 조회와 승인 차단 사유 계산까지 해 본다(계산만 하고 승인하지 않는다).
키·토큰 값은 출력하지 않는다. 이 테스트는 키가 있는 PC에서 실행한다.
연결 테스트에서 나온 문제와 해결 방법은 `docs/connection-test-issues.md`에 정리한다.
필수 검사 설정을 확인할 수 없으면 이유를 함께 출력한다. 무료 요금제의 비공개 저장소처럼 `plan_unsupported`이면 `.env`의 `DESKPET_REQUIRED_CHECKS=owner/repo=test`로 대체 목록을 줄 수 있다.

## 실제 연결 데모 (쓰기 비활성)

실제 GitHub·Eureka Gateway를 `HarnessService`에 연결해 G-01 흐름(리뷰 → 승인 요청 → 확인 질문 → 답변)을 따라간다.
GitHub 승인과 Eureka 단계 완료는 코드에서 꺼져 있다(`allowWrites=false`, 기본값). 승인 단계는 "쓰기가 꺼져 있어서 보내지 않았어요"로 끝나며, 이때 DurableAck도 요청하지 않는다.

```bash
pnpm demo                          # .env의 GITHUB_TEST_PR
pnpm demo 9                        # PR 번호 지정
pnpm demo 9 --answer "응, 승인해"   # 확인 질문 답변 미리 지정
pnpm demo 11 --allow-github-writes  # GitHub 승인을 실제로 보냄 (전송 직전 yes 입력 필요)
```

`--allow-github-writes`를 줘도 실제 전송 직전에 저장소·PR·커밋을 보여 주고 터미널에서 정확히 `yes`를 입력해야 보낸다. 다른 입력이나 입력 없음(비대화형 실행 포함)은 `cancelled` + `not_sent`로 기록되고 자동 재시도하지 않는다. Eureka 쓰기는 데모에서 항상 꺼져 있다.

- 파이프라인 역할(라우팅 결과, 질문 전달 이벤트)은 스크립트가 흉내 낸다. 키보드 입력이므로 입력 채널은 `web`이다.
- `DEMO_EUREKA_ITEM_ID`/`DEMO_EUREKA_STAGE_ID`를 주면 PR과 Eureka 단계를 연결한다(승인 성공 후 후속 적합성 확인에 사용).
- 본인이 연 PR은 GitHub 규칙상 승인할 수 없어 확인 질문 전에 막힌다. 확인 질문까지 보려면 다른 계정이 연 PR이 필요하다.

## 구현 원칙 (요약)

1. LLM/Guide 제안 ≠ 실행 권한. 사용자 확인·중복·SHA·deadline·STT confidence 검사는 일반 코드(`harness/policy`)가 한다.
2. 쓰기 전송 후 결과 불명은 `ActionResult.status = unknown`. 자동 재전송·자동 롤백 없음.
3. DispatchOwner 프로토콜: `may_have_been_sent` 영속 저장 ack 이후에만 Gateway가 외부 쓰기를 전송한다.
4. 재시도: 읽기 일시 오류는 deadline 안에서 최대 1회, 쓰기는 `not_sent`가 확실할 때만 조건부 1회.
5. GitHub 승인과 Eureka 단계 완료는 각각 별도 confirmation·operation. MCP 성공 문구만으로 `succeeded`를 만들지 않는다.
6. 문서에 근거가 없는 결정은 코드 주석과 아래 표에 `inference` / `미정`으로 표시한다.

## 잠정 결정

| ID | 결정 | 상태 |
| --- | --- | --- |
| D-01 | 언어는 TypeScript + Node.js 22, pnpm, vitest, zod. 기술 스택 문서의 Python 출력 체인 요약과 TS 상세 표가 불일치하며 TS를 따른다 | **잠정** |
| D-02 | 모든 저장소는 in-memory 구현. 영속 저장소·Journal 서비스는 미정 | 잠정 |
| D-03 | LLM은 `LlmClient`/`OutputModel` port 뒤의 mock. Guide는 규칙 기반, Sensor는 결정적 | 잠정 |
| D-04 | 수치(임계값·기한·용량·복구 상한)는 `harness/src/policy/config.ts`의 자리값. 실측 후 조정 | 미정 |
| D-05 | Gateway 쓰기 메서드는 다이어그램의 `ActionResult` 대신 정규화된 `GatewayResult`를 반환한다. guide-sensor 흐름(Gateway → Sensor → Harness commit)을 따르기 위함 | inference |
| D-06 | DispatchHandle·AckResult·Gateway port 타입은 `contracts/src/ports.ts`에 둔다. harness가 gateways 구현에 의존하지 않게 함 | inference |
| D-07 | 리뷰 요청과 승인 요청은 파이프라인이 서로 다른 requestId로 줄 수 있다. 승인 요청부터 GitHub 승인·Eureka 확인·반영·최종 출력까지는 같은 requestId를 유지한다 | inference |
| D-08 | 라우터 intention 값 `pr.review`, `pr.approve`, `confirm.approve`, `confirm.reject`와 확인 답변 키워드 규칙은 잠정값이다. 애매하면 `unclear`, 거절 신호가 우선 | inference |
| D-09 | 요청 메타데이터(intent·taskRefs·취소)는 HarnessService 메모리에 둔다. 재시작 시 pending에서 최소 정보를 복원한다. operation·pending·confirmation은 저장소에 있다 | 잠정 |
| D-10 | Eureka `getChangeOutcome`은 멱등키가 없어 인과 연결을 `candidate_only`로만 보고한다. 응답 유실된 단계 완료는 `unknown` + `recovery=needed`로 남고 운영 조치로 정리한다 | inference (C-09) |
| D-11 | 권한을 조회할 수 없으면 승인을 차단한다 (`permission_unverified`). GitHub 실제 권한 조회 수단은 미정 | inference |
| D-12 | 읽기(`get_review_context`)도 OperationRecord로 기록한다. "사용자가 들은 리뷰 SHA"는 같은 대화의 최근 성공 리뷰 operation에서 찾는다 | inference |
| D-13 | 필수 검사 설정 조회 결과를 `configured`/`none_configured`/`unknown(plan_unsupported·insufficient_permission·lookup_failed)`로 구분한다. rulesets(읽기 권한)와 classic protection(관리자 권한)을 함께 본다. GitHub가 요금제상 보호 기능을 제공하지 않을 때(`plan_unsupported`)만 DeskPet 대체 목록(`DESKPET_REQUIRED_CHECKS`)을 쓰고 출처를 `deskpet_config`로 표시한다. 대체 목록이 없거나 다른 이유면 계속 차단 | 사용자 결정 2026-10-05 |
| D-14 | 필수가 아닌 검사의 실패·진행 중은 승인을 막지 않고 경고(`approvalWarnings`)로 리뷰 요약과 확인 질문에 알린다 | 사용자 결정 2026-10-05 |

## 문서 충돌과 잠정 처리

| # | 내용 | 잠정 처리 |
| --- | --- | --- |
| C-01 | 지시서에 있는 `mermaid-diagram-ko.mmd`가 vault 루트에 없다 | PNG 두 장을 근거로 사용 |
| C-02 | Envelope: interface-contracts는 `parentId`·`conversationId`·`turnId`, message-contracts는 `causationId`로 통일하고 대화·턴 ID는 payload에 둔다 | message-contracts를 따른다 |
| C-03 | ActionResult.status: interface-contracts는 `needs_clarification` 포함, message-contracts는 pending으로 분리 | message-contracts를 따른다. 호환 매핑은 구현하지 않음 |
| C-04 | S-05는 거절 시 pending `cancelled`라 하나 pending 상태는 waiting/consumed/expired/revoked | pending=consumed, confirmation=rejected, operation 없음 |
| C-05 | S-04는 라우터 action confidence로도 차단, message-contracts는 RouteDecision confidence로 STT confidence 대체 금지 | 두 검사를 독립적으로 두고 둘 다 통과해야 승인 |
| C-06 | G-01 원문은 승인 후 Eureka 자동 반영, Liability는 별도 확인 요구 | Liability를 따른다 |
| C-07 | Eureka 직접 경로 메서드명: 지시서 `createItem`, 다이어그램 `registerItem` | 다이어그램을 따른다 |
| C-08 | 리마인더용 `description`(interface §9)이 Eureka PDF 응답 예시에는 없다 | optional로 정규화하고 `name`으로 대체하지 않음 (미정) |
| C-09 | golden-scenario P-04는 idempotency key를 가정하나 Eureka PDF에 멱등성 지원이 없다 | completeStage 응답 유실은 unknown. getChangeOutcome의 인과 연결은 inference |
| C-10 | 공식 GitHub MCP 승인 도구 응답은 성공 문구만 반환한다 | Fake transport에 MCP형/REST형 모드를 두고 MCP형은 unknown→reconcile |
| C-11 | message-contracts·guide-sensor의 위키링크 `deskpet_LLM_guide_Liability`가 실제 파일명과 다르다 | vault 수정 없음. 보고만 함 |

## 시나리오 커버리지 (fake Gateway, `tests/e2e`)

| 시나리오 | 테스트 | 검증 내용 |
| --- | --- | --- |
| G-01 | `g01.test.ts` | 리뷰 조회 → 승인 확인 → 승인 1회 → 후속 적합성 확인 → 별도 확인 → Eureka 단계 하나만 완료. operation·confirmation 분리, 웹 투영, 음성 실패 독립 |
| S-01 | `harness.test.ts` | 대상 미확정 → 필요한 슬롯만 재질문, GitHub 호출 0회, 같은 requestId로 이어짐 |
| S-04 | `scenarios.test.ts` | 낮은 STT 신뢰도 명령 → 재발화 요청. 확인 답변 신뢰도 확인 불가 → unclear → 새 확인 |
| S-05 | `scenarios.test.ts` | 거절 → 쓰기 0회, 늦은 승인 무효. Eureka 질문 거절은 GitHub 승인 보존 |
| S-06 | `scenarios.test.ts` | 읽기·승인 인증 오류 → failed, 자동 재시도 없음, Eureka 없음 |
| S-07 | `scenarios.test.ts` | 응답 유실 → unknown, 재전송 없음, 읽기 복구, 복구 상한 → blocked. MCP 성공 문구만 → unknown. 연결 거부 → 조건부 1회 재시도. 재시작 → unknown |
| S-08 | `scenarios.test.ts` | 리뷰 후 / 확인 후 / 승인 직후 / Eureka 동의 후 SHA 변경 각각 차단, 기존 승인 보존 |
| S-09 | `scenarios.test.ts` | GitHub 성공 유지, Eureka만 unknown |
| S-10 | `g01.test.ts`, `projector.test.ts` | 출력 채널 실패와 업무 결과 분리 |
| S-11 | `scenarios.test.ts`, `github.test.ts` | 병합된 PR 승인 차단 |

S-02(다중 후보), S-03(Copilot 리뷰 없음·오래됨), S-12(쓰다듬기)는 단위 수준으로만 다룬다. S-12는 Harness 범위 밖이다.
이 표는 fake 기반 테스트 결과이며 실제 GitHub/Eureka 통합 검증이 아니다.

## 미정 목록

- STT/라우터 confidence 임계값, confirmation 유효 기한, 질문 대기 정책 수치
- 자동 복구 주기·횟수 상한, 저장 용량·최소 보존 기간·LRU 기준
- 에러 코드명(실제 API 응답을 본 뒤 동결), 직접 Eureka 경로의 행위별 사용자 확인 정책
- 실제 GitHub 연결 방식(MCP vs REST), 제출 응답의 증거 능력
- Eureka 응답 스키마 세부(성공 status/body), 페이지네이션(limit=100 초과)
- 프로세스 간 인증·transport, 영속 저장소
