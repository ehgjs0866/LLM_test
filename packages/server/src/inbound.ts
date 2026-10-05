import type { Envelope, HarnessResult } from '@deskpet/contracts';
import type { HarnessService } from '@deskpet/harness';
import { OutputService, mapHarnessResult } from '@deskpet/output';

/**
 * 수신 변환 층: Envelope → HarnessService·OutputService 호출.
 * 지금은 현재 Harness 입력을 그대로 전달한다. 파이프라인 형식이 정해지면 여기서 변환한다 (서버·Harness는 그대로).
 * 전송(WebSocket)과 분리되어 있어 gRPC 등 다른 transport에서도 그대로 쓸 수 있다.
 */
export interface InboundReply {
  kind: string;
  payload: unknown;
}

export interface HarnessInbound {
  readonly kinds: ReadonlySet<string>;
  dispatch(env: Envelope): Promise<InboundReply>;
}

export class DirectHarnessInbound implements HarnessInbound {
  readonly kinds: ReadonlySet<string> = new Set(['harness.request', 'harness.resume', 'pipeline.event', 'harness.cancel', 'output.from_result', 'output.request']);

  constructor(private readonly d: { harness: HarnessService; output: OutputService }) {}

  async dispatch(env: Envelope): Promise<InboundReply> {
    switch (env.kind) {
      case 'harness.request':
        return { kind: 'harness.result', payload: await this.d.harness.handle(env.payload as Envelope<'harness.request'>['payload']) };
      case 'harness.resume':
        return { kind: 'harness.result', payload: await this.d.harness.resume(env.payload as Envelope<'harness.resume'>['payload']) };
      case 'pipeline.event':
        return { kind: 'pipeline.event.result', payload: await this.d.harness.onPipelineEvent(env.payload as Envelope<'pipeline.event'>['payload']) };
      case 'harness.cancel':
        return { kind: 'harness.cancel.result', payload: await this.d.harness.cancel(env.payload as Envelope<'harness.cancel'>['payload']) };
      case 'output.from_result':
        return { kind: 'output.content', payload: await this.d.output.generate(mapHarnessResult(env.payload as HarnessResult)) };
      case 'output.request':
        return { kind: 'output.content', payload: await this.d.output.generate(env.payload as Envelope<'output.request'>['payload']) };
      default:
        throw new UnsupportedKindError(env.kind);
    }
  }
}

export class UnsupportedKindError extends Error {
  constructor(readonly kind: string) {
    super(`kind ${kind} is not accepted by this server`);
  }
}
