/* eslint-disable no-console */
/**
 * 연결 테스트 (읽기 전용). 실제 Eureka·GitHub에 GET 요청만 보낸다. 쓰기 메서드는 호출하지 않는다.
 *
 *   pnpm smoke              # Eureka + GitHub
 *   pnpm smoke eureka       # Eureka만
 *   pnpm smoke github       # GitHub만
 *
 * .env 값: EUREKA_API_KEY, EUREKA_BASE_URL(기본 flw-d1), EUREKA_TEST_ITEM_ID(선택),
 *          GITHUB_TOKEN, GITHUB_TEST_REPO(owner/name, 선택), GITHUB_TEST_PR(선택)
 * 키·토큰 값은 출력하지 않는다.
 */
import { EurekaGateway, FetchHttpClient, GitHubReviewGateway, RestGitHubTransport, EUREKA_DEV_BASE_URL } from '@deskpet/gateways';
import { reviewFacts } from '@deskpet/harness';
import type { ErrorInfo } from '@deskpet/contracts';

try {
  process.loadEnvFile('.env');
} catch {
  console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}

const env = process.env;
const only = process.argv[2];
let failures = 0;

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string, hint?: string) => {
  failures += 1;
  console.log(`  ✗ ${msg}${hint ? `\n      → ${hint}` : ''}`);
};
const skip = (msg: string) => console.log(`  - ${msg}`);
const errText = (e?: ErrorInfo) => (e ? `${e.provisionalCode}: ${e.message}` : 'unknown error');
const deadline = () => ({ deadlineAt: new Date(Date.now() + 20_000).toISOString() });

async function eureka() {
  console.log('\n[Eureka]');
  const key = env['EUREKA_API_KEY'];
  const baseUrl = env['EUREKA_BASE_URL'] || EUREKA_DEV_BASE_URL;
  if (!key) return bad('EUREKA_API_KEY가 비어 있어요');
  console.log(`  base URL: ${baseUrl}  (키 길이 ${key.length})`);
  const gw = new EurekaGateway({ http: new FetchHttpClient(baseUrl, () => ({ 'x-api-key': key })), now: () => Date.now() });

  const s = await gw.checkSession(deadline());
  if (!s.ok) {
    const code = s.result.error?.provisionalCode;
    return bad(
      `세션 확인 실패 — ${errText(s.result.error)}`,
      code === 'EUREKA_AUTH_ERROR' ? '키가 틀렸거나 base URL(flw-d1 개발 / flw-v1 운영)이 키와 맞지 않을 수 있어요' : '네트워크 또는 base URL을 확인하세요',
    );
  }
  ok(`세션 확인: workspace sid=${s.data!.sid}, roles=${s.data!.roles.join(',') || '-'}`);

  const p = await gw.listProcesses(deadline());
  if (p.ok) ok(`템플릿 ${p.data!.length}개: ${p.data!.slice(0, 3).map((x) => x.name.trim()).join(', ')}${p.data!.length > 3 ? ' …' : ''}`);
  else bad(`템플릿 목록 실패 — ${errText(p.result.error)}`);

  const t = await gw.listTasks({ limit: 100 }, deadline());
  if (!t.ok) return bad(`업무 목록 실패 — ${errText(t.result.error)}`);
  const items = t.data!.items;
  ok(`업무 ${items.length}건 (total=${t.data!.total ?? '?'}, completeness=${t.data!.completeness})`);
  for (const i of items.slice(0, 5)) {
    const stages = i.stages.map((st) => `${st.name || st.stageId}:${st.status}`).join(' / ');
    console.log(`      · [${i.itemId}] ${i.name} — ${i.computedState}${i.dueAt ? `, due ${i.dueAt}` : ''}${stages ? `\n        stages: ${stages}` : ''}`);
  }
  const withDescription = items.filter((i) => i.description !== undefined).length;
  skip(`description 필드가 있는 업무 ${withDescription}/${items.length}건 (README C-08 확인용)`);

  const itemId = env['EUREKA_TEST_ITEM_ID'] || items[0]?.itemId;
  if (!itemId) return skip('상태를 조회할 업무가 없어요');
  const stageId = items.find((i) => i.itemId === itemId)?.stages[0]?.stageId;
  const st = await gw.getTaskState({ itemId, ...(stageId ? { stageId } : {}) }, deadline());
  if (st.ok) ok(`업무 ${itemId} 상태: ${st.data!.itemStatus} (${st.data!.doneStages}/${st.data!.totalStages} 단계 완료)${st.data!.stage ? `, 첫 단계 ${st.data!.stage.status}` : ''}`);
  else bad(`업무 ${itemId} 상태 조회 실패 — ${errText(st.result.error)}`);
}

async function github() {
  console.log('\n[GitHub]');
  const token = env['GITHUB_TOKEN'];
  if (!token) return bad('GITHUB_TOKEN이 비어 있어요');
  console.log(`  토큰 길이 ${token.length}, 쓰기 비활성(allowWrites=false)`);
  const transport = new RestGitHubTransport({ token, allowWrites: false });
  const repoArg = env['GITHUB_TEST_REPO'];
  const [owner, name] = (repoArg ?? '').split('/');
  const repository = owner && name ? { owner, name } : undefined;

  try {
    const v = await transport.read({ kind: 'viewer', repository: repository ?? { owner: '_', name: '_' } }, { timeoutMs: 15_000 });
    ok(`토큰 사용자: ${v.login}${repository ? `, ${repoArg} 권한: ${v.permission}` : ''}`);
    if (repository && v.permission === 'unknown') skip('저장소 권한을 조회하지 못했어요 → 승인 전 검사에서 permission_unverified로 차단됩니다 (D-11)');
  } catch (e) {
    return bad(`토큰 확인 실패 — ${(e as Error).message}`, '토큰이 만료됐거나 잘못 복사됐을 수 있어요');
  }

  if (!repository) return skip('GITHUB_TEST_REPO가 없어서 저장소 조회는 건너뜁니다');
  const prNumber = Number(env['GITHUB_TEST_PR']);
  if (!prNumber) return skip('GITHUB_TEST_PR이 없어서 PR 리뷰 조회는 건너뜁니다');

  const gw = new GitHubReviewGateway({ transport, now: () => Date.now() });
  const ctx = await gw.getReviewContext({ repository, prNumber, requestedSections: ['changes', 'checks', 'reviews'], ...deadline() }, deadline());
  if (!ctx.prBasics) return bad(`PR ${repoArg}#${prNumber} 조회 실패 — ${errText(ctx.error)}`, 'fine-grained 토큰이면 해당 저장소의 Pull requests·Contents·Checks 읽기 권한이 필요해요');
  ok(`PR #${prNumber} "${ctx.prBasics.title}" — ${ctx.prBasics.state}${ctx.prBasics.draft ? ' (draft)' : ''}, head ${ctx.initialHeadSha?.slice(0, 7)}, consistency=${ctx.consistency}`);
  for (const s of ctx.sections) {
    const line = `${s.sectionKind}: ${s.availability}/${s.completeness}${s.versionEvidence?.headSha ? ` @${s.versionEvidence.headSha.slice(0, 7)}` : ''}`;
    if (s.availability === 'available') ok(line);
    else bad(line, s.error ? errText(s.error) : undefined);
  }
  const f = reviewFacts(ctx, ctx.initialHeadSha);
  if (f.changes) skip(`변경 파일 ${f.changes.fileCount}개 (+${f.changes.additions}/-${f.changes.deletions})`);
  if (f.checks) skip(`필수 검사 설정: ${f.checks.requiredState}${f.checks.required.length ? ` [${f.checks.required.join(', ')}]` : ''}, 실패 ${f.checks.failing.length}, 진행 중 ${f.checks.pending.length}`);
  if (f.copilot) skip(`Copilot 리뷰: ${f.copilot.status}`);
  skip(`지금 승인한다면 차단 사유: ${f.approvalBlockers.length ? f.approvalBlockers.join(', ') : '없음'} (조회만 했고 승인은 하지 않았어요)`);
}

const run = async () => {
  console.log('DeskPet 연결 테스트 (읽기 전용 — 쓰기 요청은 보내지 않습니다)');
  if (!only || only === 'eureka') await eureka().catch((e) => bad(`Eureka 예외 — ${(e as Error).message}`));
  if (!only || only === 'github') await github().catch((e) => bad(`GitHub 예외 — ${(e as Error).message}`));
  console.log(failures ? `\n실패 ${failures}건` : '\n모두 통과');
  process.exitCode = failures ? 1 : 0;
};
void run();
