import { SNAPSHOT_SCOPE_ALL, type ConfirmationRecord, type OperationRecord, type OperationUpdated, type OutputContent, type OutputEvent, type Pending, type Snapshot, type Tombstone } from '@deskpet/contracts';

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

/**
 * Harness source 전체 스냅샷 (MVP: scope = source 전체).
 * 입력은 저장소의 readProjectionSnapshot()처럼 같은 시점에 함께 읽은 세 종류여야 한다.
 * 한 종류라도 빠지면 그 종류의 투영이 지워지므로 세 필드를 모두 요구한다.
 */
export interface HarnessSnapshotRecords {
  operations: OperationRecord[];
  pendings: Pending[];
  confirmations: ConfirmationRecord[];
}

export function snapshotFromHarness(r: HarnessSnapshotRecords, epoch: number, tombstones: Snapshot['tombstones'] = []): Snapshot {
  const state = (v: unknown) => v as Record<string, unknown>;
  return {
    source: 'harness',
    scope: SNAPSHOT_SCOPE_ALL,
    epoch,
    objectsWithRevisions: [
      ...r.operations.map((o) => ({ entityType: 'operation' as const, entityId: o.operationId, revision: o.revision, state: state(o) })),
      ...r.pendings.map((p) => ({ entityType: 'pending' as const, entityId: p.pendingId, revision: p.revision, state: state(p) })),
      ...r.confirmations.map((c) => ({ entityType: 'confirmation' as const, entityId: c.confirmationId, revision: c.revision, state: state(c) })),
    ],
    tombstones,
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
