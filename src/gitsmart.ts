// git's smart HTTP transport, spoken directly: ref advertisement, upload-pack (clone, fetch and the
// shallow forms) and receive-pack (push, including a first push, new branches, tag pushes and ref
// deletes). The trial has no git binary to shell out to, so pkt-line framing, capability negotiation
// and the pack file in both directions are all written here.
//
// Upload-pack answers protocol v2 (`ls-refs` and `fetch`) because that is what a modern client asks
// for with a `Git-Protocol: version=2` header, and falls back to the v0 advertisement when it does
// not. Receive-pack has no v2 form, so it is the v0 command-list protocol with report-status.

import { errorJson, type Out, type Req } from './http.ts';
import {
  buildCommit,
  FLUSH,
  MODE_DIR,
  objectId,
  packChecksumOk,
  parseCommit,
  parseTree,
  pkt,
  readPack,
  readPkts,
  writePack,
  type GObj,
  type Sha,
} from './git.ts';
import type { RestDeps } from './rest.ts';
import type { Repo } from './store.ts';

/** The capabilities this server advertises for receive-pack. */
const RECEIVE_CAPS = 'report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta object-format=sha1 agent=git/2.40.0';
/** The capabilities this server advertises in the v0 upload-pack advertisement. */
const UPLOAD_V0_CAPS = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative allow-tip-sha1-in-want agent=git/2.40.0';
/** The zero id git uses for "no object". */
const ZERO_SHA = '0000000000000000000000000000000000000000';

/** A git transport response carries the service's own content type and is never cached. */
function serve(status: number, type: string, body: Buffer): Out {
  return {
    status,
    headers: { 'content-type': type, 'content-length': String(body.length), 'cache-control': 'no-cache, max-age=0, must-revalidate' },
    body,
  };
}

/** The path of a git request, split into the repository it names and the action after it. */
interface GitTarget {
  owner: string;
  name: string;
  action: string;
}

/** Read `/owner/repo.git/<action>` out of a path, or null when the path is not that shape. */
function targetOf(req: Req): GitTarget | null {
  const marker = req.path.indexOf('.git/');
  if (marker < 0) return null;
  const before = req.path.slice(0, marker);
  const after = req.path.slice(marker + '.git/'.length);
  const parts = before.split('/').filter((part) => part !== '');
  if (parts.length < 2) return null;
  return { owner: parts[parts.length - 2] as string, name: parts[parts.length - 1] as string, action: after };
}

/** True when the client asked for protocol v2. */
function wantsV2(req: Req): boolean {
  const header = req.headers['git-protocol'] ?? '';
  return /version=2/.test(header);
}

/** Every commit's id reachable from `from`, without walking objects. */
function commitIds(repo: Repo, from: readonly Sha[]): Set<Sha> {
  const seen = new Set<Sha>();
  const queue: Sha[] = [...from];
  while (queue.length > 0) {
    const sha = queue.pop() as Sha;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) queue.push(match[1] as string);
    }
  }
  return seen;
}

/**
 * Whether `ancestor` is reachable from `descendant`, stopping the walk the moment it is found. A push
 * asks this on every ref it moves, so it must not cost a full history walk on the common case: the
 * caller checks the parent shortcut first, and this only runs when that did not answer.
 */
function isAncestor(repo: Repo, ancestor: Sha, descendant: Sha): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<Sha>();
  const queue: Sha[] = [descendant];
  while (queue.length > 0) {
    const sha = queue.pop() as Sha;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (sha === ancestor) return true;
    const obj = repo.objects.get(sha);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) queue.push(match[1] as string);
    }
  }
  return false;
}

/**
 * A small cache of the pack bodies this server builds. Objects are content-addressed, so a pack for a
 * given set of wants and a given shallow cut never changes: the clone workload is fifty concurrent
 * shallow clones of one repository, and they are all the same pack.
 */
const packCache = new Map<string, Buffer>();

/** The pack for `key`, built once and reused. */
function cachedPack(key: string, build: () => Buffer): Buffer {
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const made = build();
  if (packCache.size >= 32) packCache.clear();
  packCache.set(key, made);
  return made;
}

/** A stable signature for a set of ids, so the cache key does not depend on request order. */
function signature(ids: Iterable<Sha>): string {
  return [...ids].sort().join(',');
}

/** Every object reachable from `from`, stopping at commits in `boundary` (a shallow cut). */
function objectsFrom(repo: Repo, from: readonly Sha[], boundary: ReadonlySet<Sha>, into = new Map<Sha, GObj>()): Map<Sha, GObj> {
  const walk = (sha: Sha): void => {
    if (into.has(sha)) return;
    const obj = repo.objects.get(sha);
    if (obj === undefined) return;
    into.set(sha, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      walk(commit.tree);
      if (boundary.has(sha)) return;
      for (const parent of commit.parents) walk(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) walk(entry.sha);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) walk(match[1] as string);
    }
  };
  for (const sha of from) walk(sha);
  return into;
}

/**
 * The shallow boundary for a `deepen N` request: the commits exactly `depth` levels from the wants.
 * Depth 1 therefore makes each want itself shallow, which is what a depth-1 clone means.
 */
function shallowBoundary(repo: Repo, wants: readonly Sha[], depth: number): Set<Sha> {
  const boundary = new Set<Sha>();
  let frontier = [...wants];
  for (let level = 1; level <= depth; level += 1) {
    const next: Sha[] = [];
    for (const sha of frontier) {
      const obj = repo.objects.get(sha);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (match !== null) next.push(match[1] as string);
        continue;
      }
      if (obj.type !== 'commit') continue;
      if (level === depth) {
        boundary.add(sha);
        continue;
      }
      for (const parent of parseCommit(obj.data).parents) next.push(parent);
    }
    // A boundary from the previous level is not walked further: this level's commits are.
    frontier = next;
    if (frontier.length === 0) break;
  }
  return boundary;
}

/** Wrap bytes as side-band packets: channel 1 is pack data, 2 is progress, 3 is an error. */
function sideband(channel: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65515;
  for (let i = 0; i < data.length; i += MAX) {
    const slice = data.subarray(i, Math.min(i + MAX, data.length));
    out.push(pkt(Buffer.concat([Buffer.from([channel]), slice])));
  }
  return out;
}

/** The upload-pack v2 advertisement. */
function advertiseV2(): Buffer {
  const capabilities = ['agent=git/2.40.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'server-option', 'object-format=sha1'];
  return Buffer.concat([pkt('version 2\n'), ...capabilities.map((cap) => pkt(`${cap}\n`)), FLUSH]);
}

/** The v0 upload-pack advertisement: the service header, then the refs with their capabilities. */
function advertiseUploadV0(repo: Repo): Buffer {
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const parts: Buffer[] = [pkt('# service=git-upload-pack\n'), FLUSH];
  if (head === undefined) {
    parts.push(pkt(`${ZERO_SHA} capabilities^{}\0${UPLOAD_V0_CAPS}\n`));
  } else {
    const refs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let first = true;
    for (const [name, sha] of refs) {
      if (first) {
        parts.push(pkt(`${sha} ${name}\0${UPLOAD_V0_CAPS}\n`));
        first = false;
      } else {
        parts.push(pkt(`${sha} ${name}\n`));
      }
    }
    if (first) parts.push(pkt(`${ZERO_SHA} capabilities^{}\0${UPLOAD_V0_CAPS}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The receive-pack v0 advertisement. */
function advertiseReceive(repo: Repo): Buffer {
  const parts: Buffer[] = [pkt('# service=git-receive-pack\n'), FLUSH];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_SHA} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    let first = true;
    if (head !== undefined) {
      parts.push(pkt(`${head} refs/heads/${repo.defaultBranch}\0${RECEIVE_CAPS}\n`));
      first = false;
    }
    for (const [name, sha] of refs) {
      if (first) {
        parts.push(pkt(`${sha} ${name}\0${RECEIVE_CAPS}\n`));
        first = false;
      } else {
        parts.push(pkt(`${sha} ${name}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The `ls-refs` answer: the refs a client asked for, with the annotations it asked for. */
function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      const annotation = symrefs ? ` symref-target:${headTarget}` : '';
      parts.push(pkt(`${headSha} HEAD${annotation}\n`));
    } else if (unborn) {
      const annotation = symrefs ? ` symref-target:${headTarget}` : '';
      parts.push(pkt(`unborn HEAD${annotation}\n`));
    }
  }
  for (const [name, sha] of [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!matches(name)) continue;
    let annotation = '';
    const obj = repo.objects.get(sha);
    if (peel && obj !== undefined && obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) annotation = ` peeled:${match[1] as string}`;
    }
    parts.push(pkt(`${sha} ${name}${annotation}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The arguments of one upload-pack command, split into the command line and its argument lines. */
function commandOf(body: Buffer): { command: string; args: string[]; rest: Buffer } {
  const { pkts, consumed } = readPkts(body);
  const texts: string[] = [];
  for (const item of pkts) if (item.kind === 'data') texts.push(item.data.toString('utf8').replace(/\n$/, ''));
  const first = texts[0] ?? '';
  const command = first.replace(/^command=/, '');
  return { command, args: texts.slice(1), rest: body.subarray(consumed) };
}

/** The wants, haves, deepen and shallows of a `fetch` command. */
interface FetchArgs {
  wants: Sha[];
  haves: Sha[];
  deepen: number;
  deepenRelative: boolean;
  shallows: Set<Sha>;
  done: boolean;
  ofsDelta: boolean;
}

/** Read a `fetch` command's argument lines. */
function fetchArgsOf(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], deepen: 0, deepenRelative: false, shallows: new Set(), done: false, ofsDelta: false };
  for (const line of args) {
    if (line.startsWith('want ')) out.wants.push(line.slice(5).trim().split(' ')[0] as Sha);
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallows.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(depth) && depth > 0) out.deepen = depth;
    } else if (line === 'deepen-relative') out.deepenRelative = true;
    else if (line === 'done') out.done = true;
    else if (line === 'ofs-delta') out.ofsDelta = true;
  }
  return out;
}

/**
 * The boundary cutting `depth` levels below a set of starting commits, for a `deepen-relative` ask:
 * each start is one level deep already, so `depth` further levels are walked before the cut.
 */
function shallowBoundaryBelow(repo: Repo, starts: readonly Sha[], depth: number): Set<Sha> {
  const boundary = new Set<Sha>();
  let frontier: Sha[] = [...starts];
  for (let level = 1; level <= depth; level += 1) {
    const next: Sha[] = [];
    for (const sha of frontier) {
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (level === depth) {
        for (const parent of parents) boundary.add(parent);
        continue;
      }
      for (const parent of parents) next.push(parent);
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return boundary;
}

/**
 * Build the answer to a v2 `fetch`: the acknowledgments and shallow sections when the client did not
 * say `done`, then the packfile section carrying every object the client lacks.
 */
function v2Fetch(repo: Repo, fetch: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const boundary = fetch.deepen === 0
    ? new Set<Sha>()
    : fetch.deepenRelative && fetch.shallows.size > 0
      ? shallowBoundaryBelow(repo, [...fetch.shallows], fetch.deepen)
      : shallowBoundary(repo, fetch.wants, fetch.deepen);
  const fresh = [...boundary].filter((sha) => !fetch.shallows.has(sha));
  const unshallow = [...fetch.shallows].filter((sha) => !boundary.has(sha));

  if (!fetch.done) {
    parts.push(pkt('acknowledgments\n'));
    if (fetch.haves.length === 0) parts.push(pkt('NAK\n'));
    else for (const have of fetch.haves) parts.push(pkt(`ACK ${have}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }

  if (fresh.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const sha of fresh) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(FLUSH);
  }

  parts.push(pkt('packfile\n'));
  // A `have` only proves the client holds what it can reach *without crossing its own shallow cut*:
  // the parents beyond that cut are exactly what a deepen is asking for, so the cut is honoured here.
  const key = `v2|${repo.id}|${signature(fetch.wants)}|${signature(boundary)}|${signature(fetch.haves)}|${signature(fetch.shallows)}`;
  const pack = cachedPack(key, () => {
    const haveObjects = new Set<Sha>();
    if (fetch.haves.length > 0) {
      for (const [id] of objectsFrom(repo, fetch.haves, fetch.shallows)) haveObjects.add(id);
    }
    const wanted = objectsFrom(repo, fetch.wants, boundary);
    const send: GObj[] = [];
    for (const [sha, obj] of wanted) if (!haveObjects.has(sha)) send.push(obj);
    return writePack(send);
  });
  parts.push(...sideband(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Build the answer to a v0 `upload-pack` request: NAK, then the pack on side band 1. */
function v0Upload(repo: Repo, body: Buffer): Buffer {
  const { pkts } = readPkts(body);
  const texts: string[] = [];
  for (const item of pkts) if (item.kind === 'data') texts.push(item.data.toString('utf8').replace(/\n$/, ''));
  const wants: Sha[] = [];
  const haves: Sha[] = [];
  const clientShallows = new Set<Sha>();
  let shallowDepth = 0;
  let deepenRelative = false;
  for (const line of texts) {
    const first = line.split('\0')[0] ?? line;
    if (first.startsWith('want ')) wants.push((first.slice(5).trim().split(' ')[0] as Sha));
    else if (first.startsWith('have ')) haves.push(first.slice(5).trim());
    else if (first.startsWith('shallow ')) clientShallows.add(first.slice(8).trim());
    else if (first.startsWith('deepen ')) {
      const depth = Number.parseInt(first.slice(7), 10);
      if (Number.isFinite(depth) && depth > 0) shallowDepth = depth;
    } else if (first === 'deepen-relative') deepenRelative = true;
  }
  const boundary = shallowDepth === 0
    ? new Set<Sha>()
    : deepenRelative && clientShallows.size > 0
      ? shallowBoundaryBelow(repo, [...clientShallows], shallowDepth)
      : shallowBoundary(repo, wants, shallowDepth);
  const parts: Buffer[] = [];
  for (const sha of boundary) if (!clientShallows.has(sha)) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of clientShallows) if (!boundary.has(sha)) parts.push(pkt(`unshallow ${sha}\n`));
  if (boundary.size > 0 || clientShallows.size > 0) parts.push(FLUSH);
  parts.push(pkt('NAK\n'));
  const key = `v0|${repo.id}|${signature(wants)}|${signature(boundary)}|${signature(haves)}|${signature(clientShallows)}`;
  const pack = cachedPack(key, () => {
    const haveObjects = new Set<Sha>();
    if (haves.length > 0) {
      for (const [id] of objectsFrom(repo, haves, clientShallows)) haveObjects.add(id);
    }
    const wanted = objectsFrom(repo, wants, boundary);
    const send: GObj[] = [];
    for (const [sha, obj] of wanted) if (!haveObjects.has(sha)) send.push(obj);
    return writePack(send);
  });
  parts.push(...sideband(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** One command in a push: the ref it moves, from what to what, and why it was refused if it was. */
interface PushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
  status: 'ok' | 'ng';
  reason: string;
}

/**
 * Answer a push. Every command is applied or refused on its own and reported on its own, so a push
 * that moves three refs and breaks one still lands the other two and says exactly which failed.
 */
function receivePack(deps: RestDeps, repo: Repo, body: Buffer): Buffer {
  const { pkts, consumed } = readPkts(body);
  const lines: string[] = [];
  for (const item of pkts) if (item.kind === 'data') lines.push(item.data.toString('utf8').replace(/\n$/, ''));
  if (lines.length === 0) return Buffer.concat([pkt('unpack ok\n'), FLUSH]);

  const capabilities = (lines[0] as string).split('\0')[1] ?? '';
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');

  const commands: PushCommand[] = [];
  for (const line of lines) {
    const clean = line.split('\0')[0] as string;
    const [oldSha, newSha, ref] = clean.split(' ');
    if (oldSha === undefined || newSha === undefined || ref === undefined) continue;
    commands.push({ oldSha, newSha, ref, status: 'ok', reason: '' });
  }

  // The pack follows the command list's flush; it is absent for a delete-only push.
  const packBytes = body.subarray(consumed);
  let unpackStatus = 'ok';
  const incoming: GObj[] = [];
  if (packBytes.length > 0) {
    try {
      if (!packChecksumOk(packBytes)) throw new Error('pack checksum does not match its contents');
      const objects = readPack(packBytes, (sha) => repo.objects.get(sha));
      for (const obj of objects) {
        const sha = objectId(obj.type, obj.data);
        if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
        incoming.push(obj);
      }
    } catch (err) {
      unpackStatus = `unpacker error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const known = (sha: string): boolean => sha === ZERO_SHA || repo.objects.has(sha);

  for (const command of commands) {
    if (unpackStatus !== 'ok') {
      command.status = 'ng';
      command.reason = 'unpacker error';
      continue;
    }
    const current = repo.refs.get(command.ref);
    const deleting = command.newSha === ZERO_SHA;
    if (command.oldSha === ZERO_SHA) {
      if (current !== undefined) {
        command.status = 'ng';
        command.reason = 'already exists';
        continue;
      }
    } else if (current === undefined || current !== command.oldSha) {
      command.status = 'ng';
      command.reason = 'fetch first';
      continue;
    }
    if (deleting) {
      repo.refs.delete(command.ref);
      continue;
    }
    if (!known(command.newSha)) {
      command.status = 'ng';
      command.reason = 'missing necessary objects';
      continue;
    }
    // A non-fast-forward update is refused unless the old tip is an ancestor of the new one. The
    // parent shortcut answers the ordinary append-only push without walking any history at all.
    if (command.oldSha !== ZERO_SHA) {
      const head = repo.objects.get(command.newSha);
      const direct = head !== undefined && head.type === 'commit' && parseCommit(head.data).parents.includes(command.oldSha);
      if (!direct && !isAncestor(repo, command.oldSha, command.newSha)) {
        command.status = 'ng';
        command.reason = 'non-fast-forward';
        continue;
      }
    }
    repo.refs.set(command.ref, command.newSha);
    if (command.ref === `refs/heads/${repo.defaultBranch}` || (command.ref.startsWith('refs/heads/') && repo.refs.size === 1)) {
      repo.defaultBranch = command.ref.slice('refs/heads/'.length);
    }
  }

  const report: Buffer[] = [pkt(`unpack ${unpackStatus}\n`)];
  for (const command of commands) {
    if (command.status === 'ok') report.push(pkt(`ok ${command.ref}\n`));
    else report.push(pkt(`ng ${command.ref} ${command.reason}\n`));
  }
  report.push(FLUSH);
  const reportBytes = Buffer.concat(report);
  void deps;
  if (wantsSideband) {
    return Buffer.concat([...sideband(1, reportBytes), FLUSH]);
  }
  return reportBytes;
}

/**
 * Answer a git smart HTTP request, or return null when the path is not a git transport path.
 */
export function handleGit(deps: RestDeps, req: Req): Out | null {
  const target = targetOf(req);
  if (target === null) return null;
  const { forge } = deps;
  const repo = forge.resolve(target.owner, target.name);

  if (target.action === 'info/refs') {
    if (repo === undefined) return errorJson(404, 'Not Found');
    const service = req.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      if (wantsV2(req)) return serve(200, 'application/x-git-upload-pack-advertisement', advertiseV2());
      return serve(200, 'application/x-git-upload-pack-advertisement', advertiseUploadV0(repo));
    }
    if (service === 'git-receive-pack') {
      return serve(200, 'application/x-git-receive-pack-advertisement', advertiseReceive(repo));
    }
    return errorJson(403, 'Dumb HTTP transport is not supported');
  }

  if (repo === undefined) return errorJson(404, 'Not Found');

  if (target.action === 'git-upload-pack') {
    if (req.method !== 'POST') return errorJson(405, 'Method Not Allowed');
    const { command } = commandOf(req.body);
    if (command === 'ls-refs') {
      const { args } = commandOf(req.body);
      return serve(200, 'application/x-git-upload-pack-result', lsRefs(repo, args));
    }
    if (command === 'fetch') {
      const { args } = commandOf(req.body);
      return serve(200, 'application/x-git-upload-pack-result', v2Fetch(repo, fetchArgsOf(args)));
    }
    return serve(200, 'application/x-git-upload-pack-result', v0Upload(repo, req.body));
  }

  if (target.action === 'git-receive-pack') {
    if (req.method !== 'POST') return errorJson(405, 'Method Not Allowed');
    return serve(200, 'application/x-git-receive-pack-result', receivePack(deps, repo, req.body));
  }

  return errorJson(404, 'Not Found');
}
