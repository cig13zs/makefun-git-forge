// The forge's store: repositories, their git objects and refs, and the issue, label, comment and pull
// request records the REST surface keeps. One process, one trial, so it is all in memory; nothing here
// reads a clock or a random number, which is what makes a trial's pass/fail bits replay identically.
//
// A repository owns its own object table. Every write that makes a commit builds real git trees and
// commits and hashes them with sha1, so `git clone` of a repository this server wrote and the contents
// API agree byte for byte.

import {
  buildCommit,
  buildTag,
  buildTree,
  isDirMode,
  MODE_DIR,
  objectId,
  parseCommit,
  parseTree,
  type CommitData,
  type GObj,
  type GitType,
  type Identity,
  type Sha,
  type TagData,
} from './git.ts';

/** The epoch every generated commit timestamp counts from: fixed, so commits replay identically. */
const BASE_EPOCH = 1_700_000_000;

/** A user of the forge. `id` is stable and unique within a process. */
export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** One label attached to a repository. */
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

/** One issue comment. */
export interface Comment {
  id: number;
  body: string;
  userId: number;
  login: string;
  createdAt: string;
}

/** One issue. `number` is the repository's, counting from 1. */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userId: number;
  login: string;
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** One pull request. A pull request is an issue too, as GitHub's is, and shares its numbering. */
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  userId: number;
  login: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  labels: string[];
  /** The commit the two sides last shared, and the diff summary, worked out when the pull is read. */
  mergeable: boolean;
}

/** A repository: its refs, its object table, and the REST records hanging off it. */
export interface Repo {
  id: number;
  /** The owner login this repository answers to; learned from the first request that names it. */
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<Sha, GObj>;
  refs: Map<string, Sha>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  comments: Map<number, Comment[]>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextId: number;
  /** Set once a repository has been read under an owner login, so a second login answers 404. */
  ownerLocked: boolean;
}

/** What a caller may set when creating a repository. */
export interface NewRepo {
  name: string;
  description?: string;
  private?: boolean;
  defaultBranch?: string;
}

/** A file as the contents API shows it. */
export interface FileAt {
  path: string;
  mode: string;
  sha: Sha;
  size: number;
  data: Buffer;
}

/** The outcome of writing a path: the commit it landed in and the blob it wrote. */
export interface WriteResult {
  commit: Sha;
  blob: Sha;
  created: boolean;
}

/**
 * The whole forge. One instance per process; the HTTP layer holds no state of its own.
 */
export class Forge {
  private users = new Map<string, User>();
  private repos = new Map<string, Repo>();
  private nextUserId = 1000;
  private nextRepoId = 1;
  private clock = 0;

  /** The logins this process has learned belong to the one bearer token. */
  readonly tokenLogins = new Set<string>();
  /** The login a token-created repository is reported under before a read names its owner. */
  preferredOwner = 'forge';

  /**
   * A monotonic, clock-free timestamp: the base epoch plus one second per commit. Two runs that issue
   * the same requests therefore build byte-identical commits and the same object ids.
   */
  private tick(): number {
    this.clock += 1;
    return BASE_EPOCH + this.clock;
  }

  /** An ISO 8601 stamp for a record, from the same clock-free counter. */
  private stamp(): string {
    return new Date(this.tick() * 1000).toISOString();
  }

  /** The user with `login`, made on first sight so a token always has someone to be. */
  user(login: string): User {
    let found = this.users.get(login);
    if (found === undefined) {
      found = {
        id: this.nextUserId++,
        login,
        name: login,
        email: `${login}@example.invalid`,
      };
      this.users.set(login, found);
    }
    return found;
  }

  /** The identity a commit this forge writes carries. */
  private identity(login: string): Identity {
    const user = this.user(login);
    return { name: user.name, email: user.email, ts: this.tick(), tz: '+0000' };
  }

  // -------------------------------------------------------------------------- repositories

  /** `owner/name` lowercased: the key a repository is stored under. */
  private static key(name: string): string {
    return name.toLowerCase();
  }

  /** A repository by name alone, whatever login the caller used. */
  byName(name: string): Repo | undefined {
    return this.repos.get(Forge.key(name));
  }

  /**
   * Resolve `owner/name` to a repository. A repository answers to exactly one owner login: the first
   * one a caller names it under. A second login asking for the same name gets nothing, which is how a
   * repository that is not yours is a 404 rather than a 403.
   */
  resolve(owner: string, name: string): Repo | undefined {
    const repo = this.repos.get(Forge.key(name));
    if (repo === undefined) return undefined;
    if (!repo.ownerLocked) {
      repo.owner = owner;
      repo.ownerLocked = true;
      this.tokenLogins.add(owner.toLowerCase());
      this.preferredOwner = owner;
      return repo;
    }
    return repo.owner.toLowerCase() === owner.toLowerCase() ? repo : undefined;
  }

  /** Create a repository owned by `owner`, or return the one already there. */
  create(owner: string, spec: NewRepo): Repo {
    const existing = this.repos.get(Forge.key(spec.name));
    if (existing !== undefined) return existing;
    const stamp = this.stamp();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name: spec.name,
      description: spec.description ?? '',
      private: spec.private === true,
      defaultBranch: spec.defaultBranch ?? 'main',
      createdAt: stamp,
      updatedAt: stamp,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      comments: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextId: 1,
      ownerLocked: false,
    };
    this.repos.set(Forge.key(spec.name), repo);
    this.tokenLogins.add(owner.toLowerCase());
    return repo;
  }

  /** Remove a repository entirely. */
  remove(name: string): boolean {
    return this.repos.delete(Forge.key(name));
  }

  /** Every repository, in creation order. */
  all(): Repo[] {
    return [...this.repos.values()];
  }

  /** A new id within one repository, for labels, issues, pulls and comments. */
  nextIdOf(repo: Repo): number {
    return repo.nextId++;
  }

  /** A record timestamp for a repository. */
  stampOf(repo: Repo): string {
    const stamp = this.stamp();
    repo.updatedAt = stamp;
    return stamp;
  }

  // -------------------------------------------------------------------------- objects

  /** Store an object and return its id. */
  put(repo: Repo, type: GitType, data: Buffer): Sha {
    const sha = objectId(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  /** An object by id, or undefined. */
  object(repo: Repo, sha: Sha): GObj | undefined {
    return repo.objects.get(sha);
  }

  /** A commit by id, or undefined when it is not a commit. */
  commit(repo: Repo, sha: Sha): (CommitData & { sha: Sha }) | undefined {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return { ...parseCommit(obj.data), sha };
  }

  /** A tree's entries by id. */
  tree(repo: Repo, sha: Sha) {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    return parseTree(obj.data);
  }

  /** The object a tag names, and the tag itself when the id is an annotated tag. */
  peel(repo: Repo, sha: Sha, type: GitType): Sha | undefined {
    let current = sha;
    for (let guard = 0; guard < 16; guard += 1) {
      const obj = repo.objects.get(current);
      if (obj === undefined) return undefined;
      if (obj.type === type) return current;
      if (obj.type !== 'tag') return undefined;
      const next = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (next === null) return undefined;
      current = next[1] as string;
    }
    return undefined;
  }

  /** The object id a ref name resolves to, following a symbolic ref if one is stored. */
  resolveRef(repo: Repo, name: string): Sha | undefined {
    return repo.refs.get(name) ?? (name === 'HEAD' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : undefined);
  }

  /** Every ref, as `[name, sha]`, HEAD first then heads then tags, both sorted. */
  refs(repo: Repo): [string, Sha][] {
    const heads = [...repo.refs.entries()].filter(([n]) => n.startsWith('refs/heads/')).sort((a, b) => a[0].localeCompare(b[0]));
    const tags = [...repo.refs.entries()].filter(([n]) => n.startsWith('refs/tags/')).sort((a, b) => a[0].localeCompare(b[0]));
    const out: [string, Sha][] = [];
    const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (head !== undefined) out.push(['HEAD', head]);
    return [...out, ...heads, ...tags];
  }

  /** The commit a branch, tag or id names, peeling tags and defaulting to the default branch. */
  tip(repo: Repo, ref?: string): Sha | undefined {
    if (ref === undefined || ref === '') return this.resolveRef(repo, `refs/heads/${repo.defaultBranch}`);
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    for (const candidate of [ref, `refs/heads/${ref}`, `refs/tags/${ref}`]) {
      const sha = repo.refs.get(candidate);
      if (sha !== undefined) return sha;
    }
    return this.resolveRef(repo, `refs/heads/${ref}`);
  }

  // -------------------------------------------------------------------------- trees on disk

  /** Every file in a tree, flattened to `path -> {mode, sha}`, in path order. */
  flatten(repo: Repo, treeSha: Sha, prefix = '', into = new Map<string, { mode: string; sha: Sha }>()): Map<string, { mode: string; sha: Sha }> {
    const entries = this.tree(repo, treeSha);
    if (entries === undefined) return into;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isDirMode(entry.mode)) this.flatten(repo, entry.sha, path, into);
      else into.set(path, { mode: entry.mode, sha: entry.sha });
    }
    return into;
  }

  /** Build a tree from `path -> {mode, sha}`, nesting directories as git does. */
  buildTreeFrom(repo: Repo, flat: ReadonlyMap<string, { mode: string; sha: Sha }>): Sha {
    interface Dir {
      files: Map<string, { mode: string; sha: Sha }>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let dir = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i] as string;
        let sub = dir.dirs.get(name);
        if (sub === undefined) {
          sub = { files: new Map(), dirs: new Map() };
          dir.dirs.set(name, sub);
        }
        dir = sub;
      }
      dir.files.set(parts[parts.length - 1] as string, entry);
    }
    const writeDir = (dir: Dir): Sha => {
      const entries: { mode: string; name: string; sha: Sha }[] = [];
      for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
      for (const [name, sub] of dir.dirs) entries.push({ mode: MODE_DIR, name, sha: writeDir(sub) });
      return this.put(repo, 'tree', buildTree(entries));
    };
    return writeDir(root);
  }

  /** The flattened files of a commit. */
  filesOf(repo: Repo, commitSha: Sha): Map<string, { mode: string; sha: Sha }> {
    const commit = this.commit(repo, commitSha);
    if (commit === undefined) return new Map();
    return this.flatten(repo, commit.tree);
  }

  /**
   * Commit a new tree over `parent`, taking `login` as the committer. `extraParents` makes a merge
   * commit: the first parent is `parent`, the rest follow in the order given.
   */
  commitTree(
    repo: Repo,
    parent: Sha | undefined,
    flat: ReadonlyMap<string, { mode: string; sha: Sha }>,
    message: string,
    login: string,
    extraParents: readonly Sha[] = [],
  ): Sha {
    const tree = this.buildTreeFrom(repo, flat);
    const identity = this.identity(login);
    const parents = parent === undefined ? [...extraParents] : [parent, ...extraParents];
    const data = buildCommit({
      tree,
      parents,
      author: identity,
      committer: identity,
      message,
    });
    return this.put(repo, 'commit', data);
  }

  /** Put an annotated tag object and record its ref. */
  putTag(repo: Repo, name: string, target: Sha, message: string, login: string): Sha {
    const targetObj = repo.objects.get(target);
    const data: TagData = {
      object: target,
      type: targetObj?.type ?? 'commit',
      tag: name,
      tagger: this.identity(login),
      message,
    };
    const sha = this.put(repo, 'tag', buildTag(data));
    repo.refs.set(`refs/tags/${name}`, sha);
    return sha;
  }

  // -------------------------------------------------------------------------- history

  /** Every commit reachable from `from`, newest first, walking parents breadth first. */
  history(repo: Repo, from: Sha, limit = 10_000): (CommitData & { sha: Sha })[] {
    const seen = new Set<Sha>();
    const out: (CommitData & { sha: Sha })[] = [];
    const queue: Sha[] = [];
    const start = this.peel(repo, from, 'commit');
    if (start === undefined) return out;
    queue.push(start);
    while (queue.length > 0 && out.length < limit) {
      const sha = queue.shift() as Sha;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.commit(repo, sha);
      if (commit === undefined) continue;
      out.push(commit);
      for (const parent of commit.parents) queue.push(parent);
    }
    out.sort((a, b) => b.committer.ts - a.committer.ts || a.sha.localeCompare(b.sha));
    return out;
  }

  /** Every object reachable from a commit, itself included: what a clone has to be sent. */
  reachable(repo: Repo, from: Sha, into = new Map<Sha, GObj>()): Map<Sha, GObj> {
    const walk = (sha: Sha): void => {
      if (into.has(sha)) return;
      const obj = repo.objects.get(sha);
      if (obj === undefined) return;
      into.set(sha, obj);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        walk(commit.tree);
        for (const parent of commit.parents) walk(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) walk(entry.sha);
      } else if (obj.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (match !== null) walk(match[1] as string);
      }
    };
    walk(from);
    return into;
  }
}
