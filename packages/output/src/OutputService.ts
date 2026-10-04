import { OutputRequest as OutputRequestSchema, type Emotion, type OutputContent, type OutputRequest } from '@deskpet/contracts';
import { fallbackText } from './fallback.js';
import { formatKoreanDateTime } from './format.js';

/**
 * «port» OutputModel — LangChain 출력 모델 의존 (다이어그램). MVP는 mock.
 * 모델은 문장·표정 제안만 한다. 업무 status·사실 식별자는 일반 코드가 복사하며 모델이 수정하지 않는다.
 */
export interface OutputModel {
  generate(prompt: string, facts: Record<string, unknown>, constraints: { maxChars: number; deadlineMs: number }): Promise<{ text: string; displayText?: string; emotion?: string }>;
}

export interface OutputServiceOptions {
  model?: OutputModel;
  /** interface-contracts §7 제안 timeout 5초 */
  modelTimeoutMs?: number;
}

/** 성공을 확인하지 못한 작업에 쓰면 안 되는 완료 표현 */
const SUCCESS_PHRASES: Record<string, RegExp> = {
  submit_approval: /승인(했|을 완료|이 완료)/,
  complete_stage: /(반영했|완료(로|됐|했))/,
};

export class OutputService {
  constructor(private readonly o: OutputServiceOptions = {}) {}

  async generate(raw: OutputRequest): Promise<OutputContent> {
    const req = OutputRequestSchema.parse(raw);
    const statuses = req.actionResults.map((a) => ({ operationId: a.operationId, status: a.status }));
    const fb = this.fallback(req.facts, req);
    if (this.o.model) {
      try {
        const draft = await withTimeout(
          this.o.model.generate(buildPrompt(req), req.facts, { maxChars: req.constraints.maxSpeechChars, deadlineMs: this.o.modelTimeoutMs ?? 5_000 }),
          this.o.modelTimeoutMs ?? 5_000,
        );
        const emotion = req.constraints.allowedEmotions.includes(draft.emotion as Emotion) ? (draft.emotion as Emotion) : fb.emotion;
        const failures = this.validate({ text: draft.text, displayText: draft.displayText ?? fb.displayText }, req);
        if (failures.length === 0) {
          return { outputId: req.outputId, text: draft.text, displayText: draft.displayText ?? fb.displayText, emotion, actionStatuses: statuses, validationResult: { passed: true, failures: [] }, fallbackUsed: false };
        }
        return { ...fb, actionStatuses: statuses, validationResult: { passed: false, failures }, fallbackUsed: true };
      } catch (e) {
        return { ...fb, actionStatuses: statuses, validationResult: { passed: false, failures: [`model_error:${e instanceof Error ? e.message : 'unknown'}`] }, fallbackUsed: true };
      }
    }
    return { ...fb, actionStatuses: statuses, validationResult: { passed: true, failures: [] }, fallbackUsed: true };
  }

  /** 필수 의미 보존·상태 왜곡 금지·리마인더 일시 포함·길이 검사 */
  validate(content: { text: string; displayText: string }, req: OutputRequest): string[] {
    const f: string[] = [];
    const text = content.text.trim();
    if (!text) f.push('empty_text');
    if (text.length > req.constraints.maxSpeechChars) f.push('too_long');
    for (const token of req.requiredMeaning) if (!text.includes(token)) f.push(`missing_required:${token}`);
    for (const a of req.actionResults) {
      const re = SUCCESS_PHRASES[a.action];
      if (re && a.status !== 'succeeded' && re.test(text)) f.push(`success_claim_without_success:${a.action}`);
    }
    if (req.purpose === 'reminder' && req.reminder) {
      const due = formatKoreanDateTime(req.reminder.dueAt, req.reminder.timezone);
      if (!text.includes(due)) f.push('reminder_due_missing');
      if (!text.includes(req.reminder.description.replace(/[.。]$/, '').slice(0, 8))) f.push('reminder_description_missing');
    }
    return f;
  }

  fallback(_facts: Record<string, unknown>, req: OutputRequest): Omit<OutputContent, 'actionStatuses' | 'validationResult' | 'fallbackUsed'> {
    const fb = fallbackText(req);
    return { outputId: req.outputId, text: fb.text, displayText: fb.displayText, emotion: req.constraints.allowedEmotions.includes(fb.emotion) ? fb.emotion : 'neutral' };
  }
}

function buildPrompt(req: OutputRequest): string {
  // 외부 결과 원문 전체를 넣지 않는다. 구조화된 사실·필수 의미·상태만 전달한다
  return [
    `purpose=${req.purpose}`,
    `required=${req.requiredMeaning.join('|')}`,
    `statuses=${req.actionResults.map((a) => `${a.action}:${a.status}`).join(',')}`,
    'Rules: 사실을 바꾸지 말 것. 확인된 성공에만 완료 표현. 한국어 존댓말.',
  ].join('\n');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
