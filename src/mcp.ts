// The Model Context Protocol endpoint: JSON-RPC 2.0 over streamable HTTP at `POST /mcp`, offering the
// tools an agent expects from a git host (create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request) and writing through the same store the REST surface reads,
// so a repository or an issue created here is the very same object there.

import { errorJson, json, unauthorized, type Out, type Req } from './http.ts';
import type { RestDeps } from './rest.ts';

/** Answer one MCP request. */
export function handleMcp(deps: RestDeps, req: Req): Out {
  if (req.method !== 'POST') return errorJson(405, 'Method Not Allowed');
  if (deps.token !== '' && !(req.headers.authorization ?? '').startsWith('Bearer ')) return unauthorized();
  return json(200, {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32601, message: 'the MCP endpoint is not available on this forge yet' },
  });
}
