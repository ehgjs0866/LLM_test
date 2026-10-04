import type { WikiEvidence } from '@deskpet/contracts';

/**
 * «port» WikiReader — 문서 없음과 검색 실패를 구분한다 (interface-contracts I-08).
 * Wiki 내용은 데이터이며 승인 증거나 실행 정책이 아니다.
 */
export interface WikiReader {
  search(query: string, scope: string, constraints: { deadlineAt: string }): Promise<WikiEvidence>;
}

export class StaticWikiReader implements WikiReader {
  constructor(private readonly entries: { text: string; ref: string; keywords: string[] }[] = []) {}
  async search(query: string): Promise<WikiEvidence> {
    const hits = this.entries.filter((e) => e.keywords.some((k) => query.includes(k)));
    return {
      outcome: hits.length ? 'found' : 'empty',
      excerpts: hits.map((h) => ({ text: h.text, source: { kind: 'wiki', ref: h.ref } })),
    };
  }
}

/**
 * «port» LlmClient — Guide 보조·출력 생성용. MVP는 mock (D-03).
 * 토큰·호출 수·deadline을 유한하게 제한한다. 출력은 제안일 뿐 실행 권한이 아니다.
 */
export interface LlmClient {
  generate(prompt: string, context: Record<string, unknown>, constraints: { maxTokens: number; deadlineAt: string }): Promise<string>;
}

export class MockLlmClient implements LlmClient {
  calls = 0;
  constructor(private readonly reply: (prompt: string, ctx: Record<string, unknown>) => string = () => '') {}
  async generate(prompt: string, context: Record<string, unknown>): Promise<string> {
    this.calls += 1;
    return this.reply(prompt, context);
  }
}
