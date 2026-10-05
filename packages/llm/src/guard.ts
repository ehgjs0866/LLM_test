import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '@deskpet/contracts';
import type { OutputModel, OutputModelInput } from '@deskpet/output';

/**
 * 비용·폭주 방지. 공급자와 무관하게 적용한다.
 * - 분당 호출 수 상한 (초과 시 호출하지 않고 budget_exceeded → 호출 측은 규칙/고정 문구로 진행)
 * - 응답 토큰 상한 (요청값을 이 값 이하로 낮춘다)
 * 구체 수치는 실측 후 조정한다 (Liability Principles 6).
 */
export interface LlmGuardOptions {
  maxCallsPerMinute: number;
  maxOutputTokens: number;
  now?: () => number;
}

/** 같은 창을 Guide 호출과 출력 호출이 함께 쓴다 */
export class CallWindow {
  private calls: number[] = [];
  private readonly now: () => number;
  constructor(
    private readonly maxPerMinute: number,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }
  take(): void {
    const t = this.now();
    this.calls = this.calls.filter((x) => t - x < 60_000);
    if (this.calls.length >= this.maxPerMinute) throw new LlmError('budget_exceeded', `more than ${this.maxPerMinute} LLM calls per minute`);
    this.calls.push(t);
  }
}

export class GuardedLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly window: CallWindow,
    private readonly maxOutputTokens: number,
  ) {}
  get provider() {
    return this.inner.provider;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.window.take();
    return this.inner.complete({ ...req, maxOutputTokens: Math.min(req.maxOutputTokens, this.maxOutputTokens) });
  }
}

export class GuardedOutputModel implements OutputModel {
  constructor(
    private readonly inner: OutputModel,
    private readonly window: CallWindow,
  ) {}
  generate(input: OutputModelInput) {
    this.window.take();
    return this.inner.generate(input);
  }
}
