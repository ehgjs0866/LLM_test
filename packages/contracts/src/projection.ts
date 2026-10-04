import { z } from 'zod';
import { Id, Revision } from './common.js';

/**
 * 웹 상태 투영 계약.
 * 근거: message-contracts §Output and Projection, Liability §Output and Monitoring.
 */

/** 원본 종류. 원본들 간 하나의 원자적 스냅샷을 보장하지 않는다. */
export const ProjectionSource = z.enum(['harness', 'eureka_module', 'pipeline']);
export type ProjectionSource = z.infer<typeof ProjectionSource>;

export const EntityType = z.enum(['operation', 'pending', 'confirmation', 'request', 'output']);

export const OperationUpdated = z.object({
  kind: z.literal('operation.updated'),
  source: ProjectionSource,
  epoch: z.number().int().nonnegative(),
  entityType: EntityType,
  entityId: Id,
  revision: Revision,
  currentState: z.record(z.unknown()),
  relatedIds: z.record(z.string()).default({}),
});
export type OperationUpdated = z.infer<typeof OperationUpdated>;

export const Tombstone = z.object({
  kind: z.literal('tombstone'),
  source: ProjectionSource,
  epoch: z.number().int().nonnegative(),
  entityId: Id,
  revision: Revision,
});
export type Tombstone = z.infer<typeof Tombstone>;

export const SnapshotObject = z.object({
  entityType: EntityType,
  entityId: Id,
  revision: Revision,
  state: z.record(z.unknown()),
});

export const Snapshot = z.object({
  source: ProjectionSource,
  scope: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  objectsWithRevisions: z.array(SnapshotObject),
  /** 스냅샷에 포함된 삭제 revision (inference: 같은 epoch 내 부활 방지) */
  tombstones: z.array(z.object({ entityId: Id, revision: Revision })).default([]),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const SynchronizationState = z.enum(['synced', 'syncing', 'incomplete']);
export const SourceSyncState = z.object({
  source: ProjectionSource,
  scope: z.string(),
  epoch: z.number().int().nonnegative().optional(),
  synchronizationState: SynchronizationState,
  incompleteReason: z.string().optional(),
});
export type SourceSyncState = z.infer<typeof SourceSyncState>;
