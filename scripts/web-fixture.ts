/* eslint-disable no-console */
/**
 * 웹 화면 확인용 fixture 서버 — 실제 GitHub·Eureka 없이 여러 상태(완료·실패·결과 불명·확인 대기)를 만들어
 * viewer로 구독할 수 있게 연다. 외부로 아무것도 보내지 않는다.
 *
 *   pnpm web:fixture        # ws://127.0.0.1:8788, 보기 전용 토큰 fixture-viewer-token-123
 *   pnpm web:dev            # 다른 터미널, http://127.0.0.1:5173 에서 위 주소·토큰 입력
 */
import { OutputService } from '@deskpet/output';
import { DirectHarnessInbound, HarnessWsServer } from '@deskpet/server';
import { answer, askApproval, review } from '../tests/support/flows.js';
import { createWorld } from '../tests/support/world.js';

const VIEWER = 'fixture-viewer-token-123';
const w = createWorld();
const step = () => w.clock.advance(20_000);

await review(w, 'req-review-1'); // 완료
step();
const q1 = await askApproval(w, 'req-approve-1');
step();
w.github.failNextSubmit('drop_after_apply'); // 전송 후 응답 유실 → 결과 불명
await answer(w, q1, '응, 승인해');
step();
w.github.failNextRead('pr', 'auth'); // 권한 오류 → 실패
await review(w, 'req-review-2');
step();
const q2 = await askApproval(w, 'req-approve-2'); // 확인 대기
await w.deliverQuestion(q2);

const server = new HarnessWsServer({
  inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }),
  store: w.store,
  token: 'fixture-pipeline-token-not-used',
  viewerToken: VIEWER,
  port: Number(process.env['WEB_FIXTURE_PORT']) || 8788,
  allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
  log: (l) => console.log(`[fixture] ${l}`),
});
const { port } = await server.start();
console.log(`fixture 서버: ws://127.0.0.1:${port}  보기 전용 토큰: ${VIEWER}  (fixture 전용 값, 실제 토큰 아님)`);
process.on('SIGINT', () => void server.stop(1_000).then(() => process.exit(0)));
