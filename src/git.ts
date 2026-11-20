// The git object model: object framing and hashing, trees, commits, tags, the pkt-line framing
// git's wire uses, and pack files in both directions. Nothing here knows about HTTP or the forge's
// store: it is the smallest self-contained git core the rest of the server is built on.
//
// Objects are held in memory uncompressed, framed as git frames them (`<type> <size>\0<content>`),
// and hashed with sha1 over exactly those bytes, so an object this server stores and the same
// object a real git client sends hash to the same id.

import { createHash } from 'node:crypto';
import { constants as Z, deflateSync, inflateSync } from 'node:zlib';

/** The four object types git records. */
export type GitType = 'blob' | 'tree' | 'commit' | 'tag';

/** One stored object: its type and its raw (uncompressed) content. */
export interface GObj {
  type: GitType;
  data: Buffer;
}

/** 40 hex characters, lowercase: a git object id. */
export type Sha = string;

/** The pack type codes git assigns. */
const PACK_TYPE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_BY_PACK_CODE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** A sha1 of some bytes, lowercase hex: what every id in this module is. */
export function sha1(...parts: readonly (Buffer | string)[]): Sha {
  const h = createHash('sha1');
  for (const part of parts) h.update(typeof part === 'string' ? Buffer.from(part, 'utf8') : part);
  return h.digest('hex');
}

/** The bytes git hashes for an object: `<type> <size>\0` then the content. */
export function frame(type: GitType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]);
}

/** The id of an object: sha1 of its frame. */
export function objectId(type: GitType, data: Buffer): Sha {
  return sha1(frame(type, data));
}

// ---------------------------------------------------------------------------- trees

/** One directory entry: git's mode string, the name, and the object it names. */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: Sha;
}

/** The mode git records for a directory. */
export const MODE_DIR = '40000';
/** The mode git records for a regular file. */
export const MODE_FILE = '100644';
/** The mode git records for an executable file. */
export const MODE_EXEC = '100755';
/** The mode git records for a symlink. */
export const MODE_LINK = '120000';

/**
 * The byte string git sorts tree entries by: the name, then a `/` for a directory, so that `a` as a
 * directory sorts before `a.txt` and `a` as a file sorts after it. Getting this wrong produces a tree
 * whose id differs from the one a real client computes, so it is done exactly as git's
 * `base_name_compare` does it.
 */
function sortKey(entry: TreeEntry): Buffer {
  const name = Buffer.from(entry.name, 'utf8');
  return entry.mode === MODE_DIR ? Buffer.concat([name, Buffer.from('/')]) : name;
}

/** Compare two tree entries the way git orders them. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  return Buffer.compare(sortKey(a), sortKey(b));
}

/** Parse a tree object's content into its entries, in the order they are stored. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const mode = data.toString('utf8', i, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** Build a tree object's content from entries: git order, `<mode> <name>\0<20 raw bytes>`. */
export function buildTree(input: readonly TreeEntry[]): Buffer {
  const entries = [...input].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------- commits and tags

/** A git identity line: who, and when, with the raw timezone offset git stores (`+0000`). */
export interface Identity {
  name: string;
  email: string;
  ts: number;
  tz: string;
}

/** Everything a commit object holds. */
export interface CommitData {
  tree: Sha;
  parents: Sha[];
  author: Identity;
  committer: Identity;
  message: string;
  /** Any further headers, verbatim, in the order they were read (`gpgsig`, `encoding`, ...). */
  extra?: string[];
}

/** `Name <email> 1700000000 +0000` on one line, as git writes it. */
function identityLine(kind: string, id: Identity): string {
  return `${kind} ${id.name} <${id.email}> ${id.ts} ${id.tz}\n`;
}

/** Build a commit object's content. */
export function buildCommit(c: CommitData): Buffer {
  const lines: string[] = [`tree ${c.tree}\n`];
  for (const parent of c.parents) lines.push(`parent ${parent}\n`);
  lines.push(identityLine('author', c.author));
  lines.push(identityLine('committer', c.committer));
  for (const extra of c.extra ?? []) lines.push(`${extra}\n`);
  lines.push('\n');
  return Buffer.concat([Buffer.from(lines.join(''), 'utf8'), Buffer.from(c.message, 'utf8')]);
}

/** Read one `Name <email> <ts> <tz>` line. */
function parseIdentity(line: string): Identity {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>', lt);
  const name = lt < 0 ? line.trim() : line.slice(0, lt).trim();
  const email = lt < 0 || gt < 0 ? '' : line.slice(lt + 1, gt);
  const tail = gt < 0 ? '' : line.slice(gt + 1).trim();
  const bits = tail.split(/\s+/).filter((x) => x !== '');
  const ts = Number.parseInt(bits[0] ?? '0', 10);
  const tz = bits[1] ?? '+0000';
  return { name, email, ts: Number.isFinite(ts) ? ts : 0, tz };
}

/** Parse a commit object's content. A malformed commit still yields every field it did carry. */
export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: Sha[] = [];
  let author: Identity = { name: '', email: '', ts: 0, tz: '+0000' };
  let committer: Identity = { name: '', email: '', ts: 0, tz: '+0000' };
  const extra: string[] = [];
  for (const raw of head.split('\n')) {
    if (raw === '') continue;
    if (raw.startsWith('tree ')) tree = raw.slice(5).trim();
    else if (raw.startsWith('parent ')) parents.push(raw.slice(7).trim());
    else if (raw.startsWith('author ')) author = parseIdentity(raw.slice(7));
    else if (raw.startsWith('committer ')) committer = parseIdentity(raw.slice(10));
    else extra.push(raw);
  }
  const result: CommitData = { tree, parents, author, committer, message };
  if (extra.length > 0) result.extra = extra;
  return result;
}

/** A tag object's content: what it points at, and who tagged it. */
export interface TagData {
  object: Sha;
  type: GitType;
  tag: string;
  tagger: Identity;
  message: string;
}

/** Build an annotated tag object's content. */
export function buildTag(t: TagData): Buffer {
  const head = [
    `object ${t.object}\n`,
    `type ${t.type}\n`,
    `tag ${t.tag}\n`,
    identityLine('tagger', t.tagger),
    '\n',
  ].join('');
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(t.message, 'utf8')]);
}

/** Parse an annotated tag object's content. */
export function parseTag(data: Buffer): TagData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitType = 'commit';
  let tag = '';
  let tagger: Identity = { name: '', email: '', ts: 0, tz: '+0000' };
  for (const raw of head.split('\n')) {
    if (raw.startsWith('object ')) object = raw.slice(7).trim();
    else if (raw.startsWith('type ')) type = raw.slice(5).trim() as GitType;
    else if (raw.startsWith('tag ')) tag = raw.slice(4).trim();
    else if (raw.startsWith('tagger ')) tagger = parseIdentity(raw.slice(7));
  }
  return { object, type, tag, tagger, message };
}

/** True when `mode` names a directory. */
export function isDirMode(mode: string): boolean {
  return mode === MODE_DIR || mode === '040000';
}

// ---------------------------------------------------------------------------- pkt-line

/** A pkt-line of some text or bytes, its 4 hex digit length included. */
export function pkt(text: string | Buffer): Buffer {
  const body = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The empty pkt-line that ends a section (`0000`). */
export const FLUSH = Buffer.from('0000', 'ascii');
/** The empty pkt-line that separates a section's command from its payload (`0001`). */
export const DELIM = Buffer.from('0001', 'ascii');

/** One framed piece of a pkt-line stream. */
export type Pkt =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a pkt-line stream. `consumed` is where the stream stopped, so a pack after it can be read. */
export function readPkts(buf: Buffer, from = 0): { pkts: Pkt[]; consumed: number } {
  const pkts: Pkt[] = [];
  let i = from;
  while (i + 4 <= buf.length) {
    const length = Number.parseInt(buf.toString('ascii', i, i + 4), 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0) {
      pkts.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (length === 1) {
      pkts.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (length === 2) {
      pkts.push({ kind: 'response-end' });
      i += 4;
      continue;
    }
    if (i + length > buf.length) break;
    pkts.push({ kind: 'data', data: buf.subarray(i + 4, i + length) });
    i += length;
  }
  return { pkts, consumed: i };
}

/** The text of every data pkt in a stream, with its trailing newline removed. */
export function pktTexts(pkts: readonly Pkt[]): string[] {
  const out: string[] = [];
  for (const p of pkts) if (p.kind === 'data') out.push(p.data.toString('utf8').replace(/\n$/, ''));
  return out;
}

// ---------------------------------------------------------------------------- packs

/** One object as a pack round-trips it, before or after delta resolution. */
export interface PackObject extends GObj {}

/** Encode an object's type and size as a pack entry header (the bytes before the deflate stream). */
function packHeader(type: GitType, size: number): Buffer {
  const out: number[] = [];
  let byte = (PACK_TYPE[type] << 4) | (size & 0x0f);
  let rest = size >>> 4;
  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest >>>= 7;
  }
  out.push(byte);
  return Buffer.from(out);
}

/**
 * Serialise objects into one pack: `PACK`, version 2, the count, then each object as a type/size
 * header and a deflate stream, then the sha1 of everything written so far.
 */
export function writePack(objects: readonly GObj[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2])];
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const obj of objects) {
    parts.push(packHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

/** Apply a git delta to a base object, giving the object the delta describes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readSize = (): number => {
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[p++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return size;
  };
  readSize(); // the base size, which git only uses as a check
  const target = readSize();
  const out = Buffer.allocUnsafe(target);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++] as number;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[p++] as number;
      if (op & 0x02) offset |= (delta[p++] as number) << 8;
      if (op & 0x04) offset |= (delta[p++] as number) << 16;
      if (op & 0x08) offset |= (delta[p++] as number) << 24;
      if (op & 0x10) size |= delta[p++] as number;
      if (op & 0x20) size |= (delta[p++] as number) << 8;
      if (op & 0x40) size |= (delta[p++] as number) << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, o, offset, offset + size);
      o += size;
    } else if (op !== 0) {
      out.set(delta.subarray(p, p + op), o);
      p += op;
      o += op;
    } else {
      throw new Error('a delta op byte of 0 is not a valid instruction');
    }
  }
  return out;
}

/**
 * Read a pack into objects, resolving both delta forms. `lookup` resolves a `ref-delta` base that
 * the pack did not carry itself (a thin pack, which a push may send).
 */
export function readPack(buf: Buffer, lookup?: (sha: Sha) => GObj | undefined): GObj[] {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const byOffset = new Map<number, GObj>();
  const bySha = new Map<Sha, GObj>();
  const out: GObj[] = [];
  let p = 12;
  for (let n = 0; n < count; n += 1) {
    const start = p;
    let byte = buf[p++] as number;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[p++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: GObj | undefined;
    if (typeCode === 6) {
      // an offset delta: the base sits earlier in this same pack, at a back-distance git codes in
      // big-endian groups of 7 bits, each continuation adding one to the next group
      let c = buf[p++] as number;
      let distance = c & 0x7f;
      while ((c & 0x80) !== 0) {
        c = buf[p++] as number;
        distance = ((distance + 1) << 7) | (c & 0x7f);
      }
      base = byOffset.get(start - distance);
      if (base === undefined) throw new Error(`offset delta at ${start} names a base this pack lacks`);
    } else if (typeCode === 7) {
      const baseSha = buf.toString('hex', p, p + 20);
      p += 20;
      base = bySha.get(baseSha) ?? lookup?.(baseSha);
      if (base === undefined) throw new Error(`ref delta names ${baseSha}, which is not available`);
    }
    const inflated = inflateSync(buf.subarray(p), { info: true, finishFlush: Z.Z_SYNC_FLUSH }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    p += inflated.engine.bytesWritten;
    let data = inflated.buffer;
    if (data.length !== size && typeCode !== 6 && typeCode !== 7) {
      throw new Error(`pack entry ${n} declares ${size} bytes and inflated to ${data.length}`);
    }
    let type: GitType;
    if (typeCode === 6 || typeCode === 7) {
      type = (base as GObj).type;
      data = applyDelta((base as GObj).data, data);
    } else {
      type = TYPE_BY_PACK_CODE[typeCode] as GitType;
      if (type === undefined) throw new Error(`pack entry ${n} has unknown type ${typeCode}`);
    }
    const obj: GObj = { type, data };
    byOffset.set(start, obj);
    bySha.set(objectId(type, data), obj);
    out.push(obj);
  }
  return out;
}

/** A pack's trailing sha1 covers every byte before it; verify it so a truncated push is refused. */
export function packChecksumOk(buf: Buffer): boolean {
  if (buf.length < 32) return false;
  const body = buf.subarray(0, buf.length - 20);
  return sha1(body) === buf.toString('hex', buf.length - 20);
}
