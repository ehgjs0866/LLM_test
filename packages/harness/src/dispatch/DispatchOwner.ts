import type { DispatchHandle, ExecutionAuthority, OperationRecord } from '@deskpet/contracts';
import type { Clock } from '../runtime/clock.js';
import type { AckResult, OperationEvidence, OperationStore, PrepareCommand, PrepareResult } from '../store/OperationStore.js';

/**
 * DispatchOwner 프로토콜 (message-contracts §Write and Reconciliation 1~4, 다이어그램 «interface» DispatchOwner).
 *
 * 1. 소유자가 operation/attempt·검증 입력·ExpectedOutcome·확인 근거를 영속 저장하고 실행 권한을 원자적으로 확보한다.
 * 2. Gateway는 실제 전송 직전에 beforeDispatch를 호출한다. 소유자는 취소·deadline·확인 유효성을 다시 검사하고
 *    attempt를 may_have_been_sent로 영속 저장한 뒤 DurableAck를 준다. ack 이전에는 전송하지 않는다.
 * 3. Gateway는 유효한 attempt 권한으로만 전송하고 증거를 보고한다.
 * 4. 권한 인계는 owner revision/attempt 비교로 원자적으로 수행한다. lease 만료만으로 인계하지 않는다.
 */
export interface DispatchOwner {
  prepareOperation(command: PrepareCommand): Promise<PrepareResult>;
  beforeDispatch(operationId: string, attemptId: string, ownerRevision: number): Promise<AckResult>;
  recordEvidence(operationId: string, attemptId: string, evidence: Omit<OperationEvidence, 'attemptId'>): Promise<OperationRecord>;
}

export interface DispatchValidityCheck {
  /** null이면 유효. 문자열이면 차단 사유 */
  (op: OperationRecord): Promise<string | null>;
}

export class StoreDispatchOwner implements DispatchOwner {
  constructor(
    private readonly store: OperationStore,
    private readonly clock: Clock,
    private readonly holderId: string,
    private readonly validity: DispatchValidityCheck,
  ) {}

  prepareOperation(command: PrepareCommand): Promise<PrepareResult> {
    return this.store.reserveAndPrepare({ ...command, holderId: this.holderId });
  }

  async beforeDispatch(operationId: string, attemptId: string, ownerRevision: number): Promise<AckResult> {
    const op = await this.store.getOperation(operationId);
    if (!op) return { ok: false, reason: 'not_found', detail: operationId };
    const blocked = await this.validity(op);
    if (blocked) {
      // 실행 권한 회수: 아직 not_sent이므로 전송하지 않았음이 확실하다
      await this.store.revokeBeforeDispatch(operationId, blocked);
      return { ok: false, reason: 'authority_revoked', detail: blocked };
    }
    return this.store.persistMayHaveBeenSent({
      operationId,
      attemptId,
      ownerRevision,
      holderId: this.holderId,
      kind: 'write',
    });
  }

  recordEvidence(operationId: string, attemptId: string, evidence: Omit<OperationEvidence, 'attemptId'>) {
    return this.store.appendEvidence(operationId, { ...evidence, attemptId });
  }

  handleFor(authority: ExecutionAuthority, operationId: string, signal?: AbortSignal): DispatchHandle {
    return {
      operationId,
      attemptId: authority.attemptId,
      ownerRevision: authority.ownerRevision,
      beforeDispatch: () => this.beforeDispatch(operationId, authority.attemptId, authority.ownerRevision),
      ...(signal ? { signal } : {}),
    };
  }
}
