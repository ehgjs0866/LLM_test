import { OutputRequest as OutputRequestSchema, type Emotion, type OutputContent, type OutputRequest } from '@deskpet/contracts';
import { fallbackText } from './fallback.js';
import { formatKoreanDateTime } from './format.js';
import { OUTPUT_INSTRUCTIONS, buildOutputPrompt } from './prompt.js';

/**
 * «port» OutputModel — 출력 체인 모델 (기술 스택: LangChain). 어댑터는 @deskpet/llm.
 * 모델은 문장·표정 제안만 한다. 업무 status·사실 식별자는 일반 코드가 복사하며 모델이 수정하지 않는다.
 */
export interface OutputModelInput {
  instructions: string;
  /** 기준 문장·필수 토큰·상태만 담은 입력 (prompt.ts) */
  prompt: string;
  maxChars: number;
  allowedEmotions: string[];
  deadlineMs: number;
}

export interface OutputModel {
  generate(input: OutputModelInput): Promise<{ text: string; displayText?: string; emotion?: string }>;
}

export interface OutputServiceOptions {
  model?: OutputModel;
  /** interface-contracts §7 제안 timeout 5초 */
  modelTimeoutMs?: number;
}

/** 성공을 확인하지 못한 작업에 쓰면 안 되는 완료 표현 */
const SUCCESS_PHRASES: Record<string, RegExp> = {
  // 화면용 짧은 표현("승인 완료", "승인 성공")도 함께 막는다
  submit_approval: /승인(했|됐|됨|을 완료|이 완료|\s*완료|\s*성공)/,
  complete_stage: /(반영(했|됐|됨|\s*완료|\s*성공)|완료(로|됐|했|\s*처리))/,
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
          this.o.model.generate({
            instructions: OUTPUT_INSTRUCTIONS,
            prompt: buildOutputPrompt(req, fb),
            maxChars: req.constraints.maxSpeechChars,
            allowedEmotions: req.constraints.allowedEmotions,
            deadlineMs: this.o.modelTimeoutMs ?? 5_000,
          }),
          this.o.modelTimeoutMs ?? 5_000,
        );
        const emotion = req.constraints.allowedEmotions.includes(draft.emotion as Emotion) ? (draft.emotion as Emotion) : fb.emotion;
        // 모델이 화면 문장을 냈으면 그것도 같은 기준으로 검사한다. 내지 않았으면 고정 화면 문장을 쓴다
        const failures = this.validate({ text: draft.text, ...(draft.displayText !== undefined ? { displayText: draft.displayText } : {}) }, req);
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

  /**
   * 필수 의미 보존·상태 왜곡 금지·리마인더 일시 포함·길이 검사.
   * 음성(text)과 화면(displayText)에 같은 기준을 적용한다. 화면 실패는 `display:` 접두사로 구분한다.
   * displayText가 없으면 고정 화면 문장을 쓰므로 검사하지 않는다.
   */
  validate(content: { text: string; displayText?: string }, req: OutputRequest): string[] {
    const f = checkSurface(content.text, req);
    if (content.displayText !== undefined) f.push(...checkSurface(content.displayText, req).map((x) => `display:${x}`));
    return f;
  }

  fallback(_facts: Record<string, unknown>, req: OutputRequest): Omit<OutputContent, 'actionStatuses' | 'validationResult' | 'fallbackUsed'> {
    const fb = fallbackText(req);
    return { outputId: req.outputId, text: fb.text, displayText: fb.displayText, emotion: req.constraints.allowedEmotions.includes(fb.emotion) ? fb.emotion : 'neutral' };
  }
}

function checkSurface(raw: string, req: OutputRequest): string[] {
  const f: string[] = [];
  const text = raw.trim();
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


function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
