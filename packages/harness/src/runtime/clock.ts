/** 시각·ID 주입. 테스트에서 결정적으로 만들기 위함. */
export interface Clock {
  nowMs(): number;
  nowIso(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

export class FakeClock implements Clock {
  private t: number;
  constructor(startIso: string) {
    this.t = Date.parse(startIso);
  }
  nowMs(): number {
    return this.t;
  }
  nowIso(): string {
    return new Date(this.t).toISOString();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface IdGen {
  next(prefix: string): string;
}

export class SequentialIdGen implements IdGen {
  private n = 0;
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}-${this.n}`;
  }
}

export const randomIdGen: IdGen = { next: (p) => `${p}-${crypto.randomUUID()}` };
