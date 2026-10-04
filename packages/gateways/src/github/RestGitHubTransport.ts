import type { ViewerPermission } from '@deskpet/contracts';
import { FetchHttpClient, HttpTransportError, type HttpClient, type HttpResponse } from '../http.js';
import { parseErrorBody } from '../result.js';
import {
  GitHubTransportError,
  type GitHubTransport,
  type TransportReadQuery,
  type TransportReadResultMap,
  type TransportSubmitResponse,
} from './GitHubTransport.js';

/**
 * GitHub REST adapter (GitHubTransport 구현 후보 — MCP와의 선택은 미정, README C-10).
 * 근거: https://docs.github.com/en/rest/pulls , /checks/runs , /branches/branch-protection , /collaborators
 *
 * 안전장치: `allowWrites`가 false(기본)이면 submitApproval은 전송하지 않고 not_sent 오류를 낸다.
 * 사용자의 명시적 허락 전에는 쓰기를 활성화하지 않는다.
 *
 * inference / 미정
 * - 파일 목록 API는 SHA를 돌려주지 않으므로 changes section의 버전 근거를 만들지 않는다(unverified).
 * - 리뷰 상세 코멘트(pulls/{n}/comments)는 아직 조회하지 않는다.
 * - 필수 검사는 branch protection만 본다. rulesets는 미조회. 권한이 없어 조회 못 하면 unknown.
 */
export interface RestGitHubTransportOptions {
  token: string;
  baseUrl?: string;
  allowWrites?: boolean;
  http?: HttpClient;
  fetchImpl?: typeof fetch;
}

export class RestGitHubTransport implements GitHubTransport {
  readonly mode = 'rest' as const;
  private readonly http: HttpClient;
  private readonly allowWrites: boolean;

  constructor(o: RestGitHubTransportOptions) {
    if (!o.token) throw new Error('GITHUB_TOKEN is not set (.env)');
    const token = o.token;
    this.allowWrites = o.allowWrites ?? false;
    this.http =
      o.http ??
      new FetchHttpClient(
        o.baseUrl ?? 'https://api.github.com',
        () => ({
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'deskpet-harness-mvp',
        }),
        o.fetchImpl,
      );
  }

  async read<K extends TransportReadQuery['kind']>(
    query: Extract<TransportReadQuery, { kind: K }>,
    c: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<TransportReadResultMap[K]> {
    return (await this.readAny(query as TransportReadQuery, c)) as TransportReadResultMap[K];
  }

  private async readAny(q: TransportReadQuery, c: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    const repo = `/repos/${enc(q.repository.owner)}/${enc(q.repository.name)}`;
    switch (q.kind) {
      case 'pr': {
        const b = await this.get(`${repo}/pulls/${q.prNumber}`, c);
        return {
          title: String(b.title ?? ''),
          author: String(b.user?.login ?? ''),
          state: b.merged_at ? 'merged' : b.state === 'closed' ? 'closed' : 'open',
          draft: Boolean(b.draft),
          headSha: String(b.head?.sha),
          baseRef: String(b.base?.ref),
          ...(b.base?.sha ? { baseSha: String(b.base.sha) } : {}),
        } satisfies TransportReadResultMap['pr'];
      }
      case 'files': {
        const b = await this.get(`${repo}/pulls/${q.prNumber}/files`, c, { per_page: String(q.perPage), page: String(q.page) });
        const list = Array.isArray(b) ? b : [];
        return {
          files: list.map((f: Gh) => ({ path: String(f.filename), status: String(f.status), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })),
          hasMore: list.length >= q.perPage,
        } satisfies TransportReadResultMap['files'];
      }
      case 'check_runs': {
        const b = await this.get(`${repo}/commits/${enc(q.ref)}/check-runs`, c, { per_page: String(q.perPage), page: String(q.page) });
        const runs: Gh[] = Array.isArray(b.check_runs) ? b.check_runs : [];
        return {
          runs: runs.map((r) => ({
            name: String(r.name),
            status: (['queued', 'in_progress', 'completed'].includes(r.status) ? r.status : 'queued') as 'queued' | 'in_progress' | 'completed',
            conclusion: r.conclusion ?? null,
            ...(r.head_sha ? { headSha: String(r.head_sha) } : {}),
          })),
          resolvedHeadSha: q.ref,
          hasMore: typeof b.total_count === 'number' ? q.page * q.perPage < b.total_count : false,
        } satisfies TransportReadResultMap['check_runs'];
      }
      case 'required_checks': {
        const res = await this.raw('GET', `${repo}/branches/${enc(q.baseRef)}/protection/required_status_checks`, c);
        if (res.status === 404 && /not protected/i.test(res.bodyText)) return { state: 'none_configured' };
        if (res.status === 404 && /required status checks not enabled/i.test(res.bodyText)) return { state: 'none_configured' };
        if (res.status >= 400) {
          // 권한 부족 시 GitHub는 404/403을 돌려준다 → 설정 없음으로 추정하지 않는다
          throw new GitHubTransportError('unsupported', `required checks not readable (${res.status}): ${parseErrorBody(res.bodyText).slice(0, 120)}`);
        }
        const b = JSON.parse(res.bodyText) as Gh;
        const names = new Set<string>([...(b.contexts ?? []), ...((b.checks ?? []) as Gh[]).map((x) => String(x.context))]);
        return { state: 'configured', names: [...names] };
      }
      case 'reviews': {
        const b = await this.get(`${repo}/pulls/${q.prNumber}/reviews`, c, { per_page: String(q.perPage), page: String(q.page) });
        const list = Array.isArray(b) ? b : [];
        return {
          reviews: list.map((r: Gh) => ({
            reviewId: String(r.id),
            author: String(r.user?.login ?? ''),
            state: String(r.state) as 'APPROVED',
            ...(r.commit_id ? { commitSha: String(r.commit_id) } : {}),
            ...(r.submitted_at ? { submittedAt: new Date(r.submitted_at).toISOString() } : {}),
            comments: r.body ? [{ body: String(r.body) }] : [],
          })),
          hasMore: list.length >= q.perPage,
        } satisfies TransportReadResultMap['reviews'];
      }
      case 'viewer': {
        const me = await this.get('/user', c);
        const login = String(me.login);
        let permission: ViewerPermission = 'unknown';
        try {
          const p = await this.get(`${repo}/collaborators/${enc(login)}/permission`, c);
          const role = String(p.role_name ?? p.permission ?? 'unknown');
          permission = (['admin', 'maintain', 'write', 'triage', 'read', 'none'].includes(role) ? role : 'unknown') as ViewerPermission;
        } catch {
          permission = 'unknown';
        }
        return { login, permission } satisfies TransportReadResultMap['viewer'];
      }
    }
  }

  async submitApproval(
    cmd: { repository: { owner: string; name: string }; prNumber: number; commitId: string; event: 'APPROVE'; body?: string },
    c: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<TransportSubmitResponse> {
    if (!this.allowWrites) {
      // 전송하지 않았음이 확실하다
      throw new GitHubTransportError('not_sent', 'writes disabled (allowWrites=false)', 'writes_disabled');
    }
    const path = `/repos/${enc(cmd.repository.owner)}/${enc(cmd.repository.name)}/pulls/${cmd.prNumber}/reviews`;
    const res = await this.raw('POST', path, c, { commit_id: cmd.commitId, event: cmd.event, ...(cmd.body ? { body: cmd.body } : {}) });
    if (res.status >= 400) throw mapStatus(res);
    const b = JSON.parse(res.bodyText) as Gh;
    return { kind: 'rest', reviewId: String(b.id), state: String(b.state), commitId: String(b.commit_id), submittedAt: new Date(b.submitted_at ?? Date.now()).toISOString(), user: String(b.user?.login ?? '') };
  }

  // ------------------------------------------------------------ helpers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async get(path: string, c: { timeoutMs: number; signal?: AbortSignal }, query?: Record<string, string>): Promise<any> {
    const res = await this.raw('GET', path, c, undefined, query);
    if (res.status >= 400) throw mapStatus(res);
    return JSON.parse(res.bodyText);
  }

  private async raw(method: 'GET' | 'POST', path: string, c: { timeoutMs: number; signal?: AbortSignal }, body?: unknown, query?: Record<string, string>): Promise<HttpResponse> {
    try {
      return await this.http.request({ method, path, timeoutMs: c.timeoutMs, ...(c.signal ? { signal: c.signal } : {}), ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) });
    } catch (e) {
      if (e instanceof HttpTransportError) {
        throw e.failure.kind === 'not_sent'
          ? new GitHubTransportError('not_sent', e.message, e.failure.proof)
          : new GitHubTransportError('no_response', e.message);
      }
      throw e;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gh = any;

function mapStatus(res: HttpResponse): GitHubTransportError {
  const msg = `${res.status} ${parseErrorBody(res.bodyText).slice(0, 200)}`;
  if (res.status === 401) return new GitHubTransportError('auth', msg);
  if (res.status === 403) return /rate limit/i.test(res.bodyText) ? new GitHubTransportError('transient', msg) : new GitHubTransportError('auth', msg);
  if (res.status === 404) return new GitHubTransportError('not_found', msg);
  if (res.status === 422) return new GitHubTransportError('invalid', msg);
  if (res.status >= 500) return new GitHubTransportError('transient', msg);
  return new GitHubTransportError('invalid', msg);
}

const enc = encodeURIComponent;
