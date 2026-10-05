import { z } from 'zod';
import { LlmError, type GitHubPrTarget, type GuideDecision, type GuideInput, type LlmClient } from '@deskpet/contracts';
import type { GuideFacts } from './Guide.js';
import { RULE_INTENTS, type Guide } from './Guide.js';
import { GUIDE_DECISIONS, GUIDE_INSTRUCTIONS, GUIDE_JSON_SCHEMA, GUIDE_PROMPT_VERSION, GUIDE_SLOTS } from './guidePrompt.js';

/**
 * LLM 보조 Guide (guide-sensor §Guide Interface: "순수 규칙 또는 제한된 LLM 보조").
 * - 규칙 Guide가 처리하지 않는 의도에서만 호출된다 (RuleFirstGuide).
 * - LLM은 단계 종류만 고르고, GuideDecision과 행위 인자는 이 코드가 ContextPacket·facts에서 만든다.
 * - 요청당 호출 수·토큰·시간을 제한한다. 실패·형식 오류·상한 초과면 외부 실행 없이 차단 결정을 돌려준다.
 */
const Proposal = z.object({
  decision: z.enum(GUIDE_DECISIONS),
  missingSlots: z.array(z.string()),
  reason: z.string().max(500),
});

export interface LlmGuideOptions {
  maxCallsPerRequest?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  now?: () => number;
}

export class LlmGuide implements Guide {
  private n = 0;
  private readonly calls = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly llm: LlmClient,
    private readonly o: LlmGuideOptions = {},
  ) {
    this.now = o.now ?? (() => Date.now());
  }

  async proposeNext(input: GuideInput): Promise<GuideDecision> {
    const base = { decisionId: `llm-dec-${++this.n}`, basedOnRevision: input.stateRevision, reasonRefs: [`prompt:${GUIDE_PROMPT_VERSION}`], unknowns: [] as string[] };
    const intent = input.goal.intent;
    const blocked = (why: string): GuideDecision => ({
      ...base,
      kind: 'blocked',
      reasonRefs: [...base.reasonRefs, why],
      payload: { unmetConditions: [`unsupported_intent:${intent}`], unknownEvidence: [], requiredUserOrSystemAction: 'none' },
    });

    const used = this.calls.get(input.requestId) ?? 0;
    if (used >= (this.o.maxCallsPerRequest ?? 3)) return blocked('llm_call_limit');
    this.remember(input.requestId, used + 1);

    const deadlineAt = new Date(Math.min(Date.parse(input.constraints.deadlineAt), this.now() + (this.o.timeoutMs ?? 4_000))).toISOString();
    let proposal: z.infer<typeof Proposal>;
    try {
      const res = await this.llm.complete({
        purpose: 'guide',
        instructions: GUIDE_INSTRUCTIONS,
        input: guideInputText(input),
        jsonSchema: GUIDE_JSON_SCHEMA,
        maxOutputTokens: this.o.maxOutputTokens ?? 200,
        deadlineAt,
      });
      const parsed = Proposal.safeParse(res.json);
      if (!parsed.success) return blocked('llm_invalid_output');
      proposal = parsed.data;
    } catch (e) {
      return blocked(`llm_unavailable:${e instanceof LlmError ? e.code : 'error'}`);
    }
    return this.toDecision(proposal, input, base, blocked);
  }

  /** LLM 선택 → GuideDecision. 인자는 코드가 만든다. 근거가 없으면 선택을 받아들이지 않는다 */
  private toDecision(
    p: z.infer<typeof Proposal>,
    input: GuideInput,
    base: { decisionId: string; basedOnRevision: number; reasonRefs: string[]; unknowns: string[] },
    blocked: (why: string) => GuideDecision,
  ): GuideDecision {
    const facts = input.facts as GuideFacts;
    const target = input.context.packet.target;
    const refs = [...base.reasonRefs, `llm:${p.decision}`];
    switch (p.decision) {
      case 'read_pr': {
        if (!target || target.kind !== 'github_pr') {
          return { ...base, reasonRefs: [...refs, 'target_missing'], kind: 'ask_user', payload: { purpose: 'identify_pr', questionKind: 'clarification', requiredSlots: ['repository', 'prNumber'] } };
        }
        if (facts.reviewError) return blocked('review_read_failed');
        if (facts.review) return { ...base, reasonRefs: refs, kind: 'finish', payload: { reason: 'review_collected', outputFactRefs: ['review'] } };
        const pr = target as GitHubPrTarget;
        return {
          ...base,
          reasonRefs: refs,
          kind: 'propose_action',
          payload: {
            action: 'get_review_context',
            typedArguments: { action: 'get_review_context', repository: pr.repository, prNumber: pr.prNumber, requestedSections: ['changes', 'checks', 'reviews'] },
            target: pr,
            prerequisites: [],
          },
        };
      }
      case 'ask_clarification': {
        const allowed = new Set<string>(GUIDE_SLOTS);
        const slots = [...new Set(p.missingSlots.filter((s) => allowed.has(s)))];
        return { ...base, reasonRefs: refs, kind: 'ask_user', payload: { purpose: 'clarify_request', questionKind: 'clarification', requiredSlots: slots.length ? slots : ['request_detail'] } };
      }
      case 'answer_from_facts':
        // MVP: 답의 근거로 쓸 수 있는 수집 사실은 PR 리뷰 자료뿐이다
        if (facts.review) return { ...base, reasonRefs: refs, kind: 'finish', payload: { reason: 'answer_from_facts', outputFactRefs: ['review'] } };
        return blocked('no_facts_for_answer');
      case 'unsupported':
        return blocked('llm:unsupported');
    }
  }

  private remember(requestId: string, count: number) {
    this.calls.set(requestId, count);
    if (this.calls.size > 1_000) this.calls.delete(this.calls.keys().next().value!);
  }
}

/** LLM 입력: 의도·발화·대상 식별자·수집 여부만. PR 내용·업무 설명·외부 응답 원문은 넣지 않는다 */
export function guideInputText(input: GuideInput): string {
  const t = input.context.packet.target;
  const facts = input.facts as GuideFacts;
  const target =
    t?.kind === 'github_pr' ? `GitHub PR ${t.repository.owner}/${t.repository.name}#${t.prNumber}` : t?.kind === 'eureka_stage' || t?.kind === 'eureka_item' ? `Eureka 업무 ${t.itemId}` : '없음';
  return [
    `의도(라우터): ${input.goal.intent}`,
    `사용자 발화: """${input.goal.currentTurn.rawText.slice(0, 500)}"""`,
    `대상: ${target}`,
    `후보 수: ${input.context.packet.candidates.length}`,
    `수집된 사실: ${facts.review ? 'PR 리뷰 자료 있음' : facts.reviewError ? `PR 조회 실패(${facts.reviewError})` : '없음'}`,
    `단계: ${input.stateRevision}`,
  ].join('\n');
}

/**
 * 규칙 우선 Guide. 규칙이 아는 의도(RULE_INTENTS)는 항상 규칙으로 처리해 시나리오 동작을 고정한다.
 * 모르는 의도만 LLM 보조 Guide에 넘기고, LLM이 없으면 규칙의 차단 결정을 쓴다.
 */
export class RuleFirstGuide implements Guide {
  constructor(
    private readonly rules: Guide,
    private readonly llm?: Guide,
  ) {}
  proposeNext(input: GuideInput): GuideDecision | Promise<GuideDecision> {
    if (RULE_INTENTS.has(input.goal.intent) || !this.llm) return this.rules.proposeNext(input);
    return this.llm.proposeNext(input);
  }
}
