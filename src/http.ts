// The HTTP layer's shared types: one parsed request, one prepared response, and the JSON helpers the
// REST, GraphQL and MCP surfaces answer with. Keeping the response a plain value rather than a stream
// write is what lets the server set an exact content-length and send one buffer.

/** One incoming request, already parsed: no handler touches the raw socket. */
export interface Req {
  method: string;
  /** The path, decoded, without a trailing slash (except the root, which is `/`). */
  path: string;
  /** The path's non-empty segments. */
  seg: string[];
  /** The query string's parameters. */
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** `http://host` of this request, so an absolute URL can be built for a pagination Link. */
  origin: string;
}

/** One prepared response: a status, headers, and the exact bytes to send. */
export interface Out {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** The JSON content type GitHub answers with. */
export const JSON_TYPE = 'application/json; charset=utf-8';

/** A JSON response. The body is serialised once, so its length is known before it is sent. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Out {
  const text = `${JSON.stringify(body)}\n`;
  const buf = Buffer.from(text, 'utf8');
  return {
    status,
    headers: { 'content-type': JSON_TYPE, 'content-length': String(buf.length), ...headers },
    body: buf,
  };
}

/** An empty response, with whatever headers the method's contract calls for. */
export function empty(status: number, headers: Record<string, string> = {}): Out {
  return { status, headers: { 'content-length': '0', ...headers }, body: Buffer.alloc(0) };
}

/** GitHub's error body: `{"message": "..."}`. `errors` carries the detail when there is any. */
export function errorJson(status: number, message: string, errors?: unknown): Out {
  const body: Record<string, unknown> = { message };
  if (errors !== undefined) body.errors = errors;
  return json(status, body);
}

/** 404 in the exact shape GitHub answers an unknown route with. */
export function notFound(): Out {
  return errorJson(404, 'Not Found');
}

/** A 401 for a request with no bearer token, or one this forge did not issue. */
export function unauthorized(): Out {
  return errorJson(401, 'Requires authentication');
}

/** A 403, used where a caller may not act on something it can at least see. */
export function forbidden(message = 'Must have admin rights to Repository.'): Out {
  return errorJson(403, message);
}

/** A 400 for a body that is not JSON at all. */
export function badJson(): Out {
  return errorJson(400, 'Problems parsing JSON');
}

/** A 422 with field-level detail, as GitHub answers a validation failure. */
export function unprocessable(message: string, errors?: unknown): Out {
  return errorJson(422, message, errors);
}

/** True when a string looks like a 40 character lowercase hex object id. */
export function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Encode a Buffer as standard base64 with newlines, as the contents API returns it. */
export function base64Of(data: Buffer): string {
  return data.toString('base64');
}

/** Read a base64 body, tolerating the newlines GitHub's own output carries. */
export function fromBase64(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** The ISO 8601 stamp GitHub shows for a stored time. */
export function isoOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}
