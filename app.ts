// The forge's HTTP server: one process answering every surface the suite drives — the liveness probe,
// the REST v3 API, GraphQL v4, the MCP endpoint, and git's smart HTTP. It owns no state: it parses a
// request into a plain value, lets the surface that owns the path answer it, and writes exactly one
// buffer back.
//
// Every reply carries an X-GitHub-Request-Id, every unknown route is a JSON 404 rather than HTML, and
// a request without the one bearer token this process was started with is a 401 before routing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { errorJson, json, notFound, unauthorized, type Out, type Req } from './src/http.ts';
import { handleRest, isRestPath, type RestDeps } from './src/rest.ts';
import { handleGit } from './src/gitsmart.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { Forge } from './src/store.ts';

/** The largest body this server reads: a push of a hundred files fits well inside it. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** One counter for the reply id, so two runs issue the same ids in the same order. */
let requestCounter = 0;

/** Split a path into its non-empty segments. */
function segmentsOf(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split('/')) if (part !== '') out.push(part);
  return out;
}

/** True when the request names the token this process accepts. An unset token accepts anything. */
function authorized(deps: RestDeps, req: Req): boolean {
  if (deps.token === '') return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  return header.slice(7).trim() === deps.token;
}

/** Read the whole body, giving up past the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is larger than this server accepts'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const deps: RestDeps = { forge, token: process.env.MAKEFUN_SHOP_TOKEN ?? '' };

  const server = createServer((raw: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const started = performance.now();
      let body = Buffer.alloc(0);
      try {
        body = await readBody(raw);
      } catch {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': `req-${++requestCounter}` });
        res.end('{"message":"Request Entity Too Large"}\n');
        return;
      }

      const rawUrl = raw.url ?? '/';
      const mark = rawUrl.indexOf('?');
      const rawPath = mark < 0 ? rawUrl : rawUrl.slice(0, mark);
      const queryText = mark < 0 ? '' : rawUrl.slice(mark + 1);
      let path = rawPath;
      try {
        path = decodeURIComponent(rawPath);
      } catch {
        path = rawPath;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(raw.headers)) {
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      const req: Req = {
        method: (raw.method ?? 'GET').toUpperCase(),
        path,
        seg: segmentsOf(path),
        query: new URLSearchParams(queryText),
        headers,
        body,
        origin: `http://${headers.host ?? 'forge.local'}`,
      };

      let out: Out;
      try {
        out = route(deps, req);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[forge] ${req.method} ${req.path} failed: ${message}\n`);
        out = errorJson(500, 'Internal Server Error');
      }

      const id = `REQ-${++requestCounter}`;
      const head: Record<string, string | number> = { ...out.headers, 'x-github-request-id': id };
      if (head['content-length'] === undefined) head['content-length'] = String(out.body.length);
      res.writeHead(out.status, head);
      res.end(out.body);
      void started;
    })();
  });

  // A trial is a burst of small requests on a handful of connections: keep them warm.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.maxRequestsPerSocket = 0;
  return server;
}

/** Send one request to the surface that owns its path. */
function route(deps: RestDeps, req: Req): Out {
  const seg = req.seg;

  if (seg.length === 1 && seg[0] === 'healthz') {
    if (req.method !== 'GET') return errorJson(405, 'Method Not Allowed');
    return json(200, { ok: true });
  }

  // git's smart HTTP: /<owner>/<repo>.git/... — an unauthenticated transport, as GitHub's is.
  const gitOut = handleGit(deps, req);
  if (gitOut !== null) return gitOut;

  if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
    const restSeg = seg.slice(2);
    const isRoot = restSeg.length === 0;
    if (!isRoot && !authorized(deps, req)) return unauthorized();
    if (!isRestPath(restSeg)) return notFound();
    const handled = handleRest(deps, { ...req, seg: restSeg });
    return handled ?? notFound();
  }

  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'graphql') {
    if (!authorized(deps, req)) return unauthorized();
    return handleGraphql(deps, req);
  }

  if (seg.length === 1 && seg[0] === 'mcp') {
    return handleMcp(deps, req);
  }

  return notFound();
}
