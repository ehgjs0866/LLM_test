import { z } from 'zod';
import { Id, UtcTimestamp } from './common.js';
import { HarnessRequest, HarnessResumeRequest, HarnessResult, PipelineEvent } from './harness.js';
import { OutputEvent, OutputRequest } from './output.js';
import { OperationUpdated, Tombstone } from './projection.js';

/**
 * 공통 메시지 봉투.
 * 근거: message-contracts §Envelope and Identity (causationId 통일 제안을 따름 — README C-02).
 *
 * - 지원하지 않는 major, 알 수 없는 kind, payload 타입 오류는 실행 전에 거부한다.
 * - deadlineAt은 실행 요청에 필수.
 */

export const SUPPORTED_MAJOR = 1;

export const SchemaVersion = z
  .string()
  .regex(/^\d+\.\d+$/, 'schemaVersion must be "<major>.<minor>"')
  .refine((v) => Number(v.split('.')[0]) === SUPPORTED_MAJOR, { message: `unsupported major (supported: ${SUPPORTED_MAJOR})` });

export const PAYLOAD_BY_KIND = {
  'harness.request': HarnessRequest,
  'harness.resume': HarnessResumeRequest,
  'harness.result': HarnessResult,
  'pipeline.event': PipelineEvent,
  'output.request': OutputRequest,
  'output.event': OutputEvent,
  'operation.updated': OperationUpdated,
  'projection.tombstone': Tombstone,
} as const;

export type EnvelopeKind = keyof typeof PAYLOAD_BY_KIND;
export const EnvelopeKind = z.enum(Object.keys(PAYLOAD_BY_KIND) as [EnvelopeKind, ...EnvelopeKind[]]);

/** 실행 요청 종류: deadlineAt 필수 */
export const EXECUTION_KINDS: ReadonlySet<EnvelopeKind> = new Set(['harness.request', 'harness.resume']);

const EnvelopeHeader = z.object({
  schemaVersion: SchemaVersion,
  messageId: Id,
  kind: EnvelopeKind,
  requestId: Id,
  causationId: Id.optional(),
  createdAt: UtcTimestamp,
  deadlineAt: UtcTimestamp.optional(),
  payload: z.unknown(),
});

export type Envelope<K extends EnvelopeKind = EnvelopeKind> = Omit<z.infer<typeof EnvelopeHeader>, 'kind' | 'payload'> & {
  kind: K;
  payload: z.infer<(typeof PAYLOAD_BY_KIND)[K]>;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** 봉투 + kind별 payload를 검증한다. 실패하면 실행하지 않는다. */
export function parseEnvelope(input: unknown): ParseResult<Envelope> {
  const header = EnvelopeHeader.safeParse(input);
  if (!header.success) return { ok: false, issues: header.error.issues.map(fmt) };
  const h = header.data;
  if (EXECUTION_KINDS.has(h.kind) && !h.deadlineAt) {
    return { ok: false, issues: ['deadlineAt: required for execution requests'] };
  }
  const schema = PAYLOAD_BY_KIND[h.kind] as z.ZodTypeAny;
  const payload = schema.safeParse(h.payload);
  if (!payload.success) return { ok: false, issues: payload.error.issues.map((i) => `payload.${fmt(i)}`) };
  return { ok: true, value: { ...h, payload: payload.data } as Envelope };
}

export function makeEnvelope<K extends EnvelopeKind>(
  kind: K,
  fields: { messageId: string; requestId: string; causationId?: string; createdAt: string; deadlineAt?: string },
  payload: z.input<(typeof PAYLOAD_BY_KIND)[K]>,
): Envelope<K> {
  const raw = { schemaVersion: `${SUPPORTED_MAJOR}.0`, kind, ...fields, payload };
  const parsed = parseEnvelope(raw);
  if (!parsed.ok) throw new Error(`invalid envelope: ${parsed.issues.join('; ')}`);
  return parsed.value as Envelope<K>;
}

function fmt(i: z.ZodIssue): string {
  return `${i.path.join('.') || '(root)'}: ${i.message}`;
}
