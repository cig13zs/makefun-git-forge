# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cig13zs/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cig13zs/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge. One process, one store, no UI and no outside service: it
serves git's smart HTTP transport, the REST v3 API, GraphQL v4 and the Model Context Protocol, and the
trial drives all four as an ordinary client.

Nothing is installed at run time. The program is TypeScript, executed by Node 22 with its types
stripped, importing only `node:` builtins and its own modules.

## Run it

```sh
node --experimental-strip-types main.ts
```

Under the grader the harness sets `MAKEFUN_ENV_URL` and starts this program as `node /bot/main.ts`. The
process binds an ephemeral port, registers that port with the env, answers the whole trial, and exits 0
when the env says the trial is done.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | `200 {"ok":true}`, the env's boot probe |
| `GET /api/v3/` | the REST API root, with `X-OAuth-Scopes: repo, read:org` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, files and merges |
| `POST /api/graphql` | GitHub GraphQL v4 |
| `POST /mcp` | Model Context Protocol over streamable HTTP |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | `404 {"message":"Not Found"}` |

## Layout

- `main.ts` — the entry/ env lifecycle: bind, register, poll, exit.
- `app.ts` — the HTTP server and the one dispatcher every surface hangs off.
- `src/git.ts` — the git object model: framing, hashing, trees, commits, tags, pkt-line, packs.
- `src/store.ts` — repositories, refs, objects, issues, labels, comments, pull requests.
- `src/rest.ts` — the REST v3 surface.
- `src/gitsmart.ts` — git's smart HTTP transport.
- `src/graphql.ts` — the GraphQL v4 endpoint.
- `src/mcp.ts` — the MCP endpoint.
- `test/` — tests that start the real server and drive it as a client.

## Tests

```sh
node --experimental-strip-types --test test/
```

## Licence

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=lorence-dela-cruz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
