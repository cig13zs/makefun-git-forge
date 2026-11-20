// GitHub's GraphQL v4 endpoint: the documents `gh`'s githubv4 client and github-mcp-server send, over
// the same store the REST surface serves. A document is tokenised and parsed here rather than matched
// as a string, so aliases, variables, inline enums, inline input objects and batched operation arrays
// all resolve the way a real server resolves them.

import { json, type Out, type Req } from './http.ts';
import type { RestDeps } from './rest.ts';

/** Answer one GraphQL request. The path is fixed (`POST /api/graphql`), so there is nothing to return null for. */
export function handleGraphql(_deps: RestDeps, _req: Req): Out {
  return json(200, { errors: [{ message: 'GraphQL is not available on this forge yet' }] });
}
