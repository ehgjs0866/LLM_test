/* eslint-disable no-console */
/**
 * 실제 연결 데모 — Harness 서버(pnpm harness)에 WebSocket으로 붙어 G-01 흐름을 따라간다.
 * 이 폴더(demo/)는 파이프라인 역할(라우팅 결과·ContextPacket 구성·질문 전달 이벤트·출력 요청)을 흉내 낸다.
 * 서버는 이 폴더를 import하지 않는다 → 파이프라인이 연결되면 demo/를 통째로 지워도 된다.
 *
 *   pnpm harness                       # 다른 터미널에서 먼저 실행
 *   pnpm demo                         # .env의 GITHUB_TEST_PR
 *   pnpm demo 12                      # PR 번호 지정
 *   pnpm demo 12 --answer "응, 승인해"  # 확인 질문 답변을 미리 지정
 *   pnpm demo 12 --ask "이 PR 뭐가 바뀌었어?" [--intent pr.summary]
 *
 * GitHub 쓰기 허용은 서버 옵션이다 (pnpm harness --allow-github-writes, 전송 직전 서버 콘솔에서 yes).
 * .env: HARNESS_WS_URL(기본 ws://127.0.0.1:8787), HARNESS_WS_TOKEN, GITHUB_TEST_REPO, GITHUB_TEST_PR,
 *       DEMO_EUREKA_ITEM_ID, DEMO_EUREKA_STAGE_ID (선택)
 */
import { createInterface } from 'node:readline/promises';
import type { ContextPacket, CurrentTurnInput, HarnessResult, OutputContent } from '@deskpet/contracts';
import { HarnessClient } from './harnessClient.js';

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
const fail = (msg: string): never => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};
if (args.includes('--allow-github-writes')) console.log('! --allow-github-writes는 서버 옵션으로 옮겨졌어요: pnpm harness --allow-github-writes');

const token = env['HARNESS_WS_TOKEN']?.trim() || fail('HARNESS_WS_TOKEN이 비어 있어요 (서버와 같은 값)');
const [owner, name] = (env['GITHUB_TEST_REPO'] ?? '').split('/');
if (!owner || !name) fail('GITHUB_TEST_REPO=owner/name 이 필요해요');
const prNumber = Number(prArg ?? env['GITHUB_TEST_PR']);
if (!prNumber) fail('PR 번호가 필요해요 (pnpm demo 12 또는 .env의 GITHUB_TEST_PR)');
const runId = Date.now().toString(36);
const client = new HarnessClient(env['HARNESS_WS_URL']?.trim() || 'ws://127.0.0.1:8787', runId);

// ------------------------------------------------- 파이프라인 흉내 (라우팅·ContextPacket)
const repository = { owner: owner!, name: name! };
const itemId = env['DEMO_EUREKA_ITEM_ID'];
const stageId = env['DEMO_EUREKA_STAGE_ID'];
const context: ContextPacket = {
  contextId: `ctx-demo-${runId}`,
  version: 1,
  target: { kind: 'github_pr', repository, prNumber },
  candidates: [],
  relatedTurns: [],
  taskRefs: itemId && stageId ? [{ itemId, stageId, repository, prNumber, source: { kind: 'eureka', ref: `item:${itemId}` } }] : [],
};
let turnSeq = 0;
const turn = (text: string, intention: string): CurrentTurnInput => ({
  conversationId: 'demo-conv',
  turnId: `demo-turn-${runId}-${++turnSeq}`,
  rawText: text,
  isFinal: true,
  inputChannel: 'web',
  sttConfidenceState: 'not_applicable',
  // 라우터 결과는 데모에서 흉내 낸 값이다 (실제 라우터 미연결)
  routeDecision: { headOutputs: { intention: { value: intention, confidence: 0.95 } }, overallConfidence: 0.95, missingRequiredSlots: [], route: 'harness', sourceTurnIds: [] },
});
const deadline = () => new Date(Date.now() + 60_000).toISOString();
const constraints = () => ({ deadlineAt: deadline(), maxPages: 3, maxResultBytes: 256_000, policyVersion: 'policy-0.1' });

async function call(kind: string, requestId: string, payload: unknown, withDeadline = true): Promise<unknown> {
  const r = await client.request(kind, requestId, payload, withDeadline ? deadline() : undefined);
  if (!r.ok) throw new Error(`${kind} 거부: ${r.error?.code} ${r.error?.message}${r.error?.issues ? ` (${r.error.issues.join('; ')})` : ''}`);
  return r.payload;
}

const eventSeq = new Map<string, number>();
/** 질문을 사용자에게 전달했다고 Harness에 알린다 (실제로는 파이프라인이 출력 완료 후 보낸다) */
async function deliverQuestion(r: HarnessResult) {
  const n = (eventSeq.get(r.requestId) ?? 0) + 1;
  eventSeq.set(r.requestId, n);
  const res = (await call(
    'pipeline.event',
    r.requestId,
    { messageId: `demo-ev-${runId}-${r.requestId}-${n}`, requestId: r.requestId, pendingId: r.pending!.pendingId, outputId: r.pending!.outputId, sourceRevision: n, occurredAt: new Date().toISOString(), kind: 'question_delivered', channel: 'web' },
    false,
  )) as { applied: boolean; reason?: string };
  if (!res.applied) throw new Error(`질문 전달 이벤트가 반영되지 않았어요: ${res.reason}`);
  // 상태 이벤트는 응답보다 먼저 도착한다 (같은 연결, 순서 보장)
  const p = client.entities.get(r.pending!.pendingId);
  return { pendingId: r.pending!.pendingId, revision: p?.revision ?? r.pending!.revision + 1 };
}

// ------------------------------------------------------------------ 출력
async function show(title: string, r: HarnessResult) {
  console.log(`\n── ${title} ──`);
  console.log(`  disposition: ${r.disposition}`);
  for (const a of r.actionResults) {
    console.log(`  · ${a.action}: ${a.status} (dispatch=${a.dispatchState})${a.error ? ` — ${a.error.provisionalCode}: ${a.error.message}` : ''}`);
  }
  const review = r.facts['review'] as { approvalBlockers?: string[]; approvalWarnings?: string[]; checks?: { requiredState: string; required: string[]; requiredSource?: string; requiredReasonCode?: string } } | undefined;
  if (review?.approvalBlockers?.length) console.log(`  · 승인 차단 사유: ${review.approvalBlockers.join(', ')}`);
  if (review?.approvalWarnings?.length) console.log(`  · 경고: ${review.approvalWarnings.join(', ')}`);
  const checks = review?.checks;
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
  const content = (await call('output.from_result', r.requestId, r, false)) as OutputContent;
  console.log(`  🗣 ${content.text}`);
  console.log(`  🖥 ${content.displayText}`);
  console.log(`  · 출력: ${content.fallbackUsed ? `고정 문구${content.validationResult.failures.length ? ` (모델 문장 거부: ${content.validationResult.failures.join(', ')})` : ''}` : '모델 문장 (검증 통과)'}`);
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

// ------------------------------------------------------------------ 흐름
async function main() {
  const w = await client.connect(token, 'pipeline');
  client.subscribe();
  console.log(`DeskPet 데모 클라이언트 — ${owner}/${name}#${prNumber} (서버 ${w.protocol}, epoch ${w.epoch})`);
  console.log(itemId && stageId ? `Eureka 연결: item ${itemId} / stage ${stageId}` : 'Eureka 연결 없음 (DEMO_EUREKA_ITEM_ID/STAGE_ID 미설정 → 후속 반영 단계 생략)');

  if (askText) {
    const id = `demo-ask-${runId}`;
    await show(`요청 (의도 ${askIntent})`, (await call('harness.request', id, { requestId: id, currentTurn: turn(askText, askIntent), context, constraints: constraints() })) as HarnessResult);
    return;
  }

  const reviewId = `demo-review-${runId}`;
  await show('1) 리뷰 요청', (await call('harness.request', reviewId, { requestId: reviewId, currentTurn: turn('그 PR 리뷰해서 읽어줘', 'pr.review'), context, constraints: constraints() })) as HarnessResult);

  const approveId = `demo-approve-${runId}`;
  let r = (await call('harness.request', approveId, { requestId: approveId, currentTurn: turn('좋아, 그 PR 승인해줘', 'pr.approve'), context, constraints: constraints() })) as HarnessResult;
  await show('2) 승인 요청', r);

  for (let step = 3; step <= 5 && r.disposition === 'awaiting_user' && r.pending; step++) {
    const p = await deliverQuestion(r);
    const text = await ask('답변을 입력하세요 (예: 응, 승인해 / 아니, 보류해). 빈 입력이면 종료합니다.');
    if (!text) {
      console.log('\n답변 없이 종료합니다. 대기 중인 확인은 실행되지 않습니다.');
      break;
    }
    r = (await call('harness.resume', r.requestId, {
      originalRequestId: r.requestId,
      currentTurn: turn(text, 'confirm'),
      context,
      pendingId: p.pendingId,
      expectedPendingRevision: p.revision,
      ...(r.pending.confirmationId ? { confirmationId: r.pending.confirmationId } : {}),
      newCallConstraints: constraints(),
    })) as HarnessResult;
    await show(`${step}) 답변 처리`, r);
  }

  const mine = [...client.entities.values()].filter((e) => e.entityType === 'operation' && String(e.state['requestId'] ?? '').endsWith(`-${runId}`));
  console.log(`\n── 이번 실행의 operation (${mine.length}건, 전체 조회: pnpm db ops) ──`);
  for (const e of mine) {
    const s = e.state as { action: string; requestId: string; recovery: string; actionResult?: { status: string; dispatchState: string } };
    console.log(`  · ${s.action} [${s.requestId}] ${s.actionResult?.status ?? 'in_progress'} dispatch=${s.actionResult?.dispatchState ?? '-'} recovery=${s.recovery}`);
  }
}

main()
  .catch((e: unknown) => {
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => client.close());
