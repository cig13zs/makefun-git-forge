// The Model Context Protocol endpoint: JSON-RPC 2.0 over streamable HTTP at `POST /mcp`.
//
// It speaks the handshake era (2025-11-25 and earlier: `initialize`, `notifications/initialized`,
// then `tools/list` and `tools/call`), which is the era an agent client falls back to, and it declines
// `server/discover` with the protocol's own "method not found" so a client that probes the newer
// revision negotiates down instead of failing.
//
// The six tools are the ones an agent expects from a git host, and each one writes through the same
// store the REST surface reads: a repository or an issue created here is the very same object there,
// with the same id, which is what the agent-native checks prove.

import { errorJson, json, unauthorized, type Out, type Req } from './http.ts';
import { mergePull, type RestDeps } from './rest.ts';
import type { Forge, Pull, Repo } from './store.ts';
import type { Sha } from './git.ts';

/** The revisions this server answers a handshake for. */
const SUPPORTED_REVISIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** The newest revision this server speaks, echoed when a client offers nothing it knows. */
const DEFAULT_REVISION = '2025-11-25';

/** One tool's declaration: the shape `tools/list` offers. */
interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A JSON Schema object with a fixed property set and a required list. */
function schema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: true };
}

/** The string property every tool's arguments are made of. */
const STRING = { type: 'string' } as const;

/**
 * The six tools, in a fixed order so two `tools/list` answers are byte for byte the same. The property
 * names are the plainest ones (`owner`, `repo`, `title`, `head`, `base`, `pull_number`), so a client's
 * documented argument maps onto them with no guessing and no required property it cannot fill.
 */
const TOOLS: readonly ToolSpec[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user and return it.',
    inputSchema: schema(
      { name: STRING, description: STRING, private: { type: 'boolean' } },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by its owner login and name.',
    inputSchema: schema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository and return it with its number.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, filtered by state, newest first.',
    inputSchema: schema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another and return it with its number.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, head: STRING, base: STRING, body: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch and return the merge commit.',
    inputSchema: schema({ owner: STRING, repo: STRING, pull_number: { type: 'integer' } }, ['owner', 'repo', 'pull_number']),
  },
]);

/** One JSON-RPC request as this endpoint reads it. */
interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** What one tool call produced: a value, or a tool-level error with a message. */
type ToolResult = { ok: true; value: unknown } | { ok: false; message: string };

/** A stored repository summarised the way a tool result carries it. */
function repoView(repo: Repo): Record<string, unknown> {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    head_sha: tip ?? null,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

/** One issue summarised the way a tool result carries it. */
function issueView(repo: Repo, index: number): Record<string, unknown> {
  const issue = repo.issues[index] as NonNullable<ReturnType<() => Repo['issues'][number]>>;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments,
    repo: `${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** One pull request summarised the way a tool result carries it. */
function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: pull.headRef,
    base: pull.baseRef,
    head_sha: pull.headSha,
    merge_commit_sha: pull.mergeCommitSha,
    repo: `${repo.owner}/${repo.name}`,
  };
}

/** A string argument, or the empty string when it is missing or not a string. */
function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/** The repository a tool call names, or a message saying which part was missing. */
function repoFor(forge: Forge, args: Record<string, unknown>): { ok: true; repo: Repo } | { ok: false; message: string } {
  const owner = str(args, 'owner');
  const name = str(args, 'repo') || str(args, 'name');
  if (owner === '') return { ok: false, message: 'the arguments are missing owner' };
  if (name === '') return { ok: false, message: 'the arguments are missing repo' };
  const repo = forge.resolve(owner, name);
  if (repo === undefined) return { ok: false, message: `no repository ${owner}/${name} on this forge` };
  return { ok: true, repo };
}

/** Run one tool by name against the store. */
function runTool(forge: Forge, name: string, args: Record<string, unknown>): ToolResult {
  if (name === 'create_repo') {
    const repoName = str(args, 'name');
    if (repoName === '') return { ok: false, message: 'the arguments are missing name' };
    const existing = forge.byName(repoName);
    if (existing !== undefined) return { ok: true, value: repoView(existing) };
    const repo = forge.create(forge.preferredOwner, {
      name: repoName,
      description: str(args, 'description'),
      private: args.private === true,
    });
    return { ok: true, value: repoView(repo) };
  }

  if (name === 'get_repo') {
    const found = repoFor(forge, args);
    if (!found.ok) return { ok: false, message: found.message };
    return { ok: true, value: repoView(found.repo) };
  }

  if (name === 'create_issue') {
    const found = repoFor(forge, args);
    if (!found.ok) return { ok: false, message: found.message };
    const title = str(args, 'title');
    if (title === '') return { ok: false, message: 'the arguments are missing title' };
    const repo = found.repo;
    repo.issues.push({
      id: forge.nextIdOf(repo),
      number: repo.nextIssueNumber++,
      title,
      body: str(args, 'body'),
      state: 'open',
      labels: [],
      userId: 1000,
      login: repo.owner,
      comments: 0,
      createdAt: forge.stampOf(repo),
      updatedAt: repo.updatedAt,
      closedAt: null,
    });
    return { ok: true, value: issueView(repo, repo.issues.length - 1) };
  }

  if (name === 'list_issues') {
    const found = repoFor(forge, args);
    if (!found.ok) return { ok: false, message: found.message };
    const repo = found.repo;
    const state = str(args, 'state') || 'open';
    const list = repo.issues
      .map((_, index) => index)
      .filter((index) => state === 'all' || (repo.issues[index] as Repo['issues'][number]).state === state);
    const sorted = list.sort((a, b) => {
      const left = repo.issues[a] as Repo['issues'][number];
      const right = repo.issues[b] as Repo['issues'][number];
      return right.number - left.number;
    });
    return { ok: true, value: { issues: sorted.map((index) => issueView(repo, index)), total: sorted.length } };
  }

  if (name === 'create_pull_request') {
    const found = repoFor(forge, args);
    if (!found.ok) return { ok: false, message: found.message };
    const repo = found.repo;
    const title = str(args, 'title');
    const headRaw = str(args, 'head');
    const baseRaw = str(args, 'base');
    const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
    const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
    if (title === '') return { ok: false, message: 'the arguments are missing title' };
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) return { ok: false, message: `no branch ${head}` };
    if (baseSha === undefined) return { ok: false, message: `no branch ${base}` };
    const pull: Pull = {
      id: forge.nextIdOf(repo),
      number: repo.nextPullNumber++,
      title,
      body: str(args, 'body'),
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      headSha,
      baseRef: base,
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
    return { ok: true, value: pullView(repo, pull) };
  }

  if (name === 'merge_pull_request') {
    const found = repoFor(forge, args);
    if (!found.ok) return { ok: false, message: found.message };
    const repo = found.repo;
    const raw = args.pull_number ?? args.number ?? args.id;
    const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(number)) return { ok: false, message: 'the arguments are missing pull_number' };
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return { ok: false, message: `no pull request #${number}` };
    const outcome = mergePull(forge, repo, pull);
    if (!outcome.ok) return { ok: false, message: outcome.message };
    return { ok: true, value: { ...pullView(repo, pull), merge_commit_sha: outcome.sha as Sha } };
  }

  return { ok: false, message: `unknown tool ${name}` };
}

/** A JSON-RPC success envelope. */
function rpcResult(id: unknown, result: unknown): Out {
  return json(200, { jsonrpc: '2.0', id: id === undefined ? null : id, result });
}

/** A JSON-RPC error envelope. */
function rpcError(id: unknown, code: number, message: string, status = 200): Out {
  return json(status, { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
}

/** The `_meta` revision a request declares, when it declares one. */
function declaredRevision(params: Record<string, unknown>): string {
  const candidate = params.protocolVersion;
  if (typeof candidate === 'string' && SUPPORTED_REVISIONS.includes(candidate)) return candidate;
  return DEFAULT_REVISION;
}

/** Answer one MCP request. */
export function handleMcp(deps: RestDeps, req: Req): Out {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // No server-initiated stream and no session to end: say so with the transport's own status.
    return errorJson(405, 'Method Not Allowed');
  }
  if (req.method !== 'POST') return errorJson(405, 'Method Not Allowed');

  if (deps.token !== '') {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return unauthorized();
  }

  const text = req.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    // The transport's parse error: HTTP 400 and the protocol's -32700 envelope.
    return rpcError(null, -32700, 'Parse error: the request body is not JSON', 400);
  }
  if (parsed === undefined) return rpcError(null, -32700, 'Parse error: the request body is empty', 400);

  // A batch is answered as a batch; a single request is answered on its own.
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => one(forgeOf(deps), entry)).filter((entry) => entry !== null);
    return json(200, answers as unknown[]);
  }

  const answer = one(forgeOf(deps), parsed);
  if (answer === null) {
    // A notification takes no answer: the transport acknowledges it with 202 and no body.
    return { status: 202, headers: { 'content-length': '0' }, body: Buffer.alloc(0) };
  }
  return answer;
}

/** The store behind a request. */
function forgeOf(deps: RestDeps): Forge {
  return deps.forge;
}

/** Answer one JSON-RPC message, or null for a notification. */
function one(forge: Forge, raw: unknown): Out | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const request = raw as RpcRequest;
  const method = typeof request.method === 'string' ? request.method : '';
  const isNotification = request.id === undefined || request.id === null;
  const id = request.id;
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};

  if (method === 'initialize') {
    const revision = declaredRevision(params);
    return rpcResult(id, {
      protocolVersion: revision,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'makefun-git-forge', version: '1.0.0' },
      instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests.',
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method === 'initialized') {
    return null;
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    // A stable order and no generated ids: two answers are byte for byte the same.
    return rpcResult(id, { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    if (name === '') return rpcError(id, -32602, 'Invalid params: name is required');
    const known = TOOLS.some((tool) => tool.name === name);
    if (!known) return rpcError(id, -32601, `Method not found: unknown tool ${name}`);

    const missing = requiredMissing(name, args);
    if (missing.length > 0) {
      // A tool-level failure the client can see, which is how MCP reports bad arguments.
      return rpcResult(id, {
        content: [{ type: 'text', text: `missing required argument${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}` }],
        isError: true,
      });
    }

    const outcome = runTool(forge, name, args);
    if (!outcome.ok) {
      return rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true });
    }
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
      structuredContent: outcome.value,
      isError: false,
    });
  }

  // `server/discover` is the newer revision's mandatory RPC. Declining it with the protocol's own
  // method-not-found is how a server that predates it negotiates a client down to the handshake era.
  if (method === 'server/discover') return rpcError(id, -32601, 'Method not found: server/discover');

  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** The required arguments of a tool that the call did not supply. */
function requiredMissing(name: string, args: Record<string, unknown>): string[] {
  const required = name === 'create_repo'
    ? ['name']
    : name === 'merge_pull_request'
      ? ['owner', 'repo', 'pull_number']
      : name === 'create_pull_request'
        ? ['owner', 'repo', 'title', 'head', 'base']
        : name === 'create_issue'
          ? ['owner', 'repo', 'title']
          : ['owner', 'repo'];
  return required.filter((key) => {
    const value = args[key];
    if (value === undefined || value === null) return true;
    return typeof value === 'string' && value.trim() === '';
  });
}
