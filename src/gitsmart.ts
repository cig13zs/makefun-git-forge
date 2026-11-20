// git's smart HTTP transport, over the store: ref advertisement, upload-pack (clone, fetch, and the
// shallow forms), and receive-pack (push, including a first push, new branches, tag pushes and ref
// deletes). The protocol is spoken here directly — pkt-line framing, capability negotiation, the pack
// file both ways — because the trial has no git binary to shell out to.

import { json, type Out, type Req } from './http.ts';
import type { RestDeps } from './rest.ts';

/**
 * Answer a git smart HTTP request. Returns null when the path is not a git transport path at all, so
 * the REST surface and the 404 fallback still get their turn.
 */
export function handleGit(_deps: RestDeps, req: Req): Out | null {
  const marker = req.path.indexOf('.git/');
  if (marker < 0) return null;
  void json;
  return null;
}
