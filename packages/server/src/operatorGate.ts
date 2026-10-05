import { GitHubTransportError, type GitHubTransport } from '@deskpet/gateways';

/**
 * 운영자 확인 게이트 (서버 콘솔). GitHub 쓰기를 서버 실행 옵션으로 켠 경우에만 쓴다.
 * 실제 전송 직전에 대상(저장소·PR·커밋)을 보여 주고 정확히 `yes`를 입력해야 보낸다.
 * DurableAck 이후에 묻지만, 거절하면 전송하지 않았음이 확실하므로 not_sent(operator_declined)로 기록된다.
 * 클라이언트(파이프라인·데모)는 이 확인을 건너뛸 수 없다. 여러 요청이 동시에 와도 한 번에 하나씩 묻는다.
 */
export type OperatorPrompt = (lines: string[], question: string) => Promise<string>;

export class OperatorGatedTransport implements GitHubTransport {
  readonly mode: GitHubTransport['mode'];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly inner: GitHubTransport,
    private readonly prompt: OperatorPrompt,
  ) {
    this.mode = inner.mode;
  }

  get writesEnabled(): boolean {
    return this.inner.writesEnabled;
  }

  read: GitHubTransport['read'] = (q, c) => this.inner.read(q, c);

  submitApproval: GitHubTransport['submitApproval'] = (cmd, c) => {
    const run = async () => {
      const typed = await this.prompt(
        ['⚠ 실제 GitHub 승인 요청을 보내려고 합니다.', `  저장소: ${cmd.repository.owner}/${cmd.repository.name}  PR: #${cmd.prNumber}`, `  커밋: ${cmd.commitId}  행위: ${cmd.event}`],
        '  보내려면 yes를 입력하세요 (그 외 입력은 취소): ',
      );
      if (typed.trim() !== 'yes') throw new GitHubTransportError('not_sent', 'operator declined before sending', 'operator_declined');
      return this.inner.submitApproval(cmd, c);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  };
}
