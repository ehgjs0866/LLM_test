import type { ActionResult, ConfirmationScope, Emotion, OutputRequest } from '@deskpet/contracts';
import { formatKoreanDateTime, short } from './format.js';

/**
 * 고정 문구 fallback. 모델 실패·검증 실패 시 사용한다 (interface-contracts I-13).
 * 문구는 golden-scenario의 출력 예시를 따른다. 확인된 성공에만 완료 표현을 쓴다.
 */
interface ReviewFactsLike {
  prNumber: number;
  repository: string;
  headSha?: string;
  consistency?: string;
  changes?: { fileCount: number; additions: number; deletions: number };
  checks?: { requiredState: string; failing: string[]; pending: string[] };
  copilot?: { status: string; comments: unknown[]; blockingComments: number };
}

export function fallbackText(req: OutputRequest): { text: string; displayText: string; emotion: Emotion } {
  const f = req.facts;
  if (req.purpose === 'reminder' && req.reminder) {
    const due = formatKoreanDateTime(req.reminder.dueAt, req.reminder.timezone);
    const desc = req.reminder.description.replace(/[.。]$/, '');
    return { text: `${desc}. 마감은 ${due}이에요.`, displayText: `${desc} · 마감 ${due}`, emotion: 'neutral' };
  }

  const parts: string[] = [];
  const display: string[] = [];
  let emotion: Emotion = 'neutral';

  const review = f['review'] as ReviewFactsLike | undefined;
  const approval = req.actionResults.find((a) => a.action === 'submit_approval');
  const stage = req.actionResults.find((a) => a.action === 'complete_stage');
  const blocked = f['blocked'] as { reasons: string[]; intent?: string } | undefined;
  const question = f['question'] as { purpose: string; scope?: ConfirmationScope; target?: { kind: string; prNumber?: number } } | undefined;

  if (f['processingErrors'] && (f['processingErrors'] as string[]).length > 0 && f['disposition'] === 'failed') {
    parts.push('요청을 처리하지 못했어요. 외부 작업은 실행하지 않았어요.');
    display.push('처리 실패 · 외부 변경 없음');
    emotion = 'apologetic';
  }

  // ---------------------------------------------------------------- 리뷰 요약
  if (review && !blocked && !approval && review.changes) {
    parts.push(reviewSentence(review));
    display.push(`PR ${review.prNumber} @${short(review.headSha)}`);
  } else if (f['reviewError'] && !approval) {
    const auth = String(f['reviewError']).includes('AUTH');
    parts.push(auth ? 'GitHub 권한 문제로 PR을 확인하지 못했어요. PR과 Eureka 상태는 변경되지 않았어요.' : 'PR 정보를 가져오지 못했어요. 잠시 후 다시 확인할게요.');
    display.push('PR 조회 실패');
    emotion = 'apologetic';
  }

  // ---------------------------------------------------------------- 차단
  if (blocked && !f['reviewError']) {
    parts.push(blockedSentence(blocked.reasons, review?.prNumber));
    display.push(`차단: ${blocked.reasons.join(', ')}`);
    emotion = 'concerned';
  }

  // ---------------------------------------------------------------- 승인 결과
  if (approval) {
    const t = approval.target.kind === 'github_pr' ? approval.target.prNumber : '';
    if (approval.status === 'succeeded') {
      parts.push(`PR ${t}번을 승인했어요.`);
      display.push(`GitHub 승인 성공 (review ${approval.externalRefs[0]?.id ?? '-'})`);
      emotion = 'cheerful';
    } else {
      parts.push(approvalFailure(approval, t));
      display.push(`GitHub 승인 ${statusKo(approval.status)}`);
      emotion = approval.status === 'unknown' ? 'concerned' : 'apologetic';
    }
    const fu = f['followUp'] as { eligibility: string; conditions?: string[] } | undefined;
    if (approval.status === 'succeeded' && fu && fu.eligibility !== 'eligible' && fu.eligibility !== 'not_applicable') {
      parts.push(`Eureka 반영은 보류했어요${fu.conditions?.includes('sha_changed_since_approval') ? '. 승인 뒤 새 커밋이 추가됐어요' : ''}.`);
      display.push(`Eureka 보류 (${fu.conditions?.join(', ') ?? fu.eligibility})`);
    }
  }

  // ---------------------------------------------------------------- Eureka 결과
  if (stage) {
    const name = (f['stageCompletion'] as { stageName?: string } | undefined)?.stageName ?? '해당';
    if (stage.status === 'succeeded') {
      parts.push(`Eureka의 '${name}' 단계를 완료로 반영했어요.`);
      display.push('Eureka 반영 성공');
      emotion = 'cheerful';
    } else if (stage.status === 'unknown') {
      parts.push(`Eureka 반영 결과를 아직 확인하지 못했어요. 다시 실행하지 않고 상태를 확인할게요.`);
      display.push('Eureka 반영 결과 미확인');
      emotion = 'concerned';
    } else {
      parts.push(`Eureka 반영은 하지 못했어요. GitHub 승인은 그대로 유지돼요.`);
      display.push(`Eureka 반영 ${statusKo(stage.status)}`);
      emotion = 'apologetic';
    }
  }

  // ---------------------------------------------------------------- 거절·답변
  if (f['declined']) {
    const d = f['declined'] as { action: string };
    parts.push(d.action === 'submit_approval' ? '승인을 취소했어요. PR과 Eureka 상태는 바꾸지 않았어요.' : 'Eureka 반영을 하지 않았어요. GitHub 승인은 그대로 유지돼요.');
    display.push('요청 취소 · 변경 없음');
  }
  if (f['unclearAnswer']) parts.push('답변을 정확히 듣지 못했어요.');
  if (f['answerNotAccepted'] && !question) {
    parts.push('확인 질문이 만료됐거나 이미 처리됐어요. 아무것도 실행하지 않았어요.');
    display.push('확인 만료/처리됨 · 실행 없음');
  }

  // ---------------------------------------------------------------- 질문
  if (req.purpose === 'question' && question) {
    parts.push(questionSentence(question, review?.prNumber ?? question.target?.prNumber));
    display.push('답변 대기');
    if (emotion === 'neutral') emotion = 'thinking';
  }

  if (parts.length === 0) parts.push('요청을 처리했어요.');
  return { text: parts.join(' '), displayText: display.join(' / ') || parts[0]!, emotion };
}

function reviewSentence(r: ReviewFactsLike): string {
  const s: string[] = [`PR ${r.prNumber}번, 현재 커밋 ${short(r.headSha)} 기준이에요.`];
  if (r.changes) s.push(`파일 ${r.changes.fileCount}개가 바뀌었고 ${r.changes.additions}줄 추가, ${r.changes.deletions}줄 삭제예요.`);
  if (r.checks) {
    if (r.checks.requiredState === 'unknown') s.push('필수 검사 설정은 확인하지 못했어요.');
    else if (r.checks.failing.length) s.push(`실패한 검사가 있어요: ${r.checks.failing.join(', ')}.`);
    else if (r.checks.pending.length) s.push(`아직 진행 중인 검사가 있어요: ${r.checks.pending.join(', ')}.`);
    else s.push('모든 검사가 통과했어요.');
  }
  if (r.copilot) {
    if (r.copilot.status === 'current') {
      s.push(r.copilot.comments.length === 0 ? 'Copilot 지적은 없어요.' : `Copilot 지적 ${r.copilot.comments.length}건이 있고 차단 수준은 ${r.copilot.blockingComments}건이에요.`);
    } else if (r.copilot.status === 'stale_only') s.push('현재 커밋에 대한 Copilot 리뷰는 아직 없어요. 이전 커밋 리뷰만 있어요.');
    else if (r.copilot.status === 'none') s.push('Copilot 리뷰는 없어요.');
    else s.push('리뷰 목록은 확인하지 못했어요.');
  }
  if (r.consistency === 'changed') s.push('확인하는 동안 새 커밋이 추가돼서 일부 자료는 이전 버전 기준이에요.');
  return s.join(' ');
}

function blockedSentence(reasons: string[], pr?: number): string {
  const n = pr ? `PR ${pr}번은 ` : '';
  if (reasons.includes('sha_changed')) return '리뷰를 들은 뒤 새 커밋이 추가됐어요. 변경 내용을 다시 확인한 후 승인해야 해요.';
  if (reasons.includes('pr_merged')) return `${n}이미 병합되어 승인할 수 없어요.`;
  if (reasons.includes('pr_closed')) return `${n}닫혀 있어 승인할 수 없어요.`;
  if (reasons.includes('pr_draft')) return `${n}초안 상태라 승인할 수 없어요.`;
  if (reasons.some((r) => r.startsWith('required_check_failed'))) return '필수 검사가 실패해서 승인하지 않았어요.';
  if (reasons.some((r) => r.startsWith('required_check_pending'))) return '필수 검사가 아직 진행 중이라 승인하지 않았어요.';
  if (reasons.includes('required_checks_unverified')) return '필수 검사 설정을 확인할 수 없어서 승인하지 않았어요.';
  if (reasons.some((r) => r.startsWith('permission'))) return '승인 권한을 확인할 수 없어서 승인하지 않았어요.';
  if (reasons.some((r) => r.startsWith('unsupported_intent'))) return '그 요청은 아직 처리할 수 없어요.';
  return `조건이 맞지 않아 실행하지 않았어요 (${reasons.join(', ')}).`;
}

function questionSentence(q: { purpose: string; scope?: ConfirmationScope }, pr?: number): string {
  switch (q.purpose) {
    case 'identify_pr':
      return '어느 저장소의 몇 번 PR을 확인할까요?';
    case 'select_pr_candidate':
      return '후보 PR이 여러 개예요. 어느 PR부터 볼까요?';
    case 'restate_write_command':
      return `승인 명령을 정확히 듣지 못했어요. ${pr ? `PR ${pr}번을 승인하려면 '${pr}번 승인해'라고` : '대상과 함께'} 다시 말해 주세요.`;
    case 'confirm_pr_approval': {
      const s = q.scope!;
      const t = s.target.kind === 'github_pr' ? s.target : undefined;
      return `${t?.repository.owner}/${t?.repository.name} PR ${t?.prNumber}번, 현재 커밋 ${short(s.headSha)}을 승인할까요?`;
    }
    case 'confirm_stage_completion': {
      const name = (q.scope?.exactChange?.['stageName'] as string | undefined) ?? '해당';
      return `Eureka의 '${name}' 단계를 완료로 반영할까요?`;
    }
    default:
      return '어떻게 할까요?';
  }
}

function approvalFailure(a: ActionResult, pr: number | string): string {
  if (a.status === 'unknown') return '승인 요청의 결과를 확인하지 못했어요. 중복 승인을 막기 위해 다시 실행하지 않았고, Eureka도 아직 완료 처리하지 않았어요.';
  if (a.error?.provisionalCode === 'GITHUB_AUTH_ERROR') return 'GitHub 권한 문제로 승인하지 못했어요. PR과 Eureka 상태는 변경되지 않았어요.';
  if (a.error?.provisionalCode === 'SHA_CHANGED') return '리뷰를 들은 뒤 새 커밋이 추가됐어요. 변경 내용을 다시 확인한 후 승인해야 해요.';
  if (a.status === 'cancelled') return `PR ${pr}번 승인을 취소했어요. 외부 변경은 없어요.`;
  return `PR ${pr}번을 승인하지 못했어요. Eureka 상태는 변경되지 않았어요.`;
}

function statusKo(s: ActionResult['status']): string {
  return { succeeded: '성공', failed: '실패', unknown: '결과 미확인', cancelled: '취소' }[s];
}
