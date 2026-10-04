import type { OperationRecord, OperationUpdated, OutputContent, OutputEvent, Snapshot, Tombstone } from '@deskpet/contracts';

/**
 * 원본 → 투영 이벤트 변환 헬퍼.
 * Harness 저장소 변경(StoreChange 모양)과 파이프라인 출력 이벤트를 OperationUpdated/Tombstone으로 바꾼다.
 */
export interface StoreChangeLike {
  entityType: 'operation' | 'pending' | 'confirmation';
  entityId: string;
  revision: number;
  state: Record<string, unknown>;
  deleted?: boolean;
}

export function fromStoreChange(c: StoreChangeLike, epoch: number): OperationUpdated | Tombstone {
  if (c.deleted) return { kind: 'tombstone', source: 'harness', epoch, entityId: c.entityId, revision: c.revision };
  const related: Record<string, string> = {};
  if (typeof c.state['requestId'] === 'string') related['requestId'] = c.state['requestId'];
  return { kind: 'operation.updated', source: 'harness', epoch, entityType: c.entityType, entityId: c.entityId, revision: c.revision, currentState: c.state, relatedIds: related };
}

export function snapshotFromOperations(ops: OperationRecord[], epoch: number, scope = 'operations'): Snapshot {
  return {
    source: 'harness',
    scope,
    epoch,
    objectsWithRevisions: ops.map((o) => ({ entityType: 'operation', entityId: o.operationId, revision: o.revision, state: o as unknown as Record<string, unknown> })),
    tombstones: [],
  };
}

/**
 * 출력 채널 상태 누적 (파이프라인 원본). 출력 실패는 업무 결과와 독립적으로 표시한다.
 * inference: 파이프라인이 outputId별 revision을 부여한다고 가정한다.
 */
export class OutputProjectionFeed {
  private states = new Map<string, { revision: number; requestId: string; text: string | null; channels: Record<string, string> }>();
  constructor(private readonly epoch = 1) {}

  toUpdate(e: OutputEvent): OperationUpdated {
    const cur = this.states.get(e.outputId) ?? { revision: 0, requestId: e.requestRefs.requestId, text: null, channels: {} };
    const next = { ...cur, channels: { ...cur.channels }, revision: cur.revision + 1 };
    if (e.kind === 'content_ready') next.text = (e.content as OutputContent).text;
    if (e.kind === 'content_failed') next.channels['content'] = 'failed';
    if (e.kind === 'channel_started' || e.kind === 'channel_completed' || e.kind === 'channel_failed') {
      next.channels[e.channel] = e.kind.replace('channel_', '');
    }
    this.states.set(e.outputId, next);
    return {
      kind: 'operation.updated',
      source: 'pipeline',
      epoch: this.epoch,
      entityType: 'output',
      entityId: e.outputId,
      revision: next.revision,
      currentState: { requestId: next.requestId, text: next.text, channels: next.channels },
      relatedIds: { requestId: next.requestId },
    };
  }
}
