import { approvalBlockers, type ReviewContext, type ViewerPermission } from '@deskpet/contracts';

/**
 * ReviewContext → 출력용 구조화 사실. 모델 요약으로 원 증거를 대체하지 않는다.
 * S-03: 리뷰 없음·오래됨·조회 불가를 분리한다. 오래된 Copilot 리뷰를 최신 리뷰처럼 표현하지 않는다.
 */
export interface ReviewFacts {
  repository: string;
  prNumber: number;
  title?: string;
  prState?: string;
  draft?: boolean;
  headSha?: string;
  observedHeadSha?: string;
  consistency: ReviewContext['consistency'];
  stoppedBeforeDetails: boolean;
  sections: Record<string, { availability: string; completeness: string; errorCode?: string }>;
  changes?: { fileCount: number; additions: number; deletions: number; comparisonBase: string; paths: string[] };
  checks?: {
    requiredState: 'configured' | 'none_configured' | 'unknown';
    required: string[];
    runs: { name: string; status: string; conclusion: string | null }[];
    failing: string[];
    pending: string[];
  };
  copilot?: {
    status: 'current' | 'stale_only' | 'none' | 'unavailable';
    reviewedSha?: string;
    comments: { path?: string; line?: number; severity?: string; body: string }[];
    blockingComments: number;
  };
  approvalBlockers: string[];
}

export function reviewFacts(ctx: ReviewContext, expectedHeadSha?: string): ReviewFacts {
  const head = ctx.initialHeadSha;
  const sections: ReviewFacts['sections'] = {};
  for (const s of ctx.sections) {
    sections[s.sectionKind] = { availability: s.availability, completeness: s.completeness, ...(s.error ? { errorCode: s.error.provisionalCode } : {}) };
  }
  const f: ReviewFacts = {
    repository: `${ctx.repository.owner}/${ctx.repository.name}`,
    prNumber: ctx.prNumber,
    consistency: ctx.consistency,
    stoppedBeforeDetails: ctx.stoppedBeforeDetails,
    sections,
    approvalBlockers: [],
    ...(ctx.prBasics ? { title: ctx.prBasics.title, prState: ctx.prBasics.state, draft: ctx.prBasics.draft } : {}),
    ...(head ? { headSha: head } : {}),
    ...(ctx.observedHeadSha ? { observedHeadSha: ctx.observedHeadSha } : {}),
  };
  const changes = ctx.sections.find((s) => s.sectionKind === 'changes');
  if (changes?.sectionKind === 'changes' && changes.data) {
    f.changes = {
      fileCount: changes.data.files.length,
      additions: changes.data.files.reduce((a, x) => a + x.additions, 0),
      deletions: changes.data.files.reduce((a, x) => a + x.deletions, 0),
      comparisonBase: changes.data.comparison.base,
      paths: changes.data.files.map((x) => x.path),
    };
  }
  const checks = ctx.sections.find((s) => s.sectionKind === 'checks');
  if (checks?.sectionKind === 'checks' && checks.data) {
    const req = checks.data.requiredChecks;
    f.checks = {
      requiredState: req.state,
      required: req.state === 'configured' ? req.names : [],
      runs: checks.data.runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })),
      failing: checks.data.runs.filter((r) => r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion ?? '')).map((r) => r.name),
      pending: checks.data.runs.filter((r) => r.status !== 'completed').map((r) => r.name),
    };
  }
  const reviews = ctx.sections.find((s) => s.sectionKind === 'reviews');
  if (reviews?.sectionKind === 'reviews') {
    if (!reviews.data) f.copilot = { status: 'unavailable', comments: [], blockingComments: 0 };
    else {
      const cop = reviews.data.reviews.filter((r) => r.source === 'copilot');
      const current = cop.filter((r) => head && r.commitSha === head);
      if (current.length > 0) {
        const comments = current.flatMap((r) => r.comments);
        f.copilot = {
          status: 'current',
          reviewedSha: head!,
          comments,
          blockingComments: comments.filter((c) => ['high', 'critical', 'blocking'].includes(c.severity ?? '')).length,
        };
      } else {
        f.copilot = { status: cop.length > 0 ? 'stale_only' : 'none', comments: [], blockingComments: 0 };
      }
    }
  }
  if (expectedHeadSha !== undefined || checks) {
    f.approvalBlockers = approvalBlockers({
      ...(ctx.prBasics ? { pr: ctx.prBasics } : {}),
      ...(checks?.sectionKind === 'checks' && checks.data ? { checks: checks.data } : {}),
      expectedHeadSha: expectedHeadSha ?? head ?? '',
      viewerPermission: (ctx.viewer?.permission as ViewerPermission | undefined) ?? 'unknown',
      ...(ctx.viewer ? { viewerLogin: ctx.viewer.login } : {}),
    });
    if (ctx.consistency === 'changed' && !f.approvalBlockers.includes('sha_changed')) f.approvalBlockers.push('sha_changed');
  }
  return f;
}
