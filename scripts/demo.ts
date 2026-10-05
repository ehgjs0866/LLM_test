/* eslint-disable no-console */
/**
 * 실제 연결 데모 — 실제 GitHub·Eureka Gateway를 HarnessService에 연결해 G-01 흐름을 따라간다.
 * 쓰기(GitHub 승인, Eureka 단계 완료)는 코드에서 꺼져 있다. 승인 단계는 "보내지 않음"으로 끝난다.
 *
 *   pnpm demo                         # .env의 GITHUB_TEST_PR
 *   pnpm demo 9                       # PR 번호 지정
 *   pnpm demo 9 --answer "응, 승인해"  # 확인 질문 답변을 미리 지정 (입력 없이 실행)
 *   pnpm demo 11 --allow-github-writes # GitHub 승인을 실제로 보낸다 (전송 직전 터미널에서 yes 입력 필요)
 *   pnpm demo 11 --ask "이 PR 뭐가 바뀌었어?" [--intent pr.summary]
 *                                     # 요청 하나만 보낸다. 규칙이 모르는 의도면 LLM 보조 Guide가 단계를 고른다
 *
 * LLM: .env의 LLM_PROVIDER=gemini(+GEMINI_API_KEY) 또는 openai(+OPENAI_API_KEY, OPENAI_MODEL)이면 LLM 보조 Guide와 출력 모델을 켠다.
 *      없으면 규칙 Guide와 고정 문구만 쓴다. LLM은 쓰기 권한이 없고 결과는 코드가 다시 검증한다.
 *
 * --allow-github-writes를 줘도 실제 전송 직전에 대상(저장소·PR·커밋)을 보여 주고 터미널에서 정확히 `yes`를
 * 입력해야만 보낸다. 입력이 없거나 다르면 보내지 않는다(not_sent, operator_declined). --answer로 건너뛸 수 없다.
 * Eureka 쓰기는 이 데모에서 항상 꺼져 있다.
 *
 * 파이프라인 역할(라우팅·질문 전달 이벤트)은 이 스크립트가 흉내 낸다. 입력 채널은 키보드이므로 web으로 표시한다.
 * .env: GITHUB_TOKEN, GITHUB_TEST_REPO, EUREKA_API_KEY, EUREKA_BASE_URL, DESKPET_REQUIRED_CHECKS,
 *       DEMO_EUREKA_ITEM_ID, DEMO_EUREKA_STAGE_ID (선택 — PR과 연결할 Eureka 업무·단계)
 *       DESKPET_STORE_PATH (선택 — 예: .deskpet/harness.db. 있으면 기록을 SQLite 파일에 남기고 다음 실행 때 복구)
 */
import { createInterface } from 'node:readline/promises';
import type { ContextPacket, CurrentTurnInput, HarnessResult } from '@deskpet/contracts';
import { createEurekaRestGateway, GitHubReviewGateway, GitHubTransportError, parseRequiredChecksFallback, RestGitHubTransport, type GitHubTransport } from '@deskpet/gateways';
import { DEFAULT_POLICY, HarnessService, InMemoryOperationStore, randomIdGen, systemClock } from '@deskpet/harness';
import { createLlmFromEnv } from '@deskpet/llm';
import { OutputService, mapHarnessResult } from '@deskpet/output';

try {
  process.loadEnvFile('.env');
} catch {
  console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}

const env = process.env;
const args = process.argv.slice(2);
const valueOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const valueIdx = new Set(['--answer', '--ask', '--intent'].map((f) => args.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
const presetAnswer = valueOf('--answer');
const askText = valueOf('--ask');
const askIntent = valueOf('--intent') ?? 'pr.summary';
const prArg = args.find((a, i) => /^\d+$/.test(a) && !valueIdx.has(i));
const allowGithubWrites = args.includes('--allow-github-writes');

const fail = (msg: string): never => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};

const token = env['GITHUB_TOKEN'] || fail('GITHUB_TOKEN이 비어 있어요');
const [owner, name] = (env['GITHUB_TEST_REPO'] ?? '').split('/');
if (!owner || !name) fail('GITHUB_TEST_REPO=owner/name 이 필요해요');
const prNumber = Number(prArg ?? env['GITHUB_TEST_PR']);
if (!prNumber) fail('PR 번호가 필요해요 (pnpm demo 9 또는 .env의 GITHUB_TEST_PR)');
if (!env['EUREKA_API_KEY']) fail('EUREKA_API_KEY가 비어 있어요');

// ------------------------------------------------------------------ wiring
const clock = systemClock;
const ids = randomIdGen;
const config = DEFAULT_POLICY;
const storeOpts = {
  clock,
  ids,
  capacityBytes: config.storeCapacityBytes,
  recoveryBudgetBytes: config.recoveryBudgetBytes,
  minRetentionMs: config.minRetentionMs,
  maxRecoveryAttempts: config.maxRecoveryAttempts,
};
// DESKPET_STORE_PATH가 있으면 SQLite 파일 저장소: 실행을 끝내도 기록이 남고, 다음 실행 시작 때 재시작 복구를 한다
const storePath = env['DESKPET_STORE_PATH']?.trim();
const store = storePath ? InMemoryOperationStore.openDurable(storePath, storeOpts) : new InMemoryOperationStore(storeOpts);
const runId = Date.now().toString(36);
/**
 * 운영자 확인 게이트 (데모 전용). 실제 전송 직전에 대상과 함께 `yes` 입력을 요구한다.
 * DurableAck 이후에 묻지만, 거절하면 전송하지 않았음이 확실하므로 not_sent + 증거로 기록된다.
 */
class OperatorGatedTransport implements GitHubTransport {
  readonly mode = 'rest' as const;
  readonly writesEnabled: boolean;
  constructor(private readonly inner: RestGitHubTransport, enabled: boolean) {
    this.writesEnabled = enabled;
  }
  read: GitHubTransport['read'] = (q, c) => this.inner.read(q, c);
  async submitApproval(cmd: Parameters<GitHubTransport['submitApproval']>[0], c: Parameters<GitHubTransport['submitApproval']>[1]) {
    console.log('\n  ⚠ 실제 GitHub 승인 요청을 보내려고 합니다.');
    console.log(`    저장소: ${cmd.repository.owner}/${cmd.repository.name}  PR: #${cmd.prNumber}`);
    console.log(`    커밋: ${cmd.commitId}  행위: ${cmd.event}`);
    const typed = await askRaw('    보내려면 yes를 입력하세요 (그 외 입력은 취소): ');
    if (typed !== 'yes') throw new GitHubTransportError('not_sent', 'operator declined before sending', 'operator_declined');
    return this.inner.submitApproval(cmd, c);
  }
}

const github = new GitHubReviewGateway({
  transport: new OperatorGatedTransport(new RestGitHubTransport({ token, allowWrites: allowGithubWrites }), allowGithubWrites),
  now: () => clock.nowMs(),
  requiredChecksFallback: parseRequiredChecksFallback(env['DESKPET_REQUIRED_CHECKS']),
});
const eureka = createEurekaRestGateway(env, undefined, { allowWrites: false });
const llm = createLlmFromEnv(env);
const harness = new HarnessService({ store, github, eureka, clock, ids, config, holderId: 'demo-cli', ...(llm.guideClient ? { llm: llm.guideClient } : {}) });
const output = new OutputService(llm.outputModel ? { model: llm.outputModel, ...(llm.outputTimeoutMs ? { modelTimeoutMs: llm.outputTimeoutMs } : {}) } : {});

const repository = { owner: owner!, name: name! };
const itemId = env['DEMO_EUREKA_ITEM_ID'];
const stageId = env['DEMO_EUREKA_STAGE_ID'];
const context: ContextPacket = {
  contextId: `ctx-demo-${Date.now()}`,
  version: 1,
  target: { kind: 'github_pr', repository, prNumber },
  candidates: [],
  relatedTurns: [],
  taskRefs: itemId && stageId ? [{ itemId, stageId, repository, prNumber, source: { kind: 'eureka', ref: `item:${itemId}` } }] : [],
};

let turnSeq = 0;
const turn = (text: string, intention: string): CurrentTurnInput => ({
  conversationId: 'demo-conv',
  turnId: `demo-turn-${++turnSeq}-${Date.now()}`,
  rawText: text,
  isFinal: true,
  inputChannel: 'web',
  sttConfidenceState: 'not_applicable',
  // 라우터 결과는 데모에서 흉내 낸 값이다 (실제 라우터 미연결)
  routeDecision: { headOutputs: { intention: { value: intention, confidence: 0.95 } }, overallConfidence: 0.95, missingRequiredSlots: [], route: 'harness', sourceTurnIds: [] },
});
const constraints = () => ({ deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxPages: 3, maxResultBytes: 256_000, policyVersion: config.policyVersion });

const eventSeq = new Map<string, number>();
async function deliverQuestion(r: HarnessResult) {
  const n = (eventSeq.get(r.requestId) ?? 0) + 1;
  eventSeq.set(r.requestId, n);
  await harness.onPipelineEvent({
    messageId: `demo-ev-${r.requestId}-${n}`,
    requestId: r.requestId,
    pendingId: r.pending!.pendingId,
    outputId: r.pending!.outputId,
    sourceRevision: n,
    occurredAt: new Date().toISOString(),
    kind: 'question_delivered',
    channel: 'web',
  });
  return (await store.getPending(r.pending!.pendingId))!;
}

// ------------------------------------------------------------------ output
async function show(title: string, r: HarnessResult) {
  console.log(`\n── ${title} ──`);
  console.log(`  disposition: ${r.disposition}`);
  for (const a of r.actionResults) {
    console.log(`  · ${a.action}: ${a.status} (dispatch=${a.dispatchState})${a.error ? ` — ${a.error.provisionalCode}: ${a.error.message}` : ''}`);
  }
  const review = r.facts['review'] as { approvalBlockers?: string[]; approvalWarnings?: string[] } | undefined;
  if (review?.approvalBlockers?.length) console.log(`  · 승인 차단 사유: ${review.approvalBlockers.join(', ')}`);
  if (review?.approvalWarnings?.length) console.log(`  · 경고: ${review.approvalWarnings.join(', ')}`);
  const checks = (r.facts['review'] as { checks?: { requiredState: string; required: string[]; requiredSource?: string; requiredReasonCode?: string } } | undefined)?.checks;
  if (checks) {
    console.log(`  · 필수 검사: ${checks.requiredState}${checks.required.length ? ` [${checks.required.join(', ')}]` : ''}${checks.requiredSource ? `, 출처 ${checks.requiredSource}` : ''}${checks.requiredReasonCode ? ` (${checks.requiredReasonCode})` : ''}`);
  }
  for (const a of r.actionResults.filter((x) => x.externalRefs.length)) {
    for (const e of a.externalRefs) console.log(`  · 외부 증거: ${e.system}/${e.kind} id=${e.id}${e.details ? ` ${JSON.stringify(e.details)}` : ''}`);
  }
  const blocked = r.facts['blocked'] as { reasons: string[]; guideRefs?: string[] } | undefined;
  if (blocked) console.log(`  · 차단: ${blocked.reasons.join(', ')}${blocked.guideRefs?.length ? ` (Guide 근거: ${blocked.guideRefs.join(', ')})` : ''}`);
  const fu = r.facts['followUp'] as { eligibility: string; conditions?: string[]; reason?: string } | undefined;
  if (fu) console.log(`  · Eureka 후속 적합성: ${fu.eligibility}${fu.conditions?.length ? ` [${fu.conditions.join(', ')}]` : ''}${fu.reason ? ` (${fu.reason})` : ''}`);
  if (r.pending) console.log(`  · 대기 질문: ${r.pending.kind} / ${r.pending.purpose}${r.pending.scope ? ` / ${(r.facts['question'] as { meaning?: string })?.meaning ?? ''}` : ''}`);
  for (const e of r.processingErrors) console.log(`  · 처리 오류: ${e.provisionalCode}: ${e.message}`);
  const content = await output.generate(mapHarnessResult(r));
  console.log(`  🗣 ${content.text}`);
  console.log(`  🖥 ${content.displayText}`);
  if (llm.enabled) console.log(`  · 출력: ${content.fallbackUsed ? `고정 문구${content.validationResult.failures.length ? ` (모델 문장 거부: ${content.validationResult.failures.join(', ')})` : ''}` : '모델 문장 (검증 통과)'}`);
}

/** 운영자 확인용: --answer와 무관하게 항상 터미널 입력을 받는다. TTY가 아니면 거절로 본다 */
async function askRaw(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(prompt);
  rl.close();
  return a.trim();
}

async function ask(question: string): Promise<string | undefined> {
  if (presetAnswer !== undefined) {
    console.log(`  > ${presetAnswer}  (--answer)`);
    return presetAnswer;
  }
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`  ${question}\n  > `);
  rl.close();
  return a.trim() || undefined;
}

// ------------------------------------------------------------------ flow
async function main() {
  console.log(`DeskPet 실제 연결 데모 — ${owner}/${name}#${prNumber}`);
  console.log(
    allowGithubWrites
      ? 'GitHub 쓰기 허용(--allow-github-writes): 승인 전송 직전에 yes 입력을 한 번 더 받습니다. Eureka 쓰기는 꺼져 있습니다.'
      : '쓰기 비활성: GitHub 승인·Eureka 단계 완료 요청은 보내지 않습니다.',
  );
  console.log(llm.enabled ? `LLM: ${llm.provider} / ${llm.model} (규칙이 모르는 의도 + 출력 문장 다듬기)` : `LLM 꺼짐 (${llm.reason}) — 규칙 Guide와 고정 문구만 사용`);
  if (storePath) {
    const cleaned = await store.maintain(); // 보존 기간이 지난 기록 정리 (진행 중·결과 불명은 남김)
    const all = await store.listOperations();
    const needed = all.filter((o) => o.recovery === 'needed');
    console.log(`저장소: ${storePath} (operation ${all.length}건, 결과 확인 필요 ${needed.length}건, 이번에 정리 ${cleaned}건)`);
    // 이전 실행에서 결과를 모르는 쓰기는 다시 보내지 않고 읽기로만 확인한다
    for (const op of needed) {
      const rec = await harness.reconcile(op.operationId, `demo-recover-${runId}`, { deadlineAt: new Date(Date.now() + 30_000).toISOString() });
      console.log(`  · 재시작 복구 ${op.action} [${op.requestId}]: ${rec.status}${rec.actionResult ? ` → ${rec.actionResult.status}` : ''}`);
    }
  } else console.log('저장소: 메모리 (DESKPET_STORE_PATH 미설정 → 실행이 끝나면 기록이 사라짐)');
  console.log(itemId && stageId ? `Eureka 연결: item ${itemId} / stage ${stageId}` : 'Eureka 연결 없음 (DEMO_EUREKA_ITEM_ID/STAGE_ID 미설정 → 후속 반영 단계 생략)');

  if (askText) {
    const r0 = await harness.handle({ requestId: `demo-ask-${runId}`, currentTurn: turn(askText, askIntent), context, constraints: constraints() });
    await show(`요청 (의도 ${askIntent})`, r0);
    return;
  }

  const r1 = await harness.handle({ requestId: `demo-review-${runId}`, currentTurn: turn('그 PR 리뷰해서 읽어줘', 'pr.review'), context, constraints: constraints() });
  await show('1) 리뷰 요청', r1);

  let r = await harness.handle({ requestId: `demo-approve-${runId}`, currentTurn: turn('좋아, 그 PR 승인해줘', 'pr.approve'), context, constraints: constraints() });
  await show('2) 승인 요청', r);

  for (let step = 3; step <= 5 && r.disposition === 'awaiting_user' && r.pending; step++) {
    const p = await deliverQuestion(r);
    const text = await ask('답변을 입력하세요 (예: 응, 승인해 / 아니, 보류해). 빈 입력이면 종료합니다.');
    if (!text) {
      console.log('\n답변 없이 종료합니다. 대기 중인 확인은 실행되지 않습니다.');
      break;
    }
    r = await harness.resume({
      originalRequestId: r.requestId,
      currentTurn: turn(text, 'confirm'),
      context,
      pendingId: p.pendingId,
      expectedPendingRevision: p.revision,
      ...(r.pending.confirmationId ? { confirmationId: r.pending.confirmationId } : {}),
      newCallConstraints: constraints(),
    });
    await show(`${step}) 답변 처리`, r);
  }

  const allOps = await store.listOperations();
  const mine = allOps.filter((o) => o.requestId.endsWith(`-${runId}`));
  console.log(`\n── 이번 실행의 operation (${mine.length}건 / 저장소 전체 ${allOps.length}건, 전체 조회: pnpm db ops) ──`);
  for (const op of mine) {
    const ar = op.actionResult;
    console.log(`  · ${op.action} [${op.requestId}] ${ar?.status ?? 'in_progress'} dispatch=${ar?.dispatchState ?? '-'} recovery=${op.recovery}${op.followUp ? ` followUp=${op.followUp.eligibility}` : ''}`);
  }
}

main()
  .finally(() => store.close())
  .catch((e: unknown) => {
    console.log(`✗ 예외: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
