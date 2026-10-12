/* eslint-disable no-console */
/**
 * Harness 서비스 서버 (WebSocket). 파이프라인·데모 클라이언트·웹 화면이 이 서버에 연결한다.
 *
 *   pnpm harness                          # 쓰기 비활성 (GitHub 승인·Eureka 완료 요청은 보내지 않음)
 *   pnpm harness --allow-github-writes    # GitHub 승인 쓰기 허용. 전송 직전마다 이 서버 콘솔에서 yes 입력 필요.
 *                                         # DESKPET_STORE_PATH(영속 저장소) 필수. 같은 DB는 한 프로세스만 연다 (<DB>.lock)
 *   pnpm harness --allow-eureka-writes    # Eureka 쓰기 허용 (개발 환경 flw-d1만). 전송 직전마다 콘솔 yes. 영속 저장소 필수
 *
 * .env
 *   HARNESS_WS_TOKEN (필수, 16자 이상 — 클라이언트 hello 인증), HARNESS_WS_HOST(기본 127.0.0.1), HARNESS_WS_PORT(기본 8787),
 *   HARNESS_WS_ALLOWED_ORIGINS (브라우저 Origin 허용 목록, 쉼표 구분. 비우면 브라우저 접속 거부)
 *   HARNESS_WS_VIEWER_TOKEN (선택, 16자 이상 — 웹 화면용 구독 전용 토큰. pipeline 토큰과 달라야 함)
 *   GITHUB_TOKEN, EUREKA_API_KEY, EUREKA_BASE_URL, DESKPET_REQUIRED_CHECKS, DESKPET_STORE_PATH, LLM_* (기존과 같음)
 * 비밀값은 출력하지 않는다. 쓰기는 옵션을 준 경우에만, 보내기 직전마다 콘솔 yes 확인 후 보낸다.
 */
import { createInterface } from 'node:readline/promises';
import { createEurekaRestGateway, GitHubReviewGateway, parseRequiredChecksFallback, RestGitHubTransport } from '@deskpet/gateways';
import { DEFAULT_POLICY, FileWikiReader, HarnessService, InMemoryOperationStore, StoreLockedError, randomIdGen, systemClock } from '@deskpet/harness';
import { createLlmFromEnv } from '@deskpet/llm';
import { OutputService } from '@deskpet/output';
import { ConsoleOperatorConfirm, DirectHarnessInbound, EurekaBridge, HarnessWsServer, PipelineBridge } from '@deskpet/server';

try {
  process.loadEnvFile('.env');
} catch {
  console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}
const env = process.env;
const allowGithubWrites = process.argv.includes('--allow-github-writes');
const allowEurekaWrites = process.argv.includes('--allow-eureka-writes');
const fail = (msg: string): never => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};

const token = env['HARNESS_WS_TOKEN']?.trim() || fail('HARNESS_WS_TOKEN이 비어 있어요 (16자 이상 임의 문자열)');
if (token.length < 16) fail('HARNESS_WS_TOKEN은 16자 이상이어야 해요');
const githubToken = env['GITHUB_TOKEN'] || fail('GITHUB_TOKEN이 비어 있어요');

// ------------------------------------------------------------------ wiring
// LLM Guide 호출 시간 상한은 .env LLM_GUIDE_TIMEOUT_MS로 바꿀 수 있다 (기본 8초)
const guideTimeout = Number(env['LLM_GUIDE_TIMEOUT_MS']);
const config = { ...DEFAULT_POLICY, ...(guideTimeout > 0 ? { llmGuideTimeoutMs: guideTimeout } : {}) };
const storeOpts = {
  clock: systemClock,
  ids: randomIdGen,
  capacityBytes: config.storeCapacityBytes,
  recoveryBudgetBytes: config.recoveryBudgetBytes,
  minRetentionMs: config.minRetentionMs,
  maxRecoveryAttempts: config.maxRecoveryAttempts,
};
const storePath = env['DESKPET_STORE_PATH']?.trim();
// 쓰기 모드는 영속 저장소가 있어야 한다: 메모리 저장소는 재시작 뒤 '보냈을 수 있는' 승인을 기억하지 못해 중복 전송을 막지 못한다 (감사 F-04)
if (allowGithubWrites && !storePath) fail('--allow-github-writes는 DESKPET_STORE_PATH(영속 저장소)가 있어야 켤 수 있어요');
if (allowEurekaWrites && !storePath) fail('--allow-eureka-writes는 DESKPET_STORE_PATH(영속 저장소)가 있어야 켤 수 있어요');
// Eureka 쓰기는 개발 환경(flw-d1)에서만 허용한다 (사용자 결정: 개발 환경부터)
const eurekaBase = env['EUREKA_BASE_URL']?.trim() || 'https://api.eureka.codes/flw-d1';
if (allowEurekaWrites && !/\/flw-d1\/?$/.test(eurekaBase)) fail(`--allow-eureka-writes는 개발 환경(flw-d1)에서만 켤 수 있어요 (지금: ${eurekaBase})`);
const openStore = (): InMemoryOperationStore => {
  try {
    return storePath ? InMemoryOperationStore.openDurable(storePath, storeOpts) : new InMemoryOperationStore(storeOpts);
  } catch (e) {
  // 같은 DB를 다른 Harness 프로세스가 쓰고 있으면 시작하지 않는다 (단일 기록자)
    return fail(e instanceof StoreLockedError ? `저장소를 다른 Harness 프로세스가 쓰고 있어요 (${e.holder}). 그 프로세스를 끄거나, 이미 끝났다면 ${e.lockPath} 파일을 지우세요.` : `저장소를 열지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
};
const store = openStore();

/** 서버 콘솔 확인 (TTY가 아니면 거절). 시간이 지나면 입력을 취소한다 */
const consolePrompt = async (lines: string[], question: string, signal: AbortSignal) => {
  console.log(`\n${lines.join('\n')}`);
  if (!process.stdin.isTTY) {
    console.log('  (터미널 입력을 받을 수 없어 거절합니다)');
    return '';
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question, { signal });
  } catch {
    console.log('\n  (확인 시간이 지나 보내지 않습니다)');
    return '';
  } finally {
    rl.close();
  }
};
// GitHub·Eureka 쓰기 확인은 같은 콘솔 게이트를 쓴다 (한 번에 하나씩 묻는다)
const operatorGate = new ConsoleOperatorConfirm({ prompt: consolePrompt });
const github = new GitHubReviewGateway({
  transport: new RestGitHubTransport({ token: githubToken, allowWrites: allowGithubWrites }),
  now: () => Date.now(),
  requiredChecksFallback: parseRequiredChecksFallback(env['DESKPET_REQUIRED_CHECKS']),
  ...(allowGithubWrites ? { operatorConfirm: operatorGate } : {}),
});
const eureka = createEurekaRestGateway(env, undefined, { allowWrites: allowEurekaWrites, ...(allowEurekaWrites ? { operatorConfirm: operatorGate.forEureka() } : {}) });
const llm = createLlmFromEnv(env);
// LLM Wiki (D-19): vault 루트 경로. 없으면 Wiki 검색을 하지 않는다
const wikiDir = env['DESKPET_WIKI_DIR']?.trim();
const wiki = wikiDir ? new FileWikiReader({ root: wikiDir }) : undefined;
const harness = new HarnessService({ store, github, eureka, clock: systemClock, ids: randomIdGen, config, holderId: `server-${process.pid}`, ...(llm.guideClient ? { llm: llm.guideClient } : {}), ...(wiki ? { wiki } : {}) });
const output = new OutputService(llm.outputModel ? { model: llm.outputModel, ...(llm.outputTimeoutMs ? { modelTimeoutMs: llm.outputTimeoutMs } : {}) } : {});

const server = new HarnessWsServer({
  // 파이프라인 문서 형식(harness.run 등)도 같은 서버에서 받는다 (docs/pipeline-bridge.md)
  inbound: new DirectHarnessInbound({
    harness,
    output,
    bridge: new PipelineBridge({ harness, store, output }),
    eurekaBridge: new EurekaBridge({ eureka, store, clock: systemClock, holderId: `server-${process.pid}-eureka`, ...(env['EUREKA_DEFAULT_PROCESS_ID']?.trim() ? { defaultProcessId: env['EUREKA_DEFAULT_PROCESS_ID'].trim() } : {}) }),
  }),
  store,
  token,
  ...(env['HARNESS_WS_VIEWER_TOKEN']?.trim() ? { viewerToken: env['HARNESS_WS_VIEWER_TOKEN'].trim() } : {}),
  host: env['HARNESS_WS_HOST']?.trim() || '127.0.0.1',
  port: Number(env['HARNESS_WS_PORT']) || 8787,
  allowedOrigins: (env['HARNESS_WS_ALLOWED_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  log: (l) => console.log(`[server] ${l}`),
});

async function main() {
  console.log('DeskPet Harness 서버');
  console.log(`GitHub 쓰기: ${allowGithubWrites ? '허용 (보내기 직전마다 이 콘솔에서 yes)' : '꺼짐'}  /  Eureka 쓰기: ${allowEurekaWrites ? `허용 — ${eurekaBase} (보내기 직전마다 이 콘솔에서 yes)` : '꺼짐'}`);
  console.log(llm.enabled ? `LLM: ${llm.provider} / ${llm.model}` : `LLM 꺼짐 (${llm.reason})`);
  console.log(wikiDir ? `Wiki: ${wikiDir} (wiki/ + projects/ README, Guide 참고용)` : 'Wiki 꺼짐 (DESKPET_WIKI_DIR 미설정)');
  if (storePath) {
    const cleaned = await store.maintain();
    const all = await store.listOperations();
    const needed = all.filter((o) => o.recovery === 'needed');
    console.log(`저장소: ${storePath} (operation ${all.length}건, 결과 확인 필요 ${needed.length}건, 정리 ${cleaned}건)`);
    // 이전 실행에서 결과를 모르는 쓰기는 다시 보내지 않고 읽기로만 확인한다
    for (const op of needed) {
      const rec = await harness.reconcile(op.operationId, `server-recover-${Date.now().toString(36)}`, { deadlineAt: new Date(Date.now() + 30_000).toISOString() });
      console.log(`  · 재시작 복구 ${op.action} [${op.requestId}]: ${rec.status}${rec.actionResult ? ` → ${rec.actionResult.status}` : ''}`);
    }
  } else console.log('저장소: 메모리 (DESKPET_STORE_PATH 미설정 → 서버를 끄면 기록이 사라짐)');
  await server.start();
  console.log('Ctrl+C로 종료하면 처리 중인 요청을 마친 뒤 닫습니다.');
}

let closing = false;
async function shutdown(sig: string) {
  if (closing) return;
  closing = true;
  console.log(`\n${sig} 수신 — 처리 중인 요청을 마치고 종료합니다 (최대 30초)`);
  await server.stop(30_000);
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((e: unknown) => {
  console.log(`✗ 서버 시작 실패: ${e instanceof Error ? e.message : String(e)}`);
  store.close();
  process.exit(1);
});
