import { describe, expect, it } from 'vitest';
import type { OperationUpdated } from '@deskpet/contracts';
import { OutputProjectionFeed, RequestStateProjector } from '@deskpet/projector';

const upd = (id: string, revision: number, state: Record<string, unknown> = {}, epoch = 1): OperationUpdated => ({
  kind: 'operation.updated',
  source: 'harness',
  epoch,
  entityType: 'operation',
  entityId: id,
  revision,
  currentState: { requestId: 'req-1', action: 'submit_approval', ...state },
  relatedIds: {},
});

describe('RequestStateProjector', () => {
  it('drops duplicates and out-of-order revisions', () => {
    const p = new RequestStateProjector();
    expect(p.apply(upd('op-1', 2, { executionPhase: 'dispatching' }))).toBe('applied');
    expect(p.apply(upd('op-1', 1, { executionPhase: 'prepared' }))).toBe('duplicate_or_stale');
    expect(p.apply(upd('op-1', 2))).toBe('duplicate_or_stale');
    expect(p.project().operations[0]!.phase).toBe('dispatching');
  });

  it('tombstone prevents resurrection by late events', () => {
    const p = new RequestStateProjector();
    p.apply(upd('op-1', 3));
    p.apply({ kind: 'tombstone', source: 'harness', epoch: 1, entityId: 'op-1', revision: 4 });
    expect(p.apply(upd('op-1', 3))).toBe('tombstoned');
    expect(p.project().operations).toHaveLength(0);
  });

  it('resync: buffer → snapshot replaces scope → only higher buffered revisions applied', () => {
    const p = new RequestStateProjector();
    p.apply(upd('op-old', 1));
    p.resync('harness', 'operations');
    expect(p.apply(upd('op-1', 5, { executionPhase: 'stopped' }))).toBe('buffered');
    expect(p.apply(upd('op-1', 3, { executionPhase: 'prepared' }))).toBe('buffered');
    p.applySnapshot({
      source: 'harness',
      scope: 'operations',
      epoch: 1,
      objectsWithRevisions: [{ entityType: 'operation', entityId: 'op-1', revision: 4, state: { requestId: 'req-1', executionPhase: 'dispatching' } }],
      tombstones: [],
    });
    const v = p.project();
    expect(v.operations.map((o) => o.operationId)).toEqual(['op-1']); // op-old는 스냅샷 범위 교체로 제거
    expect(v.operations[0]!.phase).toBe('stopped');
    expect(v.sources[0]!.synchronizationState).toBe('synced');
  });

  it('epoch change marks the source incomplete instead of guessing', () => {
    const p = new RequestStateProjector();
    p.apply(upd('op-1', 1));
    expect(p.apply(upd('op-1', 1, {}, 2))).toBe('epoch_mismatch');
    expect(p.syncStates()[0]).toMatchObject({ synchronizationState: 'incomplete' });
  });

  it('buffer overflow marks incomplete and requires a new resync', () => {
    const p = new RequestStateProjector({ bufferLimit: 1 });
    p.resync('harness', 'operations');
    p.apply(upd('a', 1));
    expect(p.apply(upd('b', 1))).toBe('buffer_overflow');
    expect(p.syncStates()[0]!.incompleteReason).toBe('buffer_overflow');
  });

  it('task result and output channel results are projected independently (S-10)', () => {
    const p = new RequestStateProjector();
    p.apply(upd('op-1', 3, { actionResult: { status: 'succeeded', dispatchState: 'sent' } }));
    const feed = new OutputProjectionFeed();
    p.apply(feed.toUpdate({ kind: 'channel_failed', outputId: 'out-1', requestRefs: { requestId: 'req-1' }, channel: 'speech' }));
    p.apply(feed.toUpdate({ kind: 'channel_completed', outputId: 'out-1', requestRefs: { requestId: 'req-1' }, channel: 'display' }));
    const v = p.project();
    expect(v.operations[0]!.status).toBe('succeeded');
    expect(v.outputs[0]!.channels).toEqual({ speech: 'failed', display: 'completed' });
  });
});
