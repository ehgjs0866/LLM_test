import { describe, expect, it } from 'vitest';
import type { HarnessResult, OutputRequest } from '@deskpet/contracts';
import { OutputService, formatKoreanDateTime, mapHarnessResult, type OutputModel } from '@deskpet/output';
import { PR, REPO, SHA_A, T0 } from '../../../tests/support/builders.js';

const prTarget = { kind: 'github_pr' as const, repository: { ...REPO }, prNumber: PR };

const approvalQuestion: HarnessResult = {
  requestId: 'req-1',
  disposition: 'awaiting_user',
  actionResults: [],
  pending: {
    pendingId: 'p-1',
    revision: 0,
    kind: 'confirmation',
    purpose: 'confirm_pr_approval',
    requiredSlots: [],
    scope: { action: 'submit_approval', target: prTarget, headSha: SHA_A },
    confirmationId: 'c-1',
    outputId: 'out-q',
    expiresAt: T0,
  },
  facts: { question: { purpose: 'confirm_pr_approval', kind: 'confirmation', scope: { action: 'submit_approval', target: prTarget, headSha: SHA_A } } },
  sources: [],
  processingErrors: [],
};

const unknownApproval: HarnessResult = {
  requestId: 'req-1',
  disposition: 'completed',
  actionResults: [
    {
      operationId: 'op-1',
      action: 'submit_approval',
      target: prTarget,
      status: 'unknown',
      dispatchState: 'may_have_been_sent',
      facts: {},
      externalRefs: [],
      observedAt: T0,
      error: { stage: 'github.write', provisionalCode: 'GITHUB_RESULT_UNKNOWN', message: 'timeout', nextAction: 'reconcile' },
    },
  ],
  facts: {},
  sources: [],
  processingErrors: [],
};

const model = (text: string, emotion = 'cheerful'): OutputModel => ({ generate: async () => ({ text, emotion }) });

describe('HarnessOutputMapper', () => {
  it('question uses the pending outputId and requires target/action/version meaning', () => {
    const req = mapHarnessResult(approvalQuestion);
    expect(req).toMatchObject({ outputId: 'out-q', purpose: 'question', pendingId: 'p-1', confirmationId: 'c-1' });
    expect(req.requiredMeaning).toEqual(['42', SHA_A.slice(0, 7), '승인']);
  });
});

describe('OutputService', () => {
  it('fallback confirmation question includes repo, PR, SHA and action (golden-scenario 4)', async () => {
    const c = await new OutputService().generate(mapHarnessResult(approvalQuestion));
    expect(c.text).toBe(`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요?`);
    expect(c.fallbackUsed).toBe(true);
  });

  it('rejects model output that drops required meaning and falls back', async () => {
    const c = await new OutputService({ model: model('승인할까요?') }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures).toContain('missing_required:42');
  });

  it('rejects model success claims for unknown results; status is copied by code (S-07)', async () => {
    const c = await new OutputService({ model: model('PR 42번을 승인했어요!') }).generate(mapHarnessResult(unknownApproval));
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures).toContain('success_claim_without_success:submit_approval');
    expect(c.text).toContain('결과를 확인하지 못했어요');
    expect(c.actionStatuses).toEqual([{ operationId: 'op-1', status: 'unknown' }]);
  });

  it('accepts a valid model sentence and constrains emotion to the allowed set', async () => {
    const c = await new OutputService({ model: model(`PR 42번 ${SHA_A.slice(0, 7)} 커밋을 승인할까요?`, 'ecstatic') }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(false);
    expect(c.emotion).toBe('thinking');
  });

  it('model failure → fixed phrase', async () => {
    const failing: OutputModel = { generate: async () => Promise.reject(new Error('gpu busy')) };
    const c = await new OutputService({ model: failing }).generate(mapHarnessResult(unknownApproval));
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures[0]).toMatch(/model_error/);
  });

  it('reminder keeps description and exact due date/time with timezone', async () => {
    const req: OutputRequest = {
      outputId: 'out-r',
      requestRefs: { requestId: 'sys-1', operationIds: [] },
      purpose: 'reminder',
      actionResults: [],
      facts: {},
      sources: [],
      requiredMeaning: [],
      constraints: { language: 'ko-KR', maxSpeechChars: 200, allowedEmotions: ['neutral'] },
      reminder: { description: '실험 결과를 비교하고 분석 보고서를 제출한다.', dueAt: '2026-09-28T23:59:00+09:00', timezone: 'Asia/Seoul', relatedIds: { itemId: 'i', reminderKey: 'k' } },
    };
    expect(formatKoreanDateTime(req.reminder!.dueAt, 'Asia/Seoul')).toBe('2026년 9월 28일 밤 11시 59분');
    const c = await new OutputService({ model: model('곧 마감이에요. 3시간 남았어요.') }).generate(req);
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures).toContain('reminder_due_missing');
    expect(c.text).toContain('2026년 9월 28일 밤 11시 59분');
  });
});
