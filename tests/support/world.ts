import type { HarnessResult, PipelineEvent } from '@deskpet/contracts';
import { EurekaGateway, FakeEurekaServer, GitHubReviewGateway } from '@deskpet/gateways';
import { DEFAULT_POLICY, FakeClock, HarnessService, InMemoryOperationStore, SequentialIdGen, type PolicyConfig } from '@deskpet/harness';
import { ITEM_ID, STAGE_ID, T0 } from './builders.js';
import { fakeGitHub, goldenPr } from './github.js';

/**
 * fake Gateway 기반 테스트 환경. 파이프라인 역할(질문 전달 이벤트)은 테스트가 흉내 낸다.
 */
export function createWorld(opts: { githubMode?: 'rest' | 'mcp'; config?: Partial<PolicyConfig> } = {}) {
  const clock = new FakeClock(T0);
  const ids = new SequentialIdGen();
  const config = { ...DEFAULT_POLICY, ...opts.config };
  const store = new InMemoryOperationStore({
    clock,
    ids,
    capacityBytes: config.storeCapacityBytes,
    recoveryBudgetBytes: config.recoveryBudgetBytes,
    minRetentionMs: config.minRetentionMs,
    maxRecoveryAttempts: config.maxRecoveryAttempts,
  });
  const github = fakeGitHub(opts.githubMode ?? 'rest', () => clock.nowMs(), goldenPr());
  const eurekaServer = new FakeEurekaServer(() => clock.nowMs());
  eurekaServer.addItem({
    id: ITEM_ID,
    name: '캡스톤 PR 검토',
    dueAt: clock.nowMs() + 40 * 60_000,
    priority: 'high',
    stages: [
      { id: '1000037', name: '변경 확인', status: 'done', order: 1 },
      { id: STAGE_ID, name: 'PR 승인', status: 'doing', order: 2 },
    ],
  });
  const githubGw = new GitHubReviewGateway({ transport: github, now: () => clock.nowMs() });
  const eurekaGw = new EurekaGateway({ http: eurekaServer, now: () => clock.nowMs() });
  const makeHarness = () => new HarnessService({ store, github: githubGw, eureka: eurekaGw, clock, ids, config });
  let harness = makeHarness();

  const seq = new Map<string, number>();
  /** 파이프라인이 질문을 실제로 전달했다고 보고한다 */
  async function deliverQuestion(result: HarnessResult, channel: 'speech' | 'display' | 'web' = 'speech') {
    const p = result.pending!;
    const n = (seq.get(result.requestId) ?? 0) + 1;
    seq.set(result.requestId, n);
    const ev: PipelineEvent = {
      messageId: `ev-${result.requestId}-${n}`,
      requestId: result.requestId,
      pendingId: p.pendingId,
      outputId: p.outputId,
      sourceRevision: n,
      occurredAt: clock.nowIso(),
      kind: 'question_delivered',
      channel,
    };
    const r = await harness.onPipelineEvent(ev);
    if (!r.applied) throw new Error(`delivery not applied: ${r.reason}`);
    const pending = await store.getPending(p.pendingId);
    return { pendingId: p.pendingId, revision: pending!.revision, confirmationId: p.confirmationId };
  }

  async function pipelineEvent(requestId: string, kind: PipelineEvent['kind'], extra: Partial<PipelineEvent> = {}) {
    const n = (seq.get(requestId) ?? 0) + 1;
    seq.set(requestId, n);
    return harness.onPipelineEvent({ messageId: `ev-${requestId}-${n}`, requestId, sourceRevision: n, occurredAt: clock.nowIso(), kind, ...extra });
  }

  return {
    clock,
    ids,
    store,
    github,
    eurekaServer,
    githubGw,
    eurekaGw,
    get harness() {
      return harness;
    },
    /** 프로세스 재시작: 영속 저장소는 유지, Harness 메모리 상태는 사라짐 */
    restart() {
      store.simulateRestart();
      harness = makeHarness();
    },
    deliverQuestion,
    pipelineEvent,
    seq,
  };
}
