import { z } from 'zod';
import { Id, UtcTimestamp } from './common.js';

/**
 * Eureka 정규화 타입 (DeskPet 내부 계약).
 * 근거: eureka-desk-pet-guide.pdf §2~§4, eureka-process.md. 서버 원본 JSON과 같다고 가정하지 않는다.
 */

export const StageStatus = z.enum(['todo', 'doing', 'done', 'skip', 'unknown']);
export type StageStatus = z.infer<typeof StageStatus>;

/** item 상태는 서버가 갱신하지 않으므로 stage$$로 계산한다 (PDF §3-(2)). */
export const ItemState = z.enum(['todo', 'doing', 'done', 'hold']);
export type ItemState = z.infer<typeof ItemState>;

export const TaskStage = z.object({
  stageId: Id,
  name: z.string(),
  status: StageStatus,
  order: z.number().int().optional(),
  completedAt: UtcTimestamp.optional(),
});
export type TaskStage = z.infer<typeof TaskStage>;

export const TaskSummary = z.object({
  itemId: Id,
  name: z.string(),
  /** 리마인더 설명. Eureka PDF 응답 예시에는 없음 → 없으면 생략하고 name으로 대체하지 않는다 (README C-08) */
  description: z.string().optional(),
  dueAtMs: z.number().int().optional(),
  dueAt: UtcTimestamp.optional(),
  priority: z.string().optional(),
  computedState: ItemState,
  stages: z.array(TaskStage),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskList = z.object({
  items: z.array(TaskSummary),
  total: z.number().int().nonnegative().optional(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  observedAt: UtcTimestamp,
});
export type TaskList = z.infer<typeof TaskList>;

export const TaskState = z.object({
  itemId: Id,
  /** GET /items/{id}/status 서버 계산값 */
  itemStatus: ItemState,
  totalStages: z.number().int().nonnegative(),
  doneStages: z.number().int().nonnegative(),
  stage: TaskStage.optional(),
  observedAt: UtcTimestamp,
});
export type TaskState = z.infer<typeof TaskState>;
