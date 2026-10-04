import type { CurrentTurnInput } from '@deskpet/contracts';
import type { PolicyConfig } from './config.js';

/**
 * 쓰기 승인 입력 검사 — 일반 코드가 한다 (Liability §Principles 1).
 * 근거: message-contracts §Harness Boundary — voice는 final만 수락, unavailable을 높은 신뢰도로 간주하지 않음,
 *       web의 not_applicable과 구분, RouteDecision confidence로 STT confidence를 대체하지 않음.
 *       README C-05: STT와 라우터 신뢰도를 독립적으로 검사한다.
 */
export function writeInputBlockers(turn: CurrentTurnInput, cfg: PolicyConfig): string[] {
  const out: string[] = [];
  if (!turn.isFinal) out.push('turn_not_final');
  if (turn.inputChannel === 'voice') {
    if (turn.sttConfidenceState === 'unavailable') out.push('stt_confidence_unavailable');
    else if (turn.sttConfidenceState === 'provided' && (turn.sttConfidence ?? 0) < cfg.minSttConfidenceForWrite) out.push('stt_confidence_low');
    else if (turn.sttConfidenceState === 'not_applicable') out.push('stt_state_invalid_for_voice');
  }
  // web 입력의 채널 인증 방식은 미정 (message-contracts) — 여기서는 not_applicable만 허용
  if (turn.inputChannel === 'web' && turn.sttConfidenceState !== 'not_applicable') out.push('stt_state_invalid_for_web');
  if (turn.routeDecision.overallConfidence < cfg.minRouteConfidenceForWrite) out.push('route_confidence_low');
  return out;
}

export type AnswerVerdict = 'approved' | 'rejected' | 'unclear';

const REJECT = /(아니|안\s*돼|취소|보류|하지\s*마|싫어|그만|nope|\bno\b|cancel)/i;
const APPROVE = /(^|\s)(응|네|예|그래|좋아|맞아|ㅇㅇ|승인|완료해|진행해|yes|ok|okay)/i;

/**
 * 확인 답변 해석 (규칙 기반, inference). 라우터 intention이 명시적이면 우선한다.
 * 모호하면 unclear — 승인으로 해석하지 않는다. 거절 신호가 있으면 거절이 우선한다.
 */
export function classifyAnswer(turn: CurrentTurnInput, cfg: PolicyConfig): { verdict: AnswerVerdict; rationale: string } {
  const blockers = writeInputBlockers(turn, cfg);
  if (blockers.length > 0) return { verdict: 'unclear', rationale: `input not acceptable for approval: ${blockers.join(',')}` };
  const intention = turn.routeDecision.headOutputs['intention']?.value;
  if (intention === 'confirm.reject') return { verdict: 'rejected', rationale: 'router intention confirm.reject' };
  const text = turn.rawText.trim();
  if (REJECT.test(text)) return { verdict: 'rejected', rationale: 'reject keyword' };
  if (intention === 'confirm.approve') return { verdict: 'approved', rationale: 'router intention confirm.approve' };
  if (APPROVE.test(text)) return { verdict: 'approved', rationale: 'approve keyword' };
  return { verdict: 'unclear', rationale: 'no explicit approval or rejection' };
}
