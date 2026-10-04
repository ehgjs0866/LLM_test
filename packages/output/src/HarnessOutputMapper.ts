import type { ConfirmationScope, Emotion, HarnessResult, OutputRequest } from '@deskpet/contracts';
import { short } from './format.js';

/**
 * «function» HarnessOutputMapper — 김도헌 설계 책임, 호출 주체는 파이프라인 (다이어그램).
 * HarnessResult를 OutputRequest로 변환한다. 업무 status와 사실 식별자는 코드가 복사한다.
 * Harness는 완성 문장을 만들지 않고 사실·질문 목적·출처를 반환한다 (Liability §Ownership).
 */
export interface OutputContext {
  outputId?: string;
  conversationId?: string;
  maxSpeechChars?: number;
  allowedEmotions?: Emotion[];
}

const ALL_EMOTIONS: Emotion[] = ['neutral', 'cheerful', 'concerned', 'thinking', 'apologetic'];

export function mapHarnessResult(r: HarnessResult, ctx: OutputContext = {}): OutputRequest {
  const isQuestion = r.disposition === 'awaiting_user' && !!r.pending;
  const outputId = isQuestion ? r.pending!.outputId : (ctx.outputId ?? `out-${r.requestId}-${r.actionResults.length}`);
  return {
    outputId,
    requestRefs: {
      requestId: r.requestId,
      ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
      operationIds: r.actionResults.map((a) => a.operationId),
    },
    purpose: isQuestion ? 'question' : 'result',
    actionResults: r.actionResults,
    facts: { ...r.facts, disposition: r.disposition, processingErrors: r.processingErrors.map((e) => e.provisionalCode) },
    sources: r.sources,
    requiredMeaning: requiredMeaning(r),
    constraints: { language: 'ko-KR', maxSpeechChars: ctx.maxSpeechChars ?? 220, allowedEmotions: ctx.allowedEmotions ?? ALL_EMOTIONS },
    ...(isQuestion ? { pendingId: r.pending!.pendingId } : {}),
    ...(isQuestion && r.pending!.confirmationId ? { confirmationId: r.pending!.confirmationId } : {}),
  };
}

/** 출력 체인이 바꿔서는 안 되는 의미 토큰. 확인 질문은 대상·행위·버전을 반드시 포함한다. */
export function requiredMeaning(r: HarnessResult): string[] {
  const out: string[] = [];
  const scope = (r.facts['question'] as { scope?: ConfirmationScope } | undefined)?.scope;
  if (r.disposition === 'awaiting_user' && scope) {
    if (scope.target.kind === 'github_pr') out.push(`${scope.target.prNumber}`, short(scope.headSha), '승인');
    if (scope.target.kind === 'eureka_stage') out.push('완료');
  }
  return out;
}
