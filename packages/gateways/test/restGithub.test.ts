import { describe, expect, it } from 'vitest';
import { GitHubReviewGateway, GitHubTransportError, RestGitHubTransport } from '@deskpet/gateways';
import { PR, REPO, SHA_A, T0 } from '../../../tests/support/builders.js';

type Route = (url: URL, init: RequestInit) => { status: number; body: unknown } | undefined;

function fakeFetch(routes: Route[], seen: { method: string; url: string; auth: string | null }[] = []) {
  return (async (u: URL, init: RequestInit) => {
    seen.push({ method: String(init.method), url: u.pathname + u.search, auth: new Headers(init.headers).get('authorization') });
    for (const r of routes) {
      const hit = r(u, init);
      if (hit) return new Response(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body), { status: hit.status });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as unknown as typeof fetch;
}

const base = `/repos/${REPO.owner}/${REPO.name}`;
const golden: Route[] = [
  (u) => (u.pathname === `${base}/pulls/${PR}` ? { status: 200, body: { title: 'feat', user: { login: 'teammate' }, state: 'open', draft: false, merged_at: null, head: { sha: SHA_A }, base: { ref: 'main', sha: 'b'.repeat(40) } } } : undefined),
  (u) => (u.pathname === `${base}/pulls/${PR}/files` ? { status: 200, body: [{ filename: 'a.ts', status: 'modified', additions: 3, deletions: 1 }] } : undefined),
  (u) => (u.pathname === `${base}/commits/${SHA_A}/check-runs` ? { status: 200, body: { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: SHA_A }] } } : undefined),
  (u) => (u.pathname === `${base}/branches/main/protection/required_status_checks` ? { status: 200, body: { contexts: ['test'], checks: [{ context: 'test' }] } } : undefined),
  (u) => (u.pathname === `${base}/pulls/${PR}/reviews` ? { status: 200, body: [{ id: 77, user: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'COMMENTED', commit_id: SHA_A, submitted_at: T0, body: 'nit' }] } : undefined),
  (u) => (u.pathname === '/user' ? { status: 200, body: { login: 'gomdori' } } : undefined),
  (u) => (u.pathname === `${base}/collaborators/gomdori/permission` ? { status: 200, body: { permission: 'write', role_name: 'write' } } : undefined),
];

describe('RestGitHubTransport', () => {
  it('maps REST responses into a review context and sends a bearer token', async () => {
    const seen: { method: string; url: string; auth: string | null }[] = [];
    const t = new RestGitHubTransport({ token: 'tok', fetchImpl: fakeFetch(golden, seen) });
    const gw = new GitHubReviewGateway({ transport: t, now: () => Date.parse(T0) });
    const ctx = await gw.getReviewContext({ repository: { ...REPO }, prNumber: PR, requestedSections: ['changes', 'checks', 'reviews'], deadlineAt: '2099-01-01T00:00:00.000Z' }, { deadlineAt: '2099-01-01T00:00:00.000Z' });
    expect(ctx.prBasics).toMatchObject({ headSha: SHA_A, state: 'open', author: 'teammate' });
    const checks = ctx.sections.find((s) => s.sectionKind === 'checks');
    expect(checks?.sectionKind === 'checks' && checks.data!.requiredChecks).toEqual({ state: 'configured', names: ['test'] });
    // 파일 API는 SHA 근거가 없으므로 unverified (C-10 / inference)
    expect(ctx.consistency).toBe('unverified');
    expect(ctx.viewer).toEqual({ login: 'gomdori', permission: 'write' });
    expect(seen.every((s) => s.method === 'GET')).toBe(true);
    expect(seen[0]!.auth).toBe('Bearer tok');
  });

  it('distinguishes unprotected branch from unreadable protection', async () => {
    const notProtected: Route = (u) => (u.pathname.endsWith('/required_status_checks') ? { status: 404, body: { message: 'Branch not protected' } } : undefined);
    const t1 = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([notProtected]) });
    expect(await t1.read({ kind: 'required_checks', repository: { ...REPO }, baseRef: 'main' }, { timeoutMs: 1000 })).toEqual({ state: 'none_configured' });
    const forbidden: Route = (u) => (u.pathname.endsWith('/required_status_checks') ? { status: 403, body: { message: 'Resource not accessible by integration' } } : undefined);
    const t2 = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([forbidden]) });
    await expect(t2.read({ kind: 'required_checks', repository: { ...REPO }, baseRef: 'main' }, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('refuses to send approvals while writes are disabled', async () => {
    const seen: { method: string; url: string; auth: string | null }[] = [];
    const t = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch(golden, seen) });
    const e = await t.submitApproval({ repository: { ...REPO }, prNumber: PR, commitId: SHA_A, event: 'APPROVE' }, { timeoutMs: 1000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GitHubTransportError);
    expect(e).toMatchObject({ kind: 'not_sent', proof: 'writes_disabled' });
    expect(seen.length).toBe(0);
  });

  it('maps 401 to auth and rate-limit 403 to transient', async () => {
    const t = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([() => ({ status: 401, body: { message: 'Bad credentials' } })]) });
    await expect(t.read({ kind: 'pr', repository: { ...REPO }, prNumber: PR }, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'auth' });
    const t2 = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([() => ({ status: 403, body: { message: 'API rate limit exceeded' } })]) });
    await expect(t2.read({ kind: 'pr', repository: { ...REPO }, prNumber: PR }, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'transient' });
  });

  it('requires a token', () => {
    expect(() => new RestGitHubTransport({ token: '' })).toThrow(/GITHUB_TOKEN/);
  });
});
