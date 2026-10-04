import type { ActionStatus, SensorAssessment, SensorInput } from '@deskpet/contracts';

/**
 * 결정적 Sensor (guide-sensor §Sensor Interface). 외부를 재조회하지 않고 전달된 증거만 검사한다.
 * - MCP 성공 문구만 있고 review ID·상태·SHA·이번 제출과의 연결 근거가 없으면 confirmed_success로 승격하지 않는다.
 * - 기대한 변경 상태가 이미 존재해도 이번 쓰기 성공 증거가 부족하면 indeterminate.
 * - not_executed는 전송되지 않았음이 확실할 때만.
 */
export interface Sensor {
  inspect(input: SensorInput): SensorAssessment;
}

type Check = SensorAssessment['checks'][number];
type Verdict = SensorAssessment['verdict'];

export class DeterministicSensor implements Sensor {
  private n = 0;

  inspect(i: SensorInput): SensorAssessment {
    const g = i.gatewayResult;
    const base = {
      assessmentId: `asm-${++this.n}-${i.operationId}`,
      operationId: i.operationId,
      attemptId: i.attemptId,
      basedOnRevision: i.executionRevision,
      externalRefs: g.externalRefs,
      ...(g.consistency ? { consistency: g.consistency } : {}),
      ...(g.completeness ? { completeness: g.completeness } : {}),
    };
    const done = (verdict: Verdict, checks: Check[], opts: { status?: ActionStatus; follow?: SensorAssessment['followUpNeed']; facts?: Record<string, unknown>; diag?: string[] } = {}): SensorAssessment => ({
      ...base,
      verdict,
      checks,
      confirmedFacts: opts.facts ?? {},
      ...(opts.status ? { suggestedActionStatus: opts.status } : {}),
      followUpNeed: opts.follow ?? 'none',
      diagnostics: opts.diag ?? [],
    });

    // ------------------------------------------------ 전송 안 됨 (확실)
    if (g.dispatchState === 'not_sent') {
      if (!g.notSentProof && g.mode === 'write') {
        return done('indeterminate', [], { status: 'unknown', follow: 'reconcile', diag: ['not_sent without proof'] });
      }
      const cancelled = g.error?.provisionalCode === 'CANCELLED' || i.executionContext.cancelled;
      return done('not_executed', [], {
        status: cancelled ? 'cancelled' : 'failed',
        follow: g.error?.nextAction === 'user_input' ? 'user_input' : 'none',
        facts: g.response ?? {},
        diag: [g.notSentProof ?? 'not_sent', g.error?.message ?? ''],
      });
    }
    // ------------------------------------------------ 응답 없음
    if (g.outcome === 'no_response') {
      if (g.mode === 'read') return done('confirmed_failure', [], { status: 'failed', diag: ['read without response'] });
      return done('indeterminate', [{ rule: 'response_received', result: 'fail' }], { status: 'unknown', follow: 'reconcile', diag: ['response lost after possible dispatch'] });
    }
    // ------------------------------------------------ 명시적 오류
    if (g.outcome === 'error') {
      return done('confirmed_failure', [{ rule: 'explicit_error', result: 'fail', evidenceRef: g.error?.provisionalCode }], {
        status: 'failed',
        facts: { errorCode: g.error?.provisionalCode },
        diag: [g.error?.message ?? 'error'],
      });
    }

    const action = i.expectedOutcome.action;
    const r = g.response ?? {};
    switch (action) {
      case 'get_review_context':
      case 'list_tasks':
      case 'get_task_state':
        return done('confirmed_success', [{ rule: 'read_payload', result: 'pass' }], { status: 'succeeded', facts: r });

      case 'submit_approval':
      case 'get_approval_outcome': {
        const expectedSha = i.expectedOutcome.expectedVersion?.headSha;
        if (g.successTextOnly) {
          return done('indeterminate', [{ rule: 'approval.linked_to_this_submission', result: 'unknown' }], {
            status: 'unknown',
            follow: 'reconcile',
            diag: ['success text only; no review id/state/sha'],
          });
        }
        const ref = g.externalRefs.find((e) => e.system === 'github' && e.kind === 'pull_request_review');
        const prior = new Set((i.priorEvidence['priorReviewIds'] as string[] | undefined) ?? []);
        const state = (ref?.details?.['state'] as string | undefined) ?? (r['state'] as string | undefined);
        const commit = (ref?.details?.['commitId'] as string | undefined) ?? (r['commitId'] as string | undefined);
        const checks: Check[] = [
          { rule: 'approval.review_state_approved', result: state === undefined ? 'unknown' : state === 'APPROVED' ? 'pass' : 'fail' },
          { rule: 'approval.commit_matches_expected_sha', result: commit === undefined || !expectedSha ? 'unknown' : commit === expectedSha ? 'pass' : 'fail' },
          { rule: 'approval.linked_to_this_submission', result: ref && !prior.has(ref.id) ? 'pass' : 'unknown', ...(ref ? { evidenceRef: ref.id } : {}) },
        ];
        if (checks.every((c) => c.result === 'pass')) {
          return done('confirmed_success', checks, { status: 'succeeded', facts: { reviewId: ref!.id, state, commitId: commit } });
        }
        if (checks.some((c) => c.result === 'fail') && ref && !prior.has(ref.id)) {
          return done('confirmed_failure', checks, { status: 'failed', facts: { reviewId: ref.id, state, commitId: commit }, diag: ['submission evidence contradicts expected outcome'] });
        }
        // 현재 상태는 facts로 남기되 이번 operation은 판정 불가
        return done('indeterminate', checks, { status: 'unknown', follow: 'reconcile', facts: { linkage: r['linkage'], candidates: r['candidates'] } });
      }

      case 'complete_stage':
      case 'get_change_outcome': {
        const ref = g.externalRefs.find((e) => e.system === 'eureka' && e.kind === 'stage_status_change');
        const status = (r['status'] as string | undefined) ?? (r['currentStageStatus'] as string | undefined);
        const priorStatus = (i.priorEvidence['priorStageStatus'] as string | undefined) ?? (r['priorStageStatus'] as string | undefined);
        const checks: Check[] = [
          { rule: 'eureka.stage_status_done', result: status === undefined ? 'unknown' : status === 'done' ? 'pass' : 'fail' },
          {
            rule: 'eureka.linked_to_this_change',
            result: ref && priorStatus !== undefined && priorStatus !== 'done' && priorStatus !== 'skip' ? 'pass' : 'unknown',
            ...(ref ? { evidenceRef: ref.id } : {}),
          },
        ];
        if (checks.every((c) => c.result === 'pass')) {
          return done('confirmed_success', checks, { status: 'succeeded', facts: { stageStatus: status, completedAt: r['completedAt'], warnings: r['warnings'] } });
        }
        if (ref && checks[0]!.result === 'fail') {
          return done('confirmed_failure', checks, { status: 'failed', facts: { stageStatus: status } });
        }
        return done('indeterminate', checks, { status: 'unknown', follow: 'reconcile', facts: { currentStageStatus: status, linkage: r['linkage'] } });
      }

      default:
        return done('indeterminate', [], { status: 'unknown', follow: 'reconcile', diag: [`no rule for ${action}`] });
    }
  }
}
