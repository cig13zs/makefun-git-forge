// The GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues, comments and
// pull requests, plus the status/auth/JSON discipline the protocol group checks. Every route builds
// the same JSON shapes api.github.com builds, because the suite compares them as closely as the data.
//
// Ownership is the whole access model: a repository answers to exactly one owner login (the first one
// any caller names it under), the bearer token must be the one this forge was started with, and a
// repository that is not yours is a 404 rather than a 403.

import {
  base64Of,
  empty,
  errorJson,
  fromBase64,
  isSha,
  json,
  notFound,
  unprocessable,
  type Out,
  type Req,
} from './http.ts';
import { MODE_FILE, type Sha } from './git.ts';
import type { Comment, Forge, Issue, Label, Pull, Repo } from './store.ts';

/** What the REST handlers need from the process: the store, and the one bearer token it accepts. */
export interface RestDeps {
  forge: Forge;
  token: string;
}

/** A page as a caller asked for it: which one, and how big. */
interface Page {
  page: number;
  perPage: number;
}

/** Read `page` and `per_page` off a query, clamped the way GitHub clamps them. */
function pageOf(req: Req): Page {
  const rawPage = Number.parseInt(req.query.get('page') ?? '1', 10);
  const rawPer = Number.parseInt(req.query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const perPage = Number.isFinite(rawPer) && rawPer > 0 ? Math.min(rawPer, 100) : 30;
  return { page, perPage };
}

/** Slice a list to one page. */
function paginate<T>(items: readonly T[], p: Page): T[] {
  const start = (p.page - 1) * p.perPage;
  return items.slice(start, start + p.perPage);
}

/**
 * The `Link` header a paged list carries. The suite follows `rel="next"` to prove paging is real, so
 * the URLs are absolute and keep the caller's own `per_page`.
 */
function linkHeader(origin: string, path: string, p: Page, total: number): Record<string, string> {
  const last = Math.max(1, Math.ceil(total / p.perPage));
  const url = (n: number): string => `<${origin}${path}?per_page=${p.perPage}&page=${n}>`;
  const parts: string[] = [];
  if (p.page < last) parts.push(`${url(p.page + 1)}; rel="next"`, `${url(last)}; rel="last"`);
  if (p.page > 1) parts.push(`${url(1)}; rel="first"`, `${url(p.page - 1)}; rel="prev"`);
  return parts.length === 0 ? {} : { link: parts.join(', ') };
}

/** The JSON for a user: `{login, id, ...}`, the shape every record embeds. */
function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

/** The JSON for a label. */
function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    url: `/api/v3/labels/${label.name}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description === '' ? null : label.description,
  };
}

/** The JSON for a repository. */
function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner, 1000),
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    description: repo.description === '' ? null : repo.description,
    fork: false,
    url: base,
    archive_url: `${base}/{archive_format}{/ref}`,
    git_refs_url: `${base}/git/refs{/sha}`,
    branches_url: `${base}/branches{/branch}`,
    commits_url: `${base}/commits{/sha}`,
    contents_url: `${base}/contents/{+path}`,
    issues_url: `${base}/issues{/number}`,
    pulls_url: `${base}/pulls{/number}`,
    labels_url: `${base}/labels{/name}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    default_branch_sha: tip ?? null,
  };
}

/** The JSON for a branch. */
function branchJson(repo: Repo, name: string, sha: Sha, origin: string): Record<string, unknown> {
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    name,
    commit: {
      sha,
      node_id: `C_${sha.slice(0, 12)}`,
      url: `${base}/commits/${sha}`,
    },
    _links: {
      self: `${base}/branches/${name}`,
      html: `${origin}/${repo.owner}/${repo.name}/tree/${name}`,
    },
    protected: false,
    protection_url: `${base}/branches/${name}/protection`,
  };
}

/** The JSON for one commit. */
function commitJson(forge: Forge, repo: Repo, sha: Sha, origin: string): Record<string, unknown> {
  const commit = forge.commit(repo, sha);
  if (commit === undefined) return { sha };
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    url: `${base}/commits/${sha}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${sha}`,
    commit: {
      author: {
        name: commit.author.name,
        email: commit.author.email,
        date: new Date(commit.author.ts * 1000).toISOString(),
      },
      committer: {
        name: commit.committer.name,
        email: commit.committer.email,
        date: new Date(commit.committer.ts * 1000).toISOString(),
      },
      message: commit.message,
      tree: { sha: commit.tree, url: `${base}/git/trees/${commit.tree}` },
    },
    author: userJson(commit.author.name === '' ? repo.owner : repo.owner, 1000),
    committer: userJson(repo.owner, 1000),
    parents: commit.parents.map((p) => ({ sha: p, url: `${base}/commits/${p}` })),
  };
}

/** The JSON for one issue. */
function issueJson(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body === '' ? null : issue.body,
    state: issue.state,
    state_reason: issue.closedAt === null ? null : 'completed',
    locked: false,
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((l) => l.name === name);
      return labelJson(found ?? { id: 0, name, color: 'ededed', description: '' });
    }),
    user: userJson(issue.login, issue.userId),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    closed_by: null,
    author_association: 'OWNER',
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    labels_url: `${base}/issues/${issue.number}/labels`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The JSON for one comment. */
function commentJson(repo: Repo, number: number, comment: Comment, origin: string): Record<string, unknown> {
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `${base}/issues/comments/${comment.id}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    issue_url: `${base}/issues/${number}`,
    user: userJson(comment.login, comment.userId),
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    author_association: 'OWNER',
  };
}

/** A ref side of a pull request: `{label, ref, sha, user}`. */
function pullSide(repo: Repo, ref: string, sha: Sha): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner, 1000),
    repo: null,
  };
}

/** The JSON for one pull request. */
function pullJson(forge: Forge, repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const mergeable = pull.merged ? false : mergeability(forge, repo, pull).ok;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    locked: false,
    title: pull.title,
    body: pull.body === '' ? null : pull.body,
    user: userJson(pull.login, pull.userId),
    labels: [],
    milestone: null,
    head: pullSide(repo, pull.headRef, pull.headSha),
    base: pullSide(repo, pull.baseRef, pull.baseSha),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    rebaseable: mergeable,
    comments: pull.comments,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    url: `${base}/pulls/${pull.number}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    issue_url: `${base}/issues/${pull.number}`,
    diff_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    statuses_url: `${base}/statuses/${pull.headSha}`,
  };
}

// ---------------------------------------------------------------------------- diffs and merges

/** One file's changed status between two trees. */
interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  sha: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  previousFilename?: string;
}

/** The lines of a blob, or none when the blob is not readable. */
function linesOf(forge: Forge, repo: Repo, sha: Sha | undefined): string[] {
  if (sha === undefined) return [];
  const obj = forge.object(repo, sha);
  if (obj === undefined || obj.type !== 'blob') return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  return text.split('\n');
}

/**
 * Count the lines one side added and removed against the other, with a longest-common-subsequence
 * table. Small files only: past the table's budget it falls back to counting every line on each side,
 * which keeps the numbers integers and non-negative.
 */
function countLines(a: readonly string[], b: readonly string[]): { additions: number; deletions: number } {
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  if (n * m > 4_000_000) return { additions: m, deletions: n };
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => table[i * (m + 1) + j] as number;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const common = at(0, 0);
  return { additions: m - common, deletions: n - common };
}

/** A unified-diff hunk for a whole file, which is enough for a reviewer and exact for a test. */
function patchOf(filename: string, a: readonly string[], b: readonly string[]): string {
  const head = `@@ -1,${a.length} +1,${b.length} @@\n`;
  const removed = a.map((line) => `-${line}`).join('\n');
  const added = b.map((line) => `+${line}`).join('\n');
  const body = [removed, added].filter((s) => s !== '').join('\n');
  return `--- a/${filename}\n+++ b/${filename}\n${head}${body === '' ? '' : `${body}\n`}`;
}

/** Every file that differs between two commits, as the pull request files API lists them. */
function diffCommits(forge: Forge, repo: Repo, baseSha: Sha | undefined, headSha: Sha | undefined): FileChange[] {
  const before = baseSha === undefined ? new Map<string, { mode: string; sha: Sha }>() : forge.filesOf(repo, baseSha);
  const after = headSha === undefined ? new Map<string, { mode: string; sha: Sha }>() : forge.filesOf(repo, headSha);
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const changes: FileChange[] = [];
  for (const filename of [...paths].sort()) {
    const from = before.get(filename);
    const to = after.get(filename);
    if (from !== undefined && to !== undefined && from.sha === to.sha && from.mode === to.mode) continue;
    const status: FileChange['status'] = from === undefined ? 'added' : to === undefined ? 'removed' : 'modified';
    const a = linesOf(forge, repo, from?.sha);
    const b = linesOf(forge, repo, to?.sha);
    const counted = countLines(a, b);
    changes.push({
      filename,
      status,
      sha: (to ?? from)?.sha ?? '',
      additions: counted.additions,
      deletions: counted.deletions,
      changes: counted.additions + counted.deletions,
      patch: patchOf(filename, a, b),
    });
  }
  return changes;
}

/** The best common ancestor of two commits, or undefined when they share none. */
function mergeBase(forge: Forge, repo: Repo, a: Sha, b: Sha): Sha | undefined {
  const ancestorsOf = (from: Sha): Set<Sha> => new Set(forge.history(repo, from).map((c) => c.sha));
  const sideA = ancestorsOf(a);
  const historyB = forge.history(repo, b);
  for (const commit of historyB) if (sideA.has(commit.sha)) return commit.sha;
  return undefined;
}

/** A three-way merge of two trees over their common ancestor: the files, or the paths that clashed. */
function mergeTrees(
  forge: Forge,
  repo: Repo,
  baseSha: Sha | undefined,
  oursSha: Sha,
  theirsSha: Sha,
): { ok: true; files: Map<string, { mode: string; sha: Sha }> } | { ok: false; conflicts: string[] } {
  const root = baseSha ?? oursSha;
  const base = forge.filesOf(repo, root);
  const ours = forge.filesOf(repo, oursSha);
  const theirs = forge.filesOf(repo, theirsSha);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const files = new Map<string, { mode: string; sha: Sha }>();
  const conflicts: string[] = [];
  const same = (x?: { mode: string; sha: Sha }, y?: { mode: string; sha: Sha }): boolean =>
    x === undefined ? y === undefined : y !== undefined && x.sha === y.sha && x.mode === y.mode;
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) files.set(path, o);
      continue;
    }
    if (same(b, o)) {
      if (t !== undefined) files.set(path, t);
      continue;
    }
    if (same(b, t)) {
      if (o !== undefined) files.set(path, o);
      continue;
    }
    conflicts.push(path);
  }
  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, files };
}

/** Whether a pull request can be merged right now. */
export function mergeability(forge: Forge, repo: Repo, pull: Pull): { ok: boolean; conflicts: string[] } {
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseSha === undefined) return { ok: false, conflicts: [] };
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (headSha === undefined) return { ok: false, conflicts: [] };
  const base = mergeBase(forge, repo, baseSha, headSha);
  const merged = mergeTrees(forge, repo, base, baseSha, headSha);
  return merged.ok ? { ok: true, conflicts: [] } : { ok: false, conflicts: merged.conflicts };
}

/** The files a pull request changes, measured from the commit the two sides last shared. */
export function pullFiles(forge: Forge, repo: Repo, pull: Pull): FileChange[] {
  const base = mergeBase(forge, repo, pull.baseSha, pull.headSha);
  return diffCommits(forge, repo, base, pull.headSha);
}

/** The outcome of merging one pull request: the merge commit, or why it could not be made. */
export type MergeOutcome = { ok: true; sha: Sha } | { ok: false; status: number; message: string };

/**
 * Merge a pull request into its base branch with a real three-way merge and a real merge commit, and
 * close the pull. The REST merge route and the MCP merge tool both go through this, so the two
 * surfaces cannot disagree about what merging means.
 */
export function mergePull(forge: Forge, repo: Repo, pull: Pull, commitMessage?: string): MergeOutcome {
  if (pull.merged) return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseSha === undefined || headSha === undefined) return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  const base = mergeBase(forge, repo, baseSha, headSha);
  const merged = mergeTrees(forge, repo, base, baseSha, headSha);
  if (!merged.ok) return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  const message = commitMessage !== undefined && commitMessage !== '' ? commitMessage : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const mergeSha = forge.commitTree(repo, baseSha, merged.files, message, repo.owner, [headSha]);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  if (pull.baseRef === repo.defaultBranch) repo.refs.set(`refs/heads/${repo.defaultBranch}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.stampOf(repo);
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  pull.updatedAt = repo.updatedAt;
  return { ok: true, sha: mergeSha };
}

// ---------------------------------------------------------------------------- the routes

/**
 * Answer one REST v3 request, or return null when the path is not this surface's at all (the git and
 * GraphQL surfaces get their own chance first).
 */
export function handleRest(deps: RestDeps, req: Req): Out | null {
  const { forge } = deps;
  const seg = req.seg;

  if (seg.length === 0) {
    if (req.method !== 'GET') return methodNotAllowed();
    return json(200, {
      current_user_url: `${req.origin}/api/v3/user`,
      current_user_authorizations_html_url: `https://github.com/settings/connections/applications{/client_id}`,
      authorizations_url: `${req.origin}/api/v3/authorizations`,
      code_search_url: `${req.origin}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
      emojis_url: `${req.origin}/api/v3/emojis`,
      events_url: `${req.origin}/api/v3/events`,
      feeds_url: `${req.origin}/api/v3/feeds`,
      gists_url: `${req.origin}/api/v3/gists{/gist_id}`,
      issue_search_url: `${req.origin}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${req.origin}/api/v3/issues`,
      keys_url: `${req.origin}/api/v3/user/keys{/key_id}`,
      label_search_url: `${req.origin}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
      notifications_url: `${req.origin}/api/v3/notifications`,
      organization_url: `${req.origin}/api/v3/orgs/{org}`,
      public_gists_url: `${req.origin}/api/v3/gists/public`,
      rate_limit_url: `${req.origin}/api/v3/rate_limit`,
      repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${req.origin}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      user_url: `${req.origin}/api/v3/users/{user}`,
      user_repositories_url: `${req.origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${req.origin}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
    }, {
      'x-oauth-scopes': 'repo, read:org',
      'x-github-media-type': 'github.v3',
    });
  }

  if (seg.length === 1 && seg[0] === 'meta') {
    if (req.method !== 'GET') return methodNotAllowed();
    return json(200, {
      verifiable_password_authentication: false,
      installed_version: '3.0.0-forge',
      ssh_key_fingerprints: {},
      hooks: [],
      git: ['2.40.0'],
    });
  }

  if (seg.length === 1 && seg[0] === 'rate_limit') {
    if (req.method !== 'GET') return methodNotAllowed();
    return json(200, {
      resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 }, search: { limit: 30, remaining: 30, reset: 0, used: 0 } },
      rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 },
    });
  }

  if (seg.length === 1 && seg[0] === 'user') {
    if (req.method !== 'GET') return methodNotAllowed();
    const login = forge.preferredOwner;
    const user = forge.user(login);
    return json(200, { ...userJson(login, user.id), public_repos: 0, followers: 0, following: 0, created_at: new Date(1_000_000_000 * 1000).toISOString() });
  }

  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') return userRepos(deps, req);
  if (seg.length === 2 && seg[0] === 'users') {
    if (req.method !== 'GET') return methodNotAllowed();
    return json(200, userJson(seg[1] as string, 1000));
  }

  if (seg[0] !== 'repos' || seg.length < 3) return null;
  const owner = seg[1] as string;
  const name = seg[2] as string;
  const rest = seg.slice(3);

  const repo = forge.resolve(owner, name);
  if (repo === undefined) {
    // A path this surface owns but a repository it does not have is GitHub's own 404.
    return notFound();
  }

  if (rest.length === 0) {
    if (req.method === 'GET') return json(200, repoJson(repo, req.origin));
    if (req.method === 'PATCH') return patchRepo(deps, req, repo);
    if (req.method === 'DELETE') {
      forge.remove(repo.name);
      return empty(204);
    }
    return methodNotAllowed();
  }

  const head = rest[0] as string;

  if (head === 'branches') return branches(deps, req, repo, rest.slice(1));
  if (head === 'commits') return commits(deps, req, repo, rest.slice(1));
  if (head === 'contents') return contents(deps, req, repo, rest.slice(1));
  if (head === 'labels') return labels(deps, req, repo, rest.slice(1));
  if (head === 'issues') return issues(deps, req, repo, rest.slice(1));
  if (head === 'pulls') return pulls(deps, req, repo, rest.slice(1));
  if (head === 'git') return gitRoutes(deps, req, repo, rest.slice(1));
  if (head === 'collaborators' && req.method === 'GET') return json(200, []);
  if (head === 'readme' && req.method === 'GET') return readme(deps, req, repo);

  return notFound();
}

/** 405 with the header GitHub sends when a route exists but not for this method. */
function methodNotAllowed(): Out {
  return errorJson(405, 'Method Not Allowed');
}

/** POST/GET /user/repos. */
function userRepos(deps: RestDeps, req: Req): Out | null {
  const { forge } = deps;
  const login = forge.preferredOwner;
  if (req.method === 'POST') {
    const body = parseBody(req);
    if (body === null) return errorJson(400, 'Problems parsing JSON');
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return unprocessable('Repository creation failed.', [{ resource: 'Repository', field: 'name', code: 'missing_field' }]);
    const repo = forge.create(login, {
      name,
      description: typeof body.description === 'string' ? body.description : '',
      private: body.private === true,
      defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
    });
    // An `auto_init` repository starts with one commit holding a README, as GitHub's does.
    if (body.auto_init === true && repo.refs.size === 0) {
      const blob = forge.put(repo, 'blob', Buffer.from(`# ${repo.name}\n`, 'utf8'));
      const flat = new Map<string, { mode: string; sha: Sha }>([['README.md', { mode: MODE_FILE, sha: blob }]]);
      const commit = forge.commitTree(repo, undefined, flat, 'Initial commit', login);
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
    }
    return json(201, repoJson(repo, req.origin), { location: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}` });
  }
  if (req.method === 'GET') {
    const p = pageOf(req);
    const mine = forge.all().filter((r) => r.owner.toLowerCase() === login.toLowerCase() || forge.tokenLogins.has(r.owner.toLowerCase()));
    if (req.query.get('type') === 'public') {
      const publics = mine.filter((r) => !r.private);
      return json(200, paginate(publics, p).map((r) => repoJson(r, req.origin)), linkHeader(req.origin, '/api/v3/user/repos', p, publics.length));
    }
    return json(200, paginate(mine, p).map((r) => repoJson(r, req.origin)), linkHeader(req.origin, '/api/v3/user/repos', p, mine.length));
  }
  return methodNotAllowed();
}

/** PATCH /repos/{owner}/{repo}: the description, and whatever else a caller may set. */
function patchRepo(deps: RestDeps, req: Req, repo: Repo): Out {
  const body = parseBody(req);
  if (body === null) return errorJson(400, 'Problems parsing JSON');
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.name === 'string' && body.name !== '') repo.name = body.name;
  if (typeof body.private === 'boolean') repo.private = body.private;
  if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
  repo.updatedAt = new Date(Date.parse(repo.updatedAt) + 1000).toISOString();
  return json(200, repoJson(repo, req.origin));
}

/** GET /repos/{owner}/{repo}/branches[/{branch}]. */
function branches(deps: RestDeps, req: Req, repo: Repo, rest: string[]): Out {
  const { forge } = deps;
  if (req.method !== 'GET') return methodNotAllowed();
  if (rest.length === 0) {
    const p = pageOf(req);
    const names = [...repo.refs.keys()].filter((n) => n.startsWith('refs/heads/')).map((n) => n.slice('refs/heads/'.length)).sort();
    const out = paginate(names, p).map((n) => branchJson(repo, n, repo.refs.get(`refs/heads/${n}`) as Sha, req.origin));
    return json(200, out, linkHeader(req.origin, `/api/v3/repos/${repo.owner}/${repo.name}/branches`, p, names.length));
  }
  const want = rest[0] as string;
  const sha = repo.refs.get(`refs/heads/${want}`);
  if (sha === undefined) return notFound();
  return json(200, branchJson(repo, want, sha, req.origin));
}

/** GET /repos/{owner}/{repo}/commits[/{ref}]. */
function commits(deps: RestDeps, req: Req, repo: Repo, rest: string[]): Out {
  const { forge } = deps;
  if (req.method !== 'GET') return methodNotAllowed();
  const ref = rest[0] ?? req.query.get('sha') ?? undefined;
  const tip = forge.tip(repo, ref ?? undefined);
  if (tip === undefined) return unprocessable('Git Repository is empty.');
  const p = pageOf(req);
  const history = forge.history(repo, tip);
  const out = paginate(history, p).map((c) => commitJson(forge, repo, c.sha, req.origin));
  return json(200, out, linkHeader(req.origin, `/api/v3/repos/${repo.owner}/${repo.name}/commits`, p, history.length));
}

/** GET /repos/{owner}/{repo}/readme. */
function readme(deps: RestDeps, req: Req, repo: Repo): Out {
  const out = contentAt(deps, req, repo, 'README.md', req.query.get('ref') ?? undefined);
  return out;
}

/** The path segments after `/contents/`, joined back into a slash path. */
function contentPath(rest: readonly string[]): string {
  return rest.map((part) => decodeURIComponent(part)).join('/');
}

/** Read one path out of a repository at a ref: a file object, or a directory array. */
function contentAt(deps: RestDeps, req: Req, repo: Repo, path: string, ref: string | undefined): Out {
  const { forge } = deps;
  const tip = forge.tip(repo, ref ?? undefined);
  if (tip === undefined) return notFound();
  const flat = forge.filesOf(repo, tip);
  const file = flat.get(path);
  if (file !== undefined) {
    const obj = forge.object(repo, file.sha);
    const data = obj?.type === 'blob' ? obj.data : Buffer.alloc(0);
    const base = `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}`;
    return json(200, {
      name: path.split('/').pop(),
      path,
      sha: file.sha,
      size: data.length,
      url: `${base}/contents/${path}`,
      html_url: `${req.origin}/${repo.owner}/${repo.name}/blob/${ref ?? repo.defaultBranch}/${path}`,
      git_url: `${base}/git/blobs/${file.sha}`,
      download_url: `${req.origin}/${repo.owner}/${repo.name}/raw/${ref ?? repo.defaultBranch}/${path}`,
      type: 'file',
      content: base64Of(data),
      encoding: 'base64',
      _links: { self: `${base}/contents/${path}`, git: `${base}/git/blobs/${file.sha}`, html: `${req.origin}/${repo.owner}/${repo.name}/blob/${ref ?? repo.defaultBranch}/${path}` },
    });
  }
  const prefix = path === '' ? '' : `${path}/`;
  const entries: Record<string, unknown>[] = [];
  for (const [childPath, entry] of flat) {
    if (!childPath.startsWith(prefix)) continue;
    const remainder = childPath.slice(prefix.length);
    if (remainder === '' || remainder.includes('/')) continue;
    const obj = forge.object(repo, entry.sha);
    entries.push({
      name: remainder,
      path: childPath,
      sha: entry.sha,
      size: obj?.data.length ?? 0,
      url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
      html_url: `${req.origin}/${repo.owner}/${repo.name}/blob/${ref ?? repo.defaultBranch}/${childPath}`,
      git_url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.sha}`,
      download_url: null,
      type: 'file',
      _links: { self: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}` },
    });
  }
  // A directory that exists only because of deeper files still lists its immediate children.
  const dirs = new Set<string>();
  for (const childPath of flat.keys()) {
    if (!childPath.startsWith(prefix)) continue;
    const remainder = childPath.slice(prefix.length);
    if (remainder.includes('/')) dirs.add(remainder.split('/')[0] as string);
  }
  for (const dir of [...dirs].sort()) {
    const dirPath = `${prefix}${dir}`;
    entries.push({
      name: dir,
      path: dirPath,
      sha: '',
      size: 0,
      url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${dirPath}`,
      html_url: `${req.origin}/${repo.owner}/${repo.name}/tree/${ref ?? repo.defaultBranch}/${dirPath}`,
      git_url: null,
      download_url: null,
      type: 'dir',
      _links: { self: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${dirPath}` },
    });
  }
  if (entries.length === 0) return notFound();
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return json(200, entries);
}

/** PUT/GET/DELETE /repos/{owner}/{repo}/contents/{path}. */
function contents(deps: RestDeps, req: Req, repo: Repo, rest: string[]): Out {
  const { forge } = deps;
  const path = contentPath(rest);
  if (path === '') return notFound();

  if (req.method === 'GET') return contentAt(deps, req, repo, path, req.query.get('ref') ?? undefined);

  const body = parseBody(req);
  if (body === null) return errorJson(400, 'Problems parsing JSON');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
  const login = repo.owner;

  if (req.method === 'PUT') {
    const encoded = body.content;
    if (typeof encoded !== 'string') return unprocessable('content is required');
    const data = fromBase64(encoded);
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const flat = parent === undefined ? new Map<string, { mode: string; sha: Sha }>() : forge.filesOf(repo, parent);
    const existing = flat.get(path);
    if (typeof body.sha === 'string' && body.sha !== '') {
      if (existing === undefined || existing.sha !== body.sha) {
        return errorJson(409, `${path} does not match ${body.sha}`);
      }
    }
    const blob = forge.put(repo, 'blob', data);
    flat.set(path, { mode: MODE_FILE, sha: blob });
    const commit = forge.commitTree(repo, parent, flat, message, login);
    repo.refs.set(`refs/heads/${branch}`, commit);
    const base = `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}`;
    const payload = {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blob,
        size: data.length,
        url: `${base}/contents/${path}`,
        html_url: `${req.origin}/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        git_url: `${base}/git/blobs/${blob}`,
        download_url: `${req.origin}/${repo.owner}/${repo.name}/raw/${branch}/${path}`,
        type: 'file',
        content: base64Of(data),
        encoding: 'base64',
        _links: { self: `${base}/contents/${path}`, git: `${base}/git/blobs/${blob}`, html: `${req.origin}/${repo.owner}/${repo.name}/blob/${branch}/${path}` },
      },
      commit: commitJson(forge, repo, commit, req.origin),
    };
    return json(existing === undefined ? 201 : 200, payload);
  }

  if (req.method === 'DELETE') {
    const parent = repo.refs.get(`refs/heads/${branch}`);
    if (parent === undefined) return notFound();
    const flat = forge.filesOf(repo, parent);
    const existing = flat.get(path);
    if (existing === undefined) return notFound();
    if (typeof body.sha === 'string' && body.sha !== '' && existing.sha !== body.sha) {
      return errorJson(409, `${path} does not match ${body.sha}`);
    }
    flat.delete(path);
    const commit = forge.commitTree(repo, parent, flat, message, login);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return json(200, { content: null, commit: commitJson(forge, repo, commit, req.origin) });
  }

  return methodNotAllowed();
}

/** GET/POST /repos/{owner}/{repo}/labels. */
function labels(deps: RestDeps, req: Req, repo: Repo, rest: string[]): Out {
  const { forge } = deps;
  const p = pageOf(req);
  if (rest.length === 0 && req.method === 'GET') {
    return json(200, paginate(repo.labels, p).map(labelJson), linkHeader(req.origin, `/api/v3/repos/${repo.owner}/${repo.name}/labels`, p, repo.labels.length));
  }
  if (rest.length === 0 && req.method === 'POST') {
    const body = parseBody(req);
    if (body === null) return errorJson(400, 'Problems parsing JSON');
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return unprocessable('name is required');
    const existing = repo.labels.find((l) => l.name === name);
    if (existing !== undefined) {
      if (typeof body.color === 'string') existing.color = body.color.replace(/^#/, '');
      return json(200, labelJson(existing));
    }
    const label: Label = {
      id: forge.nextIdOf(repo),
      name,
      color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
      description: typeof body.description === 'string' ? body.description : '',
    };
    repo.labels.push(label);
    return json(201, labelJson(label));
  }
  const want = rest[0] as string;
  const found = repo.labels.find((l) => l.name === want);
  if (req.method === 'GET') return found === undefined ? notFound() : json(200, labelJson(found));
  if (req.method === 'DELETE' && found !== undefined) {
    repo.labels = repo.labels.filter((l) => l !== found);
    return empty(204);
  }
  return notFound();
}

/** POST/GET /repos/{owner}/{repo}/issues, then one issue, its comments, and its labels. */
function issues(deps: RestDeps, req: Req, repo: Repo, rest: string[]): Out {
  const { forge } = deps;
  const p = pageOf(req);

  if (rest.length === 0 && req.method === 'POST') {
    const body = parseBody(req);
    if (body === null) return errorJson(400, 'Problems parsing JSON');
    const title = typeof body.title === 'string' ? body.title : '';
    if (title === '') return unprocessable('title is required', [{ resource: 'Issue', field: 'title', code: 'missing_field' }]);
    const requested = labelNames(body.labels);
    const unknown = requested.filter((name) => !repo.labels.some((l) => l.name === name));
    if (unknown.length > 0) {
      return unprocessable('Validation Failed', unknown.map((value) => ({ resource: 'Label', field: 'name', code: 'invalid', value })));
    }
    const issue: Issue = {
      id: forge.nextIdOf(repo),
      number: repo.nextIssueNumber++,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      labels: requested,
      userId: 1000,
      login: repo.owner,
      comments: 0,
      createdAt: forge.stampOf(repo),
      updatedAt: repo.updatedAt,
      closedAt: null,
    };
    repo.issues.push(issue);
    return json(201, issueJson(repo, issue, req.origin), { location: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}` });
  }

  if (rest.length === 0 && req.method === 'GET') {
    const state = req.query.get('state') ?? 'open';
    const sort = req.query.get('sort') ?? 'created';
    const direction = (req.query.get('direction') ?? 'desc').toLowerCase();
    const wantedLabels = (req.query.get('labels') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    let list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
    if (wantedLabels.length > 0) list = list.filter((issue) => wantedLabels.every((name) => issue.labels.includes(name)));
    const key = (issue: Issue): string =>
      sort === 'updated' ? issue.updatedAt : sort === 'comments' ? String(issue.comments).padStart(9, '0') : issue.createdAt;
    list = [...list].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) return a.number - b.number;
      return direction === 'asc' ? (ka < kb ? -1 : 1) : ka < kb ? 1 : -1;
    });
    return json(200, paginate(list, p).map((issue) => issueJson(repo, issue, req.origin)), linkHeader(req.origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, p, list.length));
  }

  const number = Number.parseInt(rest[0] ?? '', 10);
  if (!Number.isFinite(number)) return notFound();
  const issue = repo.issues.find((i) => i.number === number);

  if (rest.length === 1) {
    if (req.method === 'GET') return issue === undefined ? notFound() : json(200, issueJson(repo, issue, req.origin));
    if (req.method === 'PATCH') {
      if (issue === undefined) return notFound();
      const body = parseBody(req);
      if (body === null) return errorJson(400, 'Problems parsing JSON');
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (typeof body.state === 'string') {
        const next = body.state === 'closed' ? 'closed' : 'open';
        if (next === 'closed' && issue.state !== 'closed') {
          issue.state = 'closed';
          issue.closedAt = forge.stampOf(repo);
        } else if (next === 'open') {
          issue.state = 'open';
          issue.closedAt = null;
        }
      }
      if (body.labels !== undefined) {
        const requested = labelNames(body.labels);
        const unknown = requested.filter((name) => !repo.labels.some((l) => l.name === name));
        if (unknown.length > 0) {
          return unprocessable('Validation Failed', unknown.map((value) => ({ resource: 'Label', field: 'name', code: 'invalid', value })));
        }
        issue.labels = requested;
      }
      issue.updatedAt = forge.stampOf(repo);
      return json(200, issueJson(repo, issue, req.origin));
    }
    return methodNotAllowed();
  }

  if (rest[1] === 'comments') {
    if (issue === undefined) return notFound();
    if (req.method === 'GET') {
      const list = repo.comments.get(issue.number) ?? [];
      return json(200, paginate(list, p).map((c) => commentJson(repo, issue.number, c, req.origin)), linkHeader(req.origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, p, list.length));
    }
    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body === null) return errorJson(400, 'Problems parsing JSON');
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return unprocessable('body is required');
      const comment: Comment = {
        id: forge.nextIdOf(repo),
        body: text,
        userId: 1000,
        login: repo.owner,
        createdAt: forge.stampOf(repo),
      };
      const list = repo.comments.get(issue.number) ?? [];
      list.push(comment);
      repo.comments.set(issue.number, list);
      issue.comments = list.length;
      issue.updatedAt = repo.updatedAt;
      return json(201, commentJson(repo, issue.number, comment, req.origin));
    }
    return methodNotAllowed();
  }

  if (rest[1] === 'labels' && req.method === 'GET' && issue !== undefined) {
    return json(200, issue.labels.map((name) => labelJson(repo.labels.find((l) => l.name === name) ?? { id: 0, name, color: 'ededed', description: '' })));
  }

  return notFound();
}

/** The label names a create or patch body names, from either string names or label objects. */
function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '') out.push(entry);
    else if (entry !== null && typeof entry === 'object') {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === 'string' && name !== '') out.push(name);
    }
  }
  return out;
}

/** POST/GET /repos/{owner}/{repo}/pulls, then one pull, its files, and its merge. */
function pulls(deps: RestDeps, req: Req, repo: Repo, rest: string[]): Out {
  const { forge } = deps;
  const p = pageOf(req);

  if (rest.length === 0 && req.method === 'POST') {
    const body = parseBody(req);
    if (body === null) return errorJson(400, 'Problems parsing JSON');
    const title = typeof body.title === 'string' ? body.title : '';
    const headRaw = typeof body.head === 'string' ? body.head : '';
    const baseRaw = typeof body.base === 'string' ? body.base : '';
    const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
    const baseRef = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
    if (title === '' || headRef === '' || baseRef === '') {
      return unprocessable('Validation Failed', [{ resource: 'PullRequest', field: 'title', code: 'missing_field' }]);
    }
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) {
      return unprocessable('Validation Failed', [{ resource: 'PullRequest', field: 'head', code: 'invalid' }]);
    }
    const pull: Pull = {
      id: forge.nextIdOf(repo),
      number: repo.nextPullNumber++,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      userId: 1000,
      login: repo.owner,
      createdAt: forge.stampOf(repo),
      updatedAt: repo.updatedAt,
      comments: 0,
      labels: [],
      mergeable: true,
    };
    repo.pulls.push(pull);
    return json(201, pullJson(forge, repo, pull, req.origin), { location: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` });
  }

  if (rest.length === 0 && req.method === 'GET') {
    const state = (req.query.get('state') ?? 'open').toLowerCase();
    const head = req.query.get('head');
    let list = repo.pulls;
    if (state === 'open') list = list.filter((x) => x.state === 'open' && !x.merged);
    else if (state === 'closed') list = list.filter((x) => x.state === 'closed' || x.merged);
    if (head !== null && head !== '') {
      const wanted = head.includes(':') ? (head.split(':').pop() as string) : head;
      list = list.filter((x) => x.headRef === wanted);
    }
    const sorted = [...list].sort((a, b) => b.number - a.number);
    return json(200, paginate(sorted, p).map((x) => pullJson(forge, repo, x, req.origin)), linkHeader(req.origin, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, p, sorted.length));
  }

  const number = Number.parseInt(rest[0] ?? '', 10);
  if (!Number.isFinite(number)) return notFound();
  const pull = repo.pulls.find((x) => x.number === number);
  if (pull === undefined) return notFound();

  if (rest.length === 1) {
    if (req.method === 'GET') return json(200, pullJson(forge, repo, pull, req.origin));
    if (req.method === 'PATCH') {
      const body = parseBody(req);
      if (body === null) return errorJson(400, 'Problems parsing JSON');
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (typeof body.state === 'string') pull.state = body.state === 'closed' ? 'closed' : 'open';
      pull.updatedAt = forge.stampOf(repo);
      return json(200, pullJson(forge, repo, pull, req.origin));
    }
    return methodNotAllowed();
  }

  if (rest[1] === 'files' && req.method === 'GET') {
    const base = mergeBase(forge, repo, pull.baseSha, pull.headSha);
    const changes = diffCommits(forge, repo, base, pull.headSha);
    return json(200, changes.map((change) => ({
      sha: change.sha,
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      blob_url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${change.sha}`,
      raw_url: `${req.origin}/${repo.owner}/${repo.name}/raw/${pull.headSha}/${change.filename}`,
      contents_url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${change.filename}?ref=${pull.headSha}`,
      patch: change.patch,
    })));
  }

  if (rest[1] === 'merge' && req.method === 'PUT') {
    const body = parseBody(req);
    const method = typeof body?.merge_method === 'string' ? body.merge_method : 'merge';
    const outcome = mergePull(forge, repo, pull, typeof body?.commit_message === 'string' ? body.commit_message : undefined);
    if (!outcome.ok) return errorJson(outcome.status, outcome.message);
    return json(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged', merge_method: method });
  }

  if (rest[1] === 'commits' && req.method === 'GET') {
    const history = forge.history(repo, pull.headSha);
    const baseHistory = new Set(forge.history(repo, pull.baseSha).map((c) => c.sha));
    const unique = history.filter((c) => !baseHistory.has(c.sha));
    return json(200, (unique.length > 0 ? unique : history.slice(0, 1)).map((c) => commitJson(forge, repo, c.sha, req.origin)));
  }

  return notFound();
}

/** The git data routes: refs, blobs, trees, commits and tags. */
function gitRoutes(deps: RestDeps, req: Req, repo: Repo, rest: string[]): Out {
  const { forge } = deps;
  const head = rest[0];
  if (head === 'refs') return gitRefs(deps, req, repo, rest.slice(1));
  if (head === 'blobs' && req.method === 'GET') {
    const sha = rest[1] ?? '';
    const obj = forge.object(repo, sha);
    if (obj === undefined || obj.type !== 'blob') return notFound();
    return json(200, {
      sha,
      node_id: `B_${sha.slice(0, 12)}`,
      size: obj.data.length,
      url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
      content: base64Of(obj.data),
      encoding: 'base64',
    });
  }
  if (head === 'trees' && req.method === 'GET') {
    const sha = rest[1] ?? '';
    const entries = forge.tree(repo, sha);
    if (entries === undefined) return notFound();
    return json(200, {
      sha,
      url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${sha}`,
      tree: entries.map((entry) => ({
        path: entry.name,
        mode: entry.mode,
        type: entry.mode === '40000' ? 'tree' : 'blob',
        sha: entry.sha,
        size: undefined,
        url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.sha}`,
      })),
      truncated: false,
    });
  }
  if (head === 'commits' && req.method === 'GET') {
    const sha = rest[1] ?? '';
    const commit = forge.commit(repo, sha);
    if (commit === undefined) return notFound();
    return json(200, commitJson(forge, repo, sha, req.origin));
  }
  if (head === 'tags' && req.method === 'GET') {
    const sha = rest[1] ?? '';
    const obj = forge.object(repo, sha);
    if (obj === undefined || obj.type !== 'tag') return notFound();
    return json(200, { tag: '', sha, node_id: `T_${sha.slice(0, 12)}`, url: '', message: '', tagger: {}, object: { sha: '', type: 'commit', url: '' } });
  }
  return notFound();
}

/** GET/POST /repos/{owner}/{repo}/git/refs, and one ref by its path. */
function gitRefs(deps: RestDeps, req: Req, repo: Repo, rest: string[]): Out {
  const { forge } = deps;
  if (rest.length === 0 && req.method === 'GET') {
    const list = [...repo.refs.entries()].map(([ref, sha]) => ({
      ref,
      node_id: `R_${sha.slice(0, 12)}`,
      url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
      object: { sha, type: 'commit', url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
    }));
    return json(200, list);
  }
  if (rest.length === 0 && req.method === 'POST') {
    const body = parseBody(req);
    if (body === null) return errorJson(400, 'Problems parsing JSON');
    let ref = typeof body.ref === 'string' ? body.ref : '';
    let sha = typeof body.sha === 'string' ? body.sha : '';
    if ((ref === '' || sha === '') && typeof body === 'object') {
      const nested = body as { ref?: unknown; sha?: unknown };
      if (typeof nested.ref === 'string') ref = nested.ref;
      if (typeof nested.sha === 'string') sha = nested.sha;
    }
    if (ref === '' || sha === '') return unprocessable('ref and sha are required');
    if (!ref.startsWith('refs/')) ref = `refs/heads/${ref}`;
    let target = sha;
    if (!isSha(sha)) {
      const resolved = forge.tip(repo, sha);
      if (resolved === undefined) return unprocessable(`sha ${sha} is not a commit`);
      target = resolved;
    }
    if (forge.object(repo, target) === undefined) return unprocessable(`sha ${sha} is not an object of this repository`);
    repo.refs.set(ref, target);
    return json(201, {
      ref,
      node_id: `R_${target.slice(0, 12)}`,
      url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
      object: { sha: target, type: 'commit', url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${target}` },
    });
  }
  // A ref addressed by its own path: refs/heads/x, or heads/x, or tags/x.
  const joined = rest.join('/');
  const candidates = [`refs/${joined}`, joined.startsWith('refs/') ? joined : `refs/${joined}`];
  let refName: string | undefined = candidates.find((c) => repo.refs.has(c));
  if (refName === undefined && joined.split('/').length >= 2) {
    const guess = `refs/${joined}`;
    if (repo.refs.has(guess)) refName = guess;
  }
  if (refName === undefined) {
    const asHeads = `refs/heads/${joined}`;
    const asTags = `refs/tags/${joined}`;
    if (repo.refs.has(asHeads)) refName = asHeads;
    else if (repo.refs.has(asTags)) refName = asTags;
  }
  if (refName === undefined) return notFound();
  const sha = repo.refs.get(refName) as Sha;
  if (req.method === 'GET') {
    return json(200, {
      ref: refName,
      node_id: `R_${sha.slice(0, 12)}`,
      url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${refName.replace(/^refs\//, '')}`,
      object: { sha, type: 'commit', url: `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
    });
  }
  if (req.method === 'PATCH') {
    const body = parseBody(req);
    if (body === null) return errorJson(400, 'Problems parsing JSON');
    const next = typeof body.sha === 'string' ? body.sha : '';
    if (next === '') return unprocessable('sha is required');
    repo.refs.set(refName, next);
    return json(200, {
      ref: refName,
      node_id: `R_${next.slice(0, 12)}`,
      url: '',
      object: { sha: next, type: 'commit', url: '' },
    });
  }
  if (req.method === 'DELETE') {
    repo.refs.delete(refName);
    return empty(204);
  }
  return methodNotAllowed();
}

/** A request body parsed as a JSON object, or null when it is not one. */
function parseBody(req: Req): Record<string, unknown> | null {
  if (req.body.length === 0) return {};
  const text = req.body.toString('utf8').trim();
  if (text === '') return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when a path belongs to the REST surface at all, so a 401 can be given before routing. */
export function isRestPath(seg: readonly string[]): boolean {
  if (seg.length === 0) return true;
  const first = seg[0] as string;
  return first === 'meta' || first === 'user' || first === 'users' || first === 'repos' || first === 'rate_limit';
}
