// GitHub's GraphQL v4 endpoint. The documents `gh`'s githubv4 client and github-mcp-server send are
// parsed into an ordinary selection tree and executed against the same store the REST surface serves,
// so a repository read here and the same repository read over REST are one object with one id.
//
// This is a small real GraphQL engine rather than a matcher: a lexer, a recursive-descent parser for
// the query subset those clients use (variables, inline enums, inline input objects, aliases, inline
// fragments, defaulted and null variables, operation names, and a JSON array of documents in one
// request), and a resolver table per type. An unknown field is an error that names it, exactly as a
// real server reports one, because gh's feature probes depend on that being distinguishable.

import { json, type Out, type Req } from './http.ts';
import { mergeability, mergePull, pullFiles, type RestDeps } from './rest.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------- lexing

/** The punctuation a document is built from. */
type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

/** One lexed token, with the position it started at for error messages. */
interface Token {
  kind: TokenKind;
  text: string;
  at: number;
}

/** Everything a document can be read from: whitespace, commas and comments carry no meaning. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // A block string is three quotes; a normal one may carry escapes.
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const stop = end < 0 ? source.length : end;
        tokens.push({ kind: 'string', text: source.slice(i + 3, stop), at: i });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let out = '';
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const next = source[j + 1] ?? '';
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      tokens.push({ kind: 'string', text: out, at: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', text: source.slice(i, j), at: i });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i + 1;
      let float = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') float = true;
        j += 1;
      }
      tokens.push({ kind: float ? 'float' : 'int', text: source.slice(i, j), at: i });
      i = j;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', text: '...', at: i });
      i += 3;
      continue;
    }
    tokens.push({ kind: 'punct', text: ch, at: i });
    i += 1;
  }
  tokens.push({ kind: 'eof', text: '', at: source.length });
  return tokens;
}

// ---------------------------------------------------------------------------- the selection tree

/** A literal value written in a document, or a reference to a variable. */
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

/** One field of a selection set, an alias included, with its own selection when it has one. */
interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selection: SelectionNode[];
}

/** An inline fragment (`... on Type { ... }`): gh's Relay reads use exactly this shape. */
interface FragmentNode {
  kind: 'fragment';
  onType: string | null;
  selection: SelectionNode[];
}

/** Anything a selection set can hold. */
type SelectionNode = FieldNode | FragmentNode;

/** One operation of a document. */
interface OperationNode {
  kind: 'query' | 'mutation';
  name: string;
  variables: string[];
  selection: SelectionNode[];
}

/** A document that could not be read or executed, reported as a GraphQL error rather than a crash. */
class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

/** A cursor over a token list. */
class Reader {
  index: number;
  tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.index = 0;
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.index] as Token;
  }

  next(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  at(text: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.text === text;
  }

  atName(text: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.text === text;
  }

  eat(text: string): boolean {
    if (!this.at(text)) return false;
    this.index += 1;
    return true;
  }

  expect(text: string): void {
    if (!this.eat(text)) throw new GraphQLError(`expected ${text} but found ${JSON.stringify(this.peek().text)}`);
  }
}

/** Parse one document into its operations. */
function parseDocument(source: string): OperationNode[] {
  const reader = new Reader(lex(source));
  const operations: OperationNode[] = [];
  while (reader.peek().kind !== 'eof') {
    const token = reader.peek();
    if (token.kind === 'punct' && token.text === '{') {
      // The shorthand form: a selection set with no `query` keyword and no name.
      operations.push({ kind: 'query', name: '', variables: [], selection: parseSelection(reader) });
      continue;
    }
    if (token.kind !== 'name') throw new GraphQLError(`expected an operation but found ${JSON.stringify(token.text)}`);
    const keyword = reader.next().text;
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new GraphQLError(`unknown operation ${keyword}`);
    }
    let name = '';
    const variables: string[] = [];
    if (reader.peek().kind === 'name') name = reader.next().text;
    if (reader.at('(')) {
      reader.expect('(');
      while (!reader.at(')') && reader.peek().kind !== 'eof') {
        if (!reader.eat('$')) {
          reader.next();
          continue;
        }
        const variable = reader.next().text;
        variables.push(variable);
        // Skip the type annotation and any default: only the name matters to the executor.
        let depth = 0;
        while (reader.peek().kind !== 'eof') {
          if (reader.at('(') || reader.at('[') || reader.at('{')) depth += 1;
          else if (reader.at(')') && depth === 0) break;
          else if (reader.at(')') || reader.at(']') || reader.at('}')) depth -= 1;
          reader.next();
        }
      }
      reader.expect(')');
    }
    operations.push({
      kind: keyword === 'mutation' ? 'mutation' : 'query',
      name,
      variables,
      selection: parseSelection(reader),
    });
  }
  if (operations.length === 0) throw new GraphQLError('the document holds no operation');
  return operations;
}

/** Parse one braced selection set. */
function parseSelection(reader: Reader): SelectionNode[] {
  reader.expect('{');
  const nodes: SelectionNode[] = [];
  while (!reader.at('}') && reader.peek().kind !== 'eof') {
    if (reader.at('...')) {
      reader.next();
      let onType: string | null = null;
      if (reader.atName('on')) {
        reader.next();
        onType = reader.next().text;
      }
      nodes.push({ kind: 'fragment', onType, selection: parseSelection(reader) });
      continue;
    }
    // A directive on a field carries no meaning for the executor and is skipped.
    const first = reader.next().text;
    let alias: string | null = null;
    let name = first;
    if (reader.at(':')) {
      reader.next();
      alias = first;
      name = reader.next().text;
    }
    const args = new Map<string, ValueNode>();
    if (reader.at('(')) {
      reader.expect('(');
      while (!reader.at(')') && reader.peek().kind !== 'eof') {
        const argName = reader.next().text;
        reader.expect(':');
        args.set(argName, parseValue(reader));
      }
      reader.expect(')');
    }
    while (reader.at('@')) {
      reader.next();
      reader.next();
      if (reader.at('(')) {
        reader.expect('(');
        let depth = 1;
        while (depth > 0 && reader.peek().kind !== 'eof') {
          if (reader.at('(')) depth += 1;
          else if (reader.at(')')) depth -= 1;
          reader.next();
        }
      }
    }
    const selection = reader.at('{') ? parseSelection(reader) : [];
    nodes.push({ kind: 'field', alias, name, args, selection });
  }
  reader.expect('}');
  return nodes;
}

/** Parse one argument value. */
function parseValue(reader: Reader): ValueNode {
  const token = reader.peek();
  if (reader.eat('$')) return { kind: 'variable', name: reader.next().text };
  if (reader.at('[')) {
    reader.expect('[');
    const items: ValueNode[] = [];
    while (!reader.at(']') && reader.peek().kind !== 'eof') items.push(parseValue(reader));
    reader.expect(']');
    return { kind: 'list', items };
  }
  if (reader.at('{')) {
    reader.expect('{');
    const fields = new Map<string, ValueNode>();
    while (!reader.at('}') && reader.peek().kind !== 'eof') {
      const key = reader.next().text;
      reader.expect(':');
      fields.set(key, parseValue(reader));
    }
    reader.expect('}');
    return { kind: 'object', fields };
  }
  if (token.kind === 'string') {
    reader.next();
    return { kind: 'literal', value: token.text };
  }
  if (token.kind === 'int') {
    reader.next();
    return { kind: 'literal', value: Number.parseInt(token.text, 10) };
  }
  if (token.kind === 'float') {
    reader.next();
    return { kind: 'literal', value: Number.parseFloat(token.text) };
  }
  if (token.kind === 'name') {
    reader.next();
    // An enum literal keeps its name; true/false/null are the three that are not enums.
    if (token.text === 'true') return { kind: 'literal', value: true };
    if (token.text === 'false') return { kind: 'literal', value: false };
    if (token.text === 'null') return { kind: 'literal', value: null };
    return { kind: 'literal', value: token.text };
  }
  throw new GraphQLError(`unexpected ${JSON.stringify(token.text)} in an argument`);
}

/** Resolve a parsed value against the request's variables. */
function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  if (node.kind === 'variable') return variables[node.name];
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'list') return node.items.map((item) => valueOf(item, variables));
  const out: Record<string, unknown> = {};
  for (const [key, value] of node.fields) out[key] = valueOf(value, variables);
  return out;
}

// ---------------------------------------------------------------------------- typed values

/** A value with the GraphQL type it answers as, so a selection set can be projected over it. */
interface Typed {
  __type: string;
  value: unknown;
}

/** Wrap a value with its type. */
function typed(__type: string, value: unknown): Typed {
  return { __type, value };
}

/** True for a value this engine typed. */
function isTyped(value: unknown): value is Typed {
  return typeof value === 'object' && value !== null && typeof (value as Typed).__type === 'string';
}

/**
 * A Relay global id: the type and the store's own numeric id, encoded so a client can hand it back.
 * `node(id:)` decodes it, so an id read from one query addresses the same object in the next.
 */
function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

/** Read a global id back, or null when it is not one this forge issued. */
function parseGlobalId(id: string): { type: string; id: number } | null {
  const decoded = Buffer.from(id, 'base64').toString('utf8');
  const match = /^([A-Za-z]+):(\d+)$/.exec(decoded);
  if (match === null) return null;
  return { type: match[1] as string, id: Number.parseInt(match[2] as string, 10) };
}

/** The execution context: the store, and the login the bearer token owns. */
interface ExecContext {
  forge: Forge;
  login: string;
}

/** The repository a global id names, if it names one. */
function repoById(forge: Forge, id: number): Repo | undefined {
  return forge.all().find((repo) => repo.id === id);
}

/** A repository's issues in creation order. */
function issuesOf(repo: Repo): Issue[] {
  return repo.issues;
}

/** The issue state a GraphQL enum spells. */
function issueState(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** The pull request state a GraphQL enum spells. */
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** A connection over a list: `{nodes, pageInfo}`, with the cursor as an opaque offset. */
function connection(nodes: Typed[], total: number, start: number, end: number): Typed {
  const hasNextPage = end < total;
  return typed('__connection', {
    nodes,
    pageInfo: { hasNextPage, hasPreviousPage: start > 0, endCursor: String(end), startCursor: String(start) },
    totalCount: total,
  });
}

// ---------------------------------------------------------------------------- resolvers

/** Root query fields. */
function queryField(ctx: ExecContext, name: string, args: Record<string, unknown>): unknown {
  if (name === 'viewer') return typed('User', { login: ctx.login });
  if (name === 'repository') {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const repoName = typeof args.name === 'string' ? args.name : '';
    const repo = ctx.forge.resolve(owner, repoName);
    return repo === undefined ? null : typed('Repository', repo);
  }
  if (name === 'node') {
    const id = typeof args.id === 'string' ? args.id : '';
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    if (parsed.type === 'Repository') {
      const repo = repoById(ctx.forge, parsed.id);
      return repo === undefined ? null : typed('Repository', repo);
    }
    if (parsed.type === 'Issue') {
      for (const repo of ctx.forge.all()) {
        const issue = repo.issues.find((candidate) => candidate.id === parsed.id);
        if (issue !== undefined) return typed('Issue', { repo, issue });
      }
      return null;
    }
    if (parsed.type === 'PullRequest') {
      for (const repo of ctx.forge.all()) {
        const pull = repo.pulls.find((candidate) => candidate.id === parsed.id);
        if (pull !== undefined) return typed('PullRequest', { repo, pull });
      }
      return null;
    }
    return null;
  }
  if (name === '__type') {
    return typeIntrospection(typeof args.name === 'string' ? args.name : '');
  }
  if (name === '__typename') return 'Query';
  throw new GraphQLError(`Field '${name}' doesn't exist on type 'Query'`);
}

/** The field names each introspectable type describes. */
const DESCRIBED_TYPES: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'mergeableState', 'files', 'body', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

/** The enum types, which describe values rather than fields. */
const ENUM_TYPES = new Set(['IssueState', 'PullRequestState', 'MergeableState', 'PullRequestMergeMethod', 'RepositoryPermission', 'IssueOrderField', 'OrderDirection', 'SearchType']);

/** `__type(name:)`: the description of one type, as gh's feature probes read it. */
function typeIntrospection(name: string): Typed | null {
  const members = DESCRIBED_TYPES[name];
  if (members === undefined) return null;
  const isEnum = ENUM_TYPES.has(name);
  return typed('__Type', {
    kind: isEnum ? 'ENUM' : 'OBJECT',
    name,
    fields: isEnum ? null : members.map((field) => ({ name: field })),
    enumValues: isEnum ? members.map((value) => ({ name: value })) : null,
    inputFields: null,
    description: null,
  });
}

/** Repository fields. */
function repositoryField(ctx: ExecContext, repo: Repo, name: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  if (name === 'id') return globalId('Repository', repo.id);
  if (name === 'databaseId') return repo.id;
  if (name === 'name') return repo.name;
  if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
  if (name === 'description') return repo.description === '' ? null : repo.description;
  if (name === 'isPrivate') return repo.private;
  if (name === 'createdAt') return repo.createdAt;
  if (name === 'owner') return typed('User', { login: repo.owner });
  if (name === 'viewerPermission') return 'ADMIN';
  if (name === 'hasIssuesEnabled') return true;
  if (name === 'defaultBranchRef') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip === undefined) return null;
    return typed('Ref', { name: repo.defaultBranch, sha: tip });
  }
  if (name === 'issue') {
    const number = typeof args.number === 'number' ? args.number : Number.NaN;
    const issue = repo.issues.find((candidate) => candidate.number === number);
    return issue === undefined ? null : typed('Issue', { repo, issue });
  }
  if (name === 'issues') return issueConnection(ctx, repo, args);
  if (name === 'pullRequest') {
    const number = typeof args.number === 'number' ? args.number : Number.NaN;
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    return pull === undefined ? null : typed('PullRequest', { repo, pull });
  }
  if (name === 'pullRequests') {
    const first = typeof args.first === 'number' ? args.first : 30;
    const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
    return typed('__connection', {
      nodes: pulls.slice(0, first).map((pull) => typed('PullRequest', { repo, pull })),
      pageInfo: { hasNextPage: pulls.length > first, hasPreviousPage: false, endCursor: String(Math.min(first, pulls.length)), startCursor: '0' },
      totalCount: pulls.length,
    });
  }
  if (name === '__typename') return 'Repository';
  throw new GraphQLError(`Field '${name}' doesn't exist on type 'Repository'`);
  void forge;
}

/** `repository.issues(states:, orderBy:, first:, after:)`. */
function issueConnection(ctx: ExecContext, repo: Repo, args: Record<string, unknown>): Typed {
  const states = Array.isArray(args.states) ? args.states.map((value) => String(value)) : [];
  let list = issuesOf(repo);
  if (states.length > 0) {
    list = list.filter((issue) => states.includes(issueState(issue)));
  }
  const orderBy = args.orderBy !== null && typeof args.orderBy === 'object' ? (args.orderBy as Record<string, unknown>) : {};
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  const keyOf = (issue: Issue): string =>
    field === 'UPDATED_AT' ? issue.updatedAt : field === 'COMMENTS' ? String(issue.comments).padStart(9, '0') : issue.createdAt;
  list = [...list].sort((a, b) => {
    const left = keyOf(a);
    const right = keyOf(b);
    if (left === right) return a.number - b.number;
    return direction === 'ASC' ? (left < right ? -1 : 1) : left < right ? 1 : -1;
  });
  const total = list.length;
  const start = typeof args.after === 'string' && args.after !== '' ? Math.max(0, Number.parseInt(args.after, 10) || 0) : 0;
  const first = typeof args.first === 'number' ? args.first : 30;
  const end = Math.min(total, start + first);
  const nodes = list.slice(start, end).map((issue) => typed('Issue', { repo, issue }));
  return connection(nodes, total, start, end);
}

/** Issue fields. An issue is carried with its repository so nested reads can reach it. */
function issueField(_ctx: ExecContext, value: { repo: Repo; issue: Issue }, name: string): unknown {
  const { issue } = value;
  if (name === 'id') return globalId('Issue', issue.id);
  if (name === 'number') return issue.number;
  if (name === 'title') return issue.title;
  if (name === 'body') return issue.body === '' ? null : issue.body;
  if (name === 'state') return issueState(issue);
  if (name === 'createdAt') return issue.createdAt;
  if (name === 'updatedAt') return issue.updatedAt;
  if (name === 'closedAt') return issue.closedAt;
  if (name === 'author') return typed('User', { login: issue.login });
  if (name === 'labels') return [];
  if (name === 'comments') return 0;
  if (name === 'repository') return typed('Repository', value.repo);
  if (name === '__typename') return 'Issue';
  throw new GraphQLError(`Field '${name}' doesn't exist on type 'Issue'`);
}

/** Pull request fields. */
function pullField(ctx: ExecContext, value: { repo: Repo; pull: Pull }, name: string, args: Record<string, unknown>): unknown {
  const { repo, pull } = value;
  if (name === 'id') return globalId('PullRequest', pull.id);
  if (name === 'number') return pull.number;
  if (name === 'title') return pull.title;
  if (name === 'body') return pull.body === '' ? null : pull.body;
  if (name === 'state') return pullState(pull);
  if (name === 'merged') return pull.merged;
  if (name === 'headRefName') return pull.headRef;
  if (name === 'baseRefName') return pull.baseRef;
  if (name === 'mergeable') {
    if (pull.merged) return 'UNKNOWN';
    const check = mergeability(ctx.forge, repo, pull);
    return check.ok ? 'MERGEABLE' : 'CONFLICTING';
  }
  if (name === 'mergeableState') {
    const check = mergeability(ctx.forge, repo, pull);
    return check.ok ? 'clean' : 'dirty';
  }
  if (name === 'files') {
    const first = typeof args.first === 'number' ? args.first : 30;
    const changes = pullFiles(ctx.forge, repo, pull);
    return typed('__connection', {
      nodes: changes.slice(0, first).map((change) => typed('__file', { path: change.filename, additions: change.additions, deletions: change.deletions, changeType: change.status })),
      pageInfo: { hasNextPage: changes.length > first, hasPreviousPage: false, endCursor: String(Math.min(first, changes.length)), startCursor: '0' },
      totalCount: changes.length,
    });
  }
  if (name === '__typename') return 'PullRequest';
  throw new GraphQLError(`Field '${name}' doesn't exist on type 'PullRequest'`);
}

/** Root mutation fields. */
function mutationField(ctx: ExecContext, name: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const input = args.input !== null && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {};

  if (name === 'createIssue') {
    const repo = repoByNameOrId(forge, input.repositoryId);
    if (repo === undefined) throw new GraphQLError('Could not resolve to a Repository with the id given');
    const title = typeof input.title === 'string' ? input.title : '';
    repo.issues.push({
      id: forge.nextIdOf(repo),
      number: repo.nextIssueNumber++,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      userId: 1000,
      login: repo.owner,
      comments: 0,
      createdAt: forge.stampOf(repo),
      updatedAt: repo.updatedAt,
      closedAt: null,
    });
    const issue = repo.issues[repo.issues.length - 1] as Issue;
    return typed('CreateIssuePayload', { issue: typed('Issue', { repo, issue }) });
  }

  if (name === 'closeIssue') {
    const found = issueByGlobalId(forge, input.issueId);
    if (found === undefined) throw new GraphQLError('Could not resolve to an Issue with the id given');
    if (found.issue.state !== 'closed') {
      found.issue.state = 'closed';
      found.issue.closedAt = forge.stampOf(found.repo);
      found.issue.updatedAt = found.repo.updatedAt;
    }
    return typed('CloseIssuePayload', { issue: typed('Issue', found) });
  }

  if (name === 'createPullRequest') {
    const repo = repoByNameOrId(forge, input.repositoryId);
    if (repo === undefined) throw new GraphQLError('Could not resolve to a Repository with the id given');
    const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
    const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) throw new GraphQLError(`Could not resolve to a Ref named ${headRef}`);
    if (baseSha === undefined) throw new GraphQLError(`Could not resolve to a Ref named ${baseRef}`);
    const pull: Pull = {
      id: forge.nextIdOf(repo),
      number: repo.nextPullNumber++,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
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
    return typed('CreatePullRequestPayload', { pullRequest: typed('PullRequest', { repo, pull }) });
  }

  if (name === 'mergePullRequest') {
    const found = pullByGlobalId(forge, input.pullRequestId);
    if (found === undefined) throw new GraphQLError('Could not resolve to a PullRequest with the id given');
    const outcome = mergePull(forge, found.repo, found.pull);
    if (!outcome.ok) throw new GraphQLError(outcome.message);
    return typed('MergePullRequestPayload', { pullRequest: typed('PullRequest', found) });
  }

  if (name === 'addComment') {
    const found = issueByGlobalId(forge, input.subjectId) ?? pullAsIssue(forge, input.subjectId);
    if (found === undefined) throw new GraphQLError('Could not resolve to a subject with the id given');
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = {
      id: forge.nextIdOf(found.repo),
      body,
      userId: 1000,
      login: found.repo.owner,
      createdAt: forge.stampOf(found.repo),
    };
    const list = found.repo.comments.get(found.issue.number) ?? [];
    list.push(comment);
    found.repo.comments.set(found.issue.number, list);
    found.issue.comments = list.length;
    return typed('AddCommentPayload', {
      commentEdge: { node: typed('Comment', { comment, repo: found.repo, number: found.issue.number }) },
    });
  }

  throw new GraphQLError(`Field '${name}' doesn't exist on type 'Mutation'`);
}

/** The repository an input's `repositoryId` names: a global id, or a plain number. */
function repoByNameOrId(forge: Forge, raw: unknown): Repo | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = parseGlobalId(raw);
  if (parsed !== null && parsed.type === 'Repository') return repoById(forge, parsed.id);
  if (/^\d+$/.test(raw)) return repoById(forge, Number.parseInt(raw, 10));
  return undefined;
}

/** The issue a global id names, with the repository that holds it. */
function issueByGlobalId(forge: Forge, raw: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = parseGlobalId(raw);
  if (parsed === null || parsed.type !== 'Issue') return undefined;
  for (const repo of forge.all()) {
    const issue = repo.issues.find((candidate) => candidate.id === parsed.id);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

/** A pull request addressed the way a comment subject is: a pull request is an issue too. */
function pullAsIssue(forge: Forge, raw: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = parseGlobalId(raw);
  if (parsed === null || parsed.type !== 'PullRequest') return undefined;
  for (const repo of forge.all()) {
    const pull = repo.pulls.find((candidate) => candidate.id === parsed.id);
    if (pull !== undefined) {
      return {
        repo,
        issue: {
          id: pull.id,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          labels: [],
          userId: pull.userId,
          login: pull.login,
          comments: pull.comments,
          createdAt: pull.createdAt,
          updatedAt: pull.updatedAt,
          closedAt: null,
        },
      };
    }
  }
  return undefined;
}

/** The pull request a global id names, with the repository that holds it. */
function pullByGlobalId(forge: Forge, raw: unknown): { repo: Repo; pull: Pull } | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = parseGlobalId(raw);
  if (parsed === null || parsed.type !== 'PullRequest') return undefined;
  for (const repo of forge.all()) {
    const pull = repo.pulls.find((candidate) => candidate.id === parsed.id);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

/** User fields. */
function userField(name: string, value: { login: string }): unknown {
  if (name === 'login') return value.login;
  if (name === 'id') return globalId('User', 1000);
  if (name === 'name') return value.login;
  if (name === 'email') return `${value.login}@example.invalid`;
  if (name === '__typename') return 'User';
  throw new GraphQLError(`Field '${name}' doesn't exist on type 'User'`);
}

/** A ref's fields. */
function refField(name: string, value: { name: string; sha: string }): unknown {
  if (name === 'name') return value.name;
  if (name === 'target') return typed('Commit', { sha: value.sha });
  if (name === '__typename') return 'Ref';
  throw new GraphQLError(`Field '${name}' doesn't exist on type 'Ref'`);
}

/** A commit's fields. */
function commitField(name: string, value: { sha: string }): unknown {
  if (name === 'oid') return value.sha;
  if (name === 'abbreviatedOid') return value.sha.slice(0, 7);
  if (name === '__typename') return 'Commit';
  throw new GraphQLError(`Field '${name}' doesn't exist on type 'Commit'`);
}

/** A comment's fields. */
function commentField(name: string, value: { comment: { id: number; body: string }; repo: Repo; number: number }): unknown {
  if (name === 'id') return globalId('Comment', value.comment.id);
  if (name === 'body') return value.comment.body;
  if (name === '__typename') return 'Comment';
  throw new GraphQLError(`Field '${name}' doesn't exist on type 'Comment'`);
}

// ---------------------------------------------------------------------------- execution

/**
 * Resolve one typed value's selection set. A value this engine did not type (an introspection record,
 * a connection's `pageInfo`) is read as a plain object, which is what its resolvers already return.
 */
function project(ctx: ExecContext, value: unknown, selection: readonly SelectionNode[], variables: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => project(ctx, item, selection, variables));
  if (!isTyped(value)) {
    if (selection.length === 0) return value;
    const out: Record<string, unknown> = {};
    for (const node of selection) {
      if (node.kind === 'fragment') {
        Object.assign(out, project(ctx, value, node.selection, variables) as Record<string, unknown>);
        continue;
      }
      const key = node.alias ?? node.name;
      out[key] = project(ctx, (value as Record<string, unknown>)[node.name], node.selection, variables);
    }
    return out;
  }
  if (selection.length === 0) return value.value;

  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.onType !== null && node.onType !== value.__type) continue;
      const inner = project(ctx, value, node.selection, variables);
      if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) Object.assign(out, inner as Record<string, unknown>);
      continue;
    }
    const key = node.alias ?? node.name;
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of node.args) args[argName] = valueOf(argValue, variables);
    out[key] = project(ctx, resolveTyped(ctx, value, node.name, args), node.selection, variables);
  }
  return out;
}

/** Resolve one field of one typed value. */
function resolveTyped(ctx: ExecContext, holder: Typed, name: string, args: Record<string, unknown>): unknown {
  const type = holder.__type;
  if (type === 'Query') return queryField(ctx, name, args);
  if (type === 'Mutation') return mutationField(ctx, name, args);
  if (type === 'Repository') return repositoryField(ctx, holder.value as Repo, name, args);
  if (type === 'Issue') return issueField(ctx, holder.value as { repo: Repo; issue: Issue }, name);
  if (type === 'PullRequest') return pullField(ctx, holder.value as { repo: Repo; pull: Pull }, name, args);
  if (type === 'User') return userField(name, holder.value as { login: string });
  if (type === 'Ref') return refField(name, holder.value as { name: string; sha: string });
  if (type === 'Commit') return commitField(name, holder.value as { sha: string });
  if (type === 'Comment') return commentField(name, holder.value as { comment: { id: number; body: string }; repo: Repo; number: number });
  if (type === '__connection' || type === '__file' || type === '__Type') {
    const record = holder.value as Record<string, unknown>;
    if (name === '__typename') return type;
    if (!(name in record)) throw new GraphQLError(`Field '${name}' doesn't exist on type '${type}'`);
    return record[name];
  }
  if (type.endsWith('Payload')) {
    const record = holder.value as Record<string, unknown>;
    if (!(name in record)) throw new GraphQLError(`Field '${name}' doesn't exist on type '${type}'`);
    return record[name];
  }
  throw new GraphQLError(`Field '${name}' doesn't exist on type '${type}'`);
}

/** One operation against the store, as a GraphQL result body. */
function execute(ctx: ExecContext, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const root = typed(operation.kind === 'mutation' ? 'Mutation' : 'Query', {});
  const data = project(ctx, root, operation.selection, variables) as Record<string, unknown>;
  return { data };
}

/** Answer one GraphQL request, or return null when the path is not this surface's. */
export function handleGraphql(deps: RestDeps, req: Req): Out {
  if (req.method !== 'POST') return json(405, { errors: [{ message: 'GraphQL only answers POST' }] });

  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8') === '' ? '{}' : req.body.toString('utf8'));
  } catch {
    return json(400, { errors: [{ message: 'Problems parsing JSON', type: 'UNPROCESSABLE' }] });
  }

  const ctx: ExecContext = { forge: deps.forge, login: deps.forge.preferredOwner };

  // A batch is an array of documents and is answered with an array, one answer per document.
  if (Array.isArray(body)) {
    return json(200, body.map((entry) => answerOne(ctx, entry)));
  }
  return json(200, answerOne(ctx, body));
}

/** Answer one document, turning every failure into a GraphQL error rather than an HTTP error. */
function answerOne(ctx: ExecContext, raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') {
    return { errors: [{ message: 'Problems parsing JSON', type: 'UNPROCESSABLE' }] };
  }
  const request = raw as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') {
    return { errors: [{ message: "the request has no 'query' string" }] };
  }
  const variables: Record<string, unknown> =
    request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables)
      ? (request.variables as Record<string, unknown>)
      : {};

  let operations: OperationNode[];
  try {
    operations = parseDocument(request.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err), locations: [] }] };
  }

  const wanted = typeof request.operationName === 'string' && request.operationName !== '' ? request.operationName : null;
  const operation = wanted === null ? (operations[0] as OperationNode) : operations.find((candidate) => candidate.name === wanted);
  if (operation === undefined) return { errors: [{ message: `no operation named ${wanted ?? ''}` }] };

  try {
    return execute(ctx, operation, variables);
  } catch (err) {
    // A field the schema does not hold is an error that names it, with data null as GraphQL requires.
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err), locations: [], path: [] }] };
  }
}
