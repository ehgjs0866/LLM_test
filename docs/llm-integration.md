# LLM 연결 (Harness Guide·출력 체인)

> LLM 관련 결정·사용법. README D-03은 이 문서를 요약한다.

## 결정

| ID | 내용 | 상태 |
| --- | --- | --- |
| L-01 | LLM은 외부 API로 쓴다 (보드: Jetson Orin Nano 8GB — 경량 라우터·LLM·출력 모델 동시 적재는 메모리·지연상 부적합) | 사용자 결정 |
| L-02 | 개발은 OpenAI 직접 어댑터로 시작. 원격 fallback API(손한솔 담당) 경로는 어댑터 추가로 전환 | 사용자 결정 / 최종 경로 미정 (C-12) |
| L-03 | port는 공급자 중립 (`LlmClient`, `OutputModel`). 공급자 타입은 어댑터 안에만 | 구현 |
| L-04 | 규칙 우선 + LLM 보조 Guide. `pr.review`/`pr.approve`는 항상 규칙 Guide, 그 밖의 의도만 LLM | 구현 |
| L-05 | LLM은 단계 "종류"만 고른다 (`read_pr`/`ask_clarification`/`answer_from_facts`/`unsupported`). PR 번호·저장소·행위 인자는 코드가 ContextPacket에서 만든다. 쓰기는 선택지에 없다 | 구현 |
| L-06 | 출력 모델은 고정 문구로 만든 "기준 문장"을 다시 쓰기만 한다. 외부 결과 원문은 보내지 않는다. 결과는 기존 검증(text·displayText)을 통과해야 쓴다 | 구현 |
| L-07 | ~~Harness LLM은 OpenAI SDK, 출력 체인은 LangChain~~ → L-08로 변경 | 대체됨 |
| L-08 | 개발 기본 공급자는 **Gemini `gemini-3.1-flash-lite`** (OpenAI 해외결제 불가). `LLM_PROVIDER=openai`로 .env만 바꿔 전환 | 사용자 결정 |
| L-09 | 출력 모델 기본 경로는 공급자 중립 `LlmOutputModel`(LlmClient 위). LangChain 출력 체인은 `LLM_OUTPUT_CHAIN=langchain`(openai 전용)으로 남김 — 기술 스택 문서의 "출력 체인 = LangChain"과 다름 (C-13) | 구현 / 문서와 차이 보고 |

## 미정 (C-12)

- 최종 호출 경로: OpenAI 직접 vs 팀 원격 fallback API. 결정 기준은 API 키 보관 위치, 외부로 나가는 데이터 범위, 지연·비용.
- 외부로 보내도 되는 데이터 범위: 지금은 의도·사용자 발화·대상 식별자(저장소/PR 번호)·수집 여부·기준 문장만 보낸다.
- 호출 상한 수치(분당 호출 수, 토큰, 시간 제한)는 실측 후 조정.
- LLM이 맡을 의도 목록(라우터 intention 값)은 미정. 지금은 규칙이 모르는 모든 의도를 LLM이 받는다.
- LLM Wiki 조회를 LLM 선택지에 넣는 것은 Wiki 저장소 연결 후로 미룸.
- C-13: 출력 체인을 LangChain으로 고정할지. Gemini용 LangChain 어댑터를 추가하면 문서대로 맞출 수 있다.
- Gemini 3 계열은 생각 토큰이 출력 토큰 한도에 포함된다. 어댑터는 요청 한도에 1024 토큰 여유를 더한다. `GEMINI_THINKING_LEVEL`과 함께 실측 후 조정.

## 안전 경계

1. LLM 호출은 외부 상태를 바꾸지 않는 읽기다. DispatchOwner·unknown 절차 대상이 아니다.
2. 응답은 공급자가 JSON 스키마를 보장해도 zod로 다시 검증한다. 형식 오류·시간 초과·인증 실패·호출 상한 → 외부 실행 없이 규칙과 같은 차단 결정 / 고정 문구.
3. 사용자 발화는 데이터다. 발화가 쓰기를 지시해도 LLM 경로에는 쓰기 선택지가 없다.
4. 요청당 LLM 호출 수 상한(기본 3), 분당 호출 상한(기본 20), 응답 토큰 상한(기본 400), 호출 시간 상한(Guide 4초, 출력 5초).
5. API 키는 `.env`에만 두고 오류 메시지·로그에 넣지 않는다.

## 파일

| 위치 | 내용 |
| --- | --- |
| `packages/contracts/src/llm.ts` | `LlmClient` port, `LlmError` 공통 오류 코드 |
| `packages/llm/` | `GeminiLlmClient`(generateContent + JSON 스키마), `OpenAiLlmClient`(Responses API 구조화 출력), `LlmOutputModel`(공급자 중립 출력), `LangChainOutputModel`(openai 선택), 호출 상한(`CallWindow`), `createLlmFromEnv`, 테스트용 `ScriptedLlmClient` |
| `packages/harness/src/guide/guidePrompt.ts` | LLM 보조 Guide 지침(`guide-v1`)과 JSON 스키마 |
| `packages/harness/src/guide/LlmGuide.ts` | `LlmGuide`, `RuleFirstGuide` |
| `packages/output/src/prompt.ts` | 출력 모델 지침(`output-v1`)과 입력 구성 |

## 실행

```
# .env (Gemini — 현재 기본)
LLM_PROVIDER=gemini
GEMINI_API_KEY=...            # Google AI Studio에서 발급
GEMINI_MODEL=gemini-3.1-flash-lite

# 나중에 OpenAI로 바꿀 때 (코드 변경 없음)
# LLM_PROVIDER=openai
# OPENAI_API_KEY=...
# OPENAI_MODEL=<모델 이름>

pnpm install                 # 새 패키지(@deskpet/llm, @google/genai, openai, langchain) 설치
pnpm smoke llm               # 작은 호출 2번 (Guide 단계 1, 출력 문장 1)
pnpm demo 11 --ask "이 PR 뭐가 바뀌었어?"   # 규칙이 모르는 의도 → LLM 보조 Guide
pnpm demo 11                 # 기존 흐름 + 출력 문장 다듬기 (모델 문장 거부 시 이유 표시)
```

## 원격 fallback 어댑터를 추가할 때

1. `LlmClient`를 구현하는 어댑터를 `packages/llm`에 추가한다. 공급자 오류는 `LlmError` 코드로 바꾼다.
2. `packages/llm/test/llm.test.ts`의 공통 계약(`adapters` 목록)에 등록해 같은 테스트를 통과시킨다.
3. 구조화 출력을 지원하지 않는 endpoint여도 호출 측이 zod로 다시 검증하므로 Harness 코드는 바꾸지 않는다.
4. `createLlmFromEnv`의 `remote` 분기에서 어댑터를 만든다.
