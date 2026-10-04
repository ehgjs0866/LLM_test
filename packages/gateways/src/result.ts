import type { ErrorInfo, ExternalRef, GatewayResult, NextAction, ProvisionalErrorCode } from '@deskpet/contracts';

export function err(stage: string, code: ProvisionalErrorCode, message: string, nextAction: NextAction, ids: { operationId?: string; attemptId?: string } = {}): ErrorInfo {
  return {
    stage,
    provisionalCode: code,
    message,
    nextAction,
    ...(ids.operationId ? { operationId: ids.operationId } : {}),
    ...(ids.attemptId ? { attemptId: ids.attemptId } : {}),
  };
}

export function gr(p: Partial<GatewayResult> & Pick<GatewayResult, 'mode' | 'dispatchState' | 'outcome'>): GatewayResult {
  return { externalRefs: [] as ExternalRef[], successTextOnly: false, ...p };
}

/** 오류 본문은 JSON {"message"} 또는 평문 두 형식이 있다 (Eureka PDF §6). */
export function parseErrorBody(text: string): string {
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === 'object' && 'message' in j && typeof (j as { message: unknown }).message === 'string') {
      return (j as { message: string }).message;
    }
    return text;
  } catch {
    return text;
  }
}
