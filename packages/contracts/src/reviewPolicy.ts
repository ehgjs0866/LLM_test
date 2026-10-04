import type { ChecksData, PrBasics } from './review.js';

/**
 * PR 승인 가능 조건 (순수 함수). Harness의 확인 질문 전 검사와 Gateway의 실행 직전 재검증이 같은 규칙을 쓴다.
 * 근거: Liability §Confirmation and Execution 1 — 필수 검사 실패·진행 중·판정 불가, SHA 변경, 권한·정책 미확인은 차단.
 *       "필수 검사가 없다고 확인한 경우와 설정을 조회하지 못한 경우를 구분한다."
 */
export type ViewerPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' | 'unknown';

export interface ApprovalCheckInput {
  pr?: PrBasics;
  checks?: ChecksData;
  expectedHeadSha: string;
  viewerLogin?: string;
  viewerPermission: ViewerPermission;
}

export function approvalBlockers(i: ApprovalCheckInput): string[] {
  const out: string[] = [];
  if (!i.pr) return ['pr_basics_unavailable'];
  if (i.pr.state !== 'open') out.push(`pr_${i.pr.state}`);
  if (i.pr.draft) out.push('pr_draft');
  if (i.pr.headSha !== i.expectedHeadSha) out.push('sha_changed');
  if (i.viewerPermission === 'unknown') out.push('permission_unverified');
  else if (!['admin', 'maintain', 'write'].includes(i.viewerPermission)) out.push('permission_insufficient');
  if (i.viewerLogin && i.viewerLogin === i.pr.author) out.push('cannot_approve_own_pr');
  if (!i.checks) {
    out.push('checks_unavailable');
    return out;
  }
  const req = i.checks.requiredChecks;
  if (req.state === 'unknown') out.push('required_checks_unverified');
  if (req.state === 'configured') {
    for (const name of req.names) {
      const run = i.checks.runs.find((r) => r.name === name);
      if (!run) out.push(`required_check_missing:${name}`);
      else if (run.headSha && run.headSha !== i.expectedHeadSha) out.push(`required_check_other_sha:${name}`);
      else if (run.status !== 'completed') out.push(`required_check_pending:${name}`);
      else if (!['success', 'skipped', 'neutral'].includes(run.conclusion ?? '')) out.push(`required_check_failed:${name}`);
    }
  }
  return out;
}
