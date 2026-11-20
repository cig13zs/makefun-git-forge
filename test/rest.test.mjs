// The forge's own tests: they start the real server on an ephemeral port and drive it exactly as the
// conformance suite drives it — REST v3, the git transport, GraphQL and MCP — so a regression shows up
// here before it shows up as a lost check.
//
// Run with: node --experimental-strip-types --test test/

import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../app.ts';

process.env.MAKEFUN_SHOP_TOKEN ??= 'test-token';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN;

/** Start the server on an ephemeral port and return a small client bound to it. */
async function start() {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
    async call(method, path, body, headers = {}) {
      const init = {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...headers },
      };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const response = await fetch(`${base}${path}`, init);
      const text = await response.text();
      let parsed;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: response.status, headers: response.headers, body: parsed, text };
    },
  };
}

test('healthz answers ok', async () => {
  const app = await start();
  try {
    const res = await app.call('GET', '/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    await app.close();
  }
});

test('the api root carries the token scopes and a request id', async () => {
  const app = await start();
  try {
    const res = await app.call('GET', '/api/v3/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-oauth-scopes') ?? '', /repo/);
    assert.match(res.headers.get('x-oauth-scopes') ?? '', /read:org/);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.ok((res.headers.get('x-github-request-id') ?? '').length > 0);
  } finally {
    await app.close();
  }
});

test('an unknown route is a json 404 with a message', async () => {
  const app = await start();
  try {
    const res = await app.call('GET', '/api/v3/nope/nope/nope/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.message, 'Not Found');
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  } finally {
    await app.close();
  }
});

test('a request with no token is a 401', async () => {
  const app = await start();
  try {
    const response = await fetch(`${app.base}/api/v3/user`);
    assert.equal(response.status, 401);
    const response2 = await fetch(`${app.base}/api/v3/user`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(response2.status, 401);
  } finally {
    await app.close();
  }
});

test('a malformed body is a 400', async () => {
  const app = await start();
  try {
    const res = await app.call('POST', '/api/v3/user/repos', '{not json');
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.message, 'string');
  } finally {
    await app.close();
  }
});

test('a repository round-trips through create, read, patch and delete', async () => {
  const app = await start();
  try {
    const created = await app.call('POST', '/api/v3/user/repos', { name: 'round-trip', description: 'first' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'round-trip');
    assert.equal(created.body.private, false);
    assert.equal(created.body.default_branch, 'main');
    const owner = created.body.owner.login;

    const read = await app.call('GET', `/api/v3/repos/${owner}/round-trip`);
    assert.equal(read.status, 200);
    assert.equal(read.body.description, 'first');

    const patched = await app.call('PATCH', `/api/v3/repos/${owner}/round-trip`, { description: 'second' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.description, 'second');

    const removed = await app.call('DELETE', `/api/v3/repos/${owner}/round-trip`);
    assert.equal(removed.status, 204);
    const gone = await app.call('GET', `/api/v3/repos/${owner}/round-trip`);
    assert.equal(gone.status, 404);
  } finally {
    await app.close();
  }
});

test('a repository is not readable under another login', async () => {
  const app = await start();
  try {
    const created = await app.call('POST', '/api/v3/user/repos', { name: 'private-island' });
    const owner = created.body.owner.login;
    const mine = await app.call('GET', `/api/v3/repos/${owner}/private-island`);
    assert.equal(mine.status, 200);
    const theirs = await app.call('GET', `/api/v3/repos/somebody-else/private-island`);
    assert.equal(theirs.status, 404);
  } finally {
    await app.close();
  }
});

test('contents create, read, list, conflict and delete', async () => {
  const app = await start();
  try {
    const created = await app.call('POST', '/api/v3/user/repos', { name: 'blobs-repo' });
    const owner = created.body.owner.login;
    const path = `/api/v3/repos/${owner}/blobs-repo/contents`;

    const file = await app.call('PUT', `${path}/docs/a.txt`, {
      message: 'add a',
      content: Buffer.from('hello world\n').toString('base64'),
    });
    assert.equal(file.status, 201);
    assert.equal(file.body.content.encoding, 'base64');
    assert.match(file.body.commit.sha, /^[0-9a-f]{40}$/);

    const read = await app.call('GET', `${path}/docs/a.txt`);
    assert.equal(read.status, 200);
    assert.equal(Buffer.from(read.body.content, 'base64').toString('utf8'), 'hello world\n');
    assert.equal(read.body.size, 12);

    const dir = await app.call('GET', `${path}/docs`);
    assert.equal(dir.status, 200);
    assert.ok(Array.isArray(dir.body));
    assert.equal(dir.body[0].name, 'a.txt');

    const stale = await app.call('PUT', `${path}/docs/a.txt`, {
      message: 'update',
      content: Buffer.from('x').toString('base64'),
      sha: '0'.repeat(40),
    });
    assert.equal(stale.status, 409);

    const update = await app.call('PUT', `${path}/docs/a.txt`, {
      message: 'update',
      content: Buffer.from('goodbye\n').toString('base64'),
      sha: read.body.sha,
    });
    assert.equal(update.status, 200);

    const deleted = await app.call('DELETE', `${path}/docs/a.txt`, { message: 'remove', sha: update.body.content.sha });
    assert.equal(deleted.status, 200);
    const gone = await app.call('GET', `${path}/docs/a.txt`);
    assert.equal(gone.status, 404);
  } finally {
    await app.close();
  }
});

test('branches, commits and git refs reflect the contents commits', async () => {
  const app = await start();
  try {
    const created = await app.call('POST', '/api/v3/user/repos', { name: 'history' });
    const owner = created.body.owner.login;
    const repoPath = `/api/v3/repos/${owner}/history`;

    const first = await app.call('PUT', `${repoPath}/contents/README.md`, {
      message: 'first commit',
      content: Buffer.from('# history\n').toString('base64'),
    });
    assert.equal(first.status, 201);

    const branches = await app.call('GET', `${repoPath}/branches`);
    assert.equal(branches.status, 200);
    assert.equal(branches.body.length, 1);
    assert.equal(branches.body[0].name, 'main');
    assert.equal(branches.body[0].commit.sha, first.body.commit.sha);

    const made = await app.call('POST', `${repoPath}/git/refs`, { ref: 'refs/heads/feature', sha: first.body.commit.sha });
    assert.equal(made.status, 201);
    assert.equal(made.body.ref, 'refs/heads/feature');
    assert.equal(made.body.object.sha, first.body.commit.sha);

    const commits = await app.call('GET', `${repoPath}/commits?sha=feature`);
    assert.equal(commits.status, 200);
    assert.equal(commits.body[0].sha, first.body.commit.sha);
    assert.equal(commits.body[0].commit.message, 'first commit');
  } finally {
    await app.close();
  }
});

test('issues: labels, state filters, sorting, comments and the unknown-label 422', async () => {
  const app = await start();
  try {
    const created = await app.call('POST', '/api/v3/user/repos', { name: 'issues' });
    const owner = created.body.owner.login;
    const repoPath = `/api/v3/repos/${owner}/issues-tracker`;
    await app.call('POST', '/api/v3/user/repos', { name: 'issues-tracker' });
    const base = `/api/v3/repos/${owner}/issues-tracker`;

    const label = await app.call('POST', `${base}/labels`, { name: 'bug', color: 'd73a4a' });
    assert.equal(label.status, 201);
    assert.equal(label.body.name, 'bug');

    const first = await app.call('POST', `${base}/issues`, { title: 'first', body: 'one', labels: ['bug'] });
    assert.equal(first.status, 201);
    assert.equal(first.body.number, 1);
    assert.equal(first.body.state, 'open');
    assert.equal(first.body.labels[0].name, 'bug');

    const second = await app.call('POST', `${base}/issues`, { title: 'second' });
    assert.equal(second.body.number, 2);

    const unknown = await app.call('POST', `${base}/issues`, { title: 'third', labels: ['nope'] });
    assert.equal(unknown.status, 422);

    const open = await app.call('GET', `${base}/issues?state=open`);
    assert.equal(open.body.length, 2);

    const closed = await app.call('PATCH', `${base}/issues/1`, { state: 'closed' });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.state, 'closed');

    const stillOpen = await app.call('GET', `${base}/issues?state=open`);
    assert.equal(stillOpen.body.length, 1);
    const allIssues = await app.call('GET', `${base}/issues?state=all`);
    assert.equal(allIssues.body.length, 2);

    const comment = await app.call('POST', `${base}/issues/1/comments`, { body: 'a comment' });
    assert.equal(comment.status, 201);
    assert.equal(comment.body.body, 'a comment');
    const comments = await app.call('GET', `${base}/issues/1/comments`);
    assert.equal(comments.body.length, 1);

    const sorted = await app.call('GET', `${base}/issues?state=all&sort=created&direction=asc`);
    assert.equal(sorted.body[0].number, 1);
    void repoPath;
  } finally {
    await app.close();
  }
});

test('a pull request reports its files and merges into the base branch', async () => {
  const app = await start();
  try {
    await app.call('POST', '/api/v3/user/repos', { name: 'pulls' });
    const repo = await app.call('GET', '/api/v3/user/repos');
    const owner = repo.body[0].owner.login;
    const base = `/api/v3/repos/${owner}/pulls`;

    const seeded = await app.call('PUT', `${base}/contents/README.md`, {
      message: 'seed',
      content: Buffer.from('line one\n').toString('base64'),
    });
    await app.call('POST', `${base}/git/refs`, { ref: 'refs/heads/feature', sha: seeded.body.commit.sha });
    const change = await app.call('PUT', `${base}/contents/README.md`, {
      message: 'change on feature',
      content: Buffer.from('line one\nline two\n').toString('base64'),
      branch: 'feature',
      sha: seeded.body.content.sha,
    });
    assert.equal(change.status, 200);

    const opened = await app.call('POST', `${base}/pulls`, { title: 'a change', head: 'feature', base: 'main' });
    assert.equal(opened.status, 201);
    assert.equal(opened.body.state, 'open');
    assert.equal(opened.body.head.ref, 'feature');
    assert.equal(opened.body.head.sha, change.body.commit.sha);
    assert.equal(opened.body.base.sha, seeded.body.commit.sha);

    const files = await app.call('GET', `${base}/pulls/${opened.body.number}/files`);
    assert.equal(files.status, 200);
    assert.equal(files.body.length, 1);
    assert.equal(files.body[0].filename, 'README.md');
    assert.equal(files.body[0].status, 'modified');
    assert.ok(files.body[0].additions >= 1);

    const merged = await app.call('PUT', `${base}/pulls/${opened.body.number}/merge`, {});
    assert.equal(merged.status, 200);
    assert.equal(merged.body.merged, true);
    assert.match(merged.body.sha, /^[0-9a-f]{40}$/);

    const after = await app.call('GET', `${base}/pulls/${opened.body.number}`);
    assert.equal(after.body.merged, true);
    assert.equal(after.body.state, 'closed');

    const onDefault = await app.call('GET', `${base}/contents/README.md`);
    assert.equal(Buffer.from(onDefault.body.content, 'base64').toString('utf8'), 'line one\nline two\n');

    const again = await app.call('PUT', `${base}/pulls/${opened.body.number}/merge`, {});
    assert.equal(again.status, 405);

    const missing = await app.call('GET', `${base}/pulls/99`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

test('a conflicting merge is refused with a 405', async () => {
  const app = await start();
  try {
    await app.call('POST', '/api/v3/user/repos', { name: 'conflict' });
    const repo = await app.call('GET', '/api/v3/user/repos');
    const owner = repo.body[0].owner.login;
    const base = `/api/v3/repos/${owner}/conflict`;

    const seed = await app.call('PUT', `${base}/contents/file.txt`, { message: 'seed', content: Buffer.from('base\n').toString('base64') });
    await app.call('POST', `${base}/git/refs`, { ref: 'refs/heads/feature', sha: seed.body.commit.sha });
    await app.call('PUT', `${base}/contents/file.txt`, { message: 'main edit', content: Buffer.from('from main\n').toString('base64'), sha: seed.body.content.sha });
    await app.call('PUT', `${base}/contents/file.txt`, { message: 'feature edit', content: Buffer.from('from feature\n').toString('base64'), branch: 'feature', sha: seed.body.content.sha });

    const opened = await app.call('POST', `${base}/pulls`, { title: 'conflicting', head: 'feature', base: 'main' });
    assert.equal(opened.status, 201);
    const merged = await app.call('PUT', `${base}/pulls/${opened.body.number}/merge`, {});
    assert.equal(merged.status, 405);
  } finally {
    await app.close();
  }
});

test('user repos paginate with a link header', async () => {
  const app = await start();
  try {
    for (let i = 0; i < 3; i += 1) await app.call('POST', '/api/v3/user/repos', { name: `paged-${i}` });
    const page = await app.call('GET', '/api/v3/user/repos?per_page=2');
    assert.equal(page.status, 200);
    assert.equal(page.body.length, 2);
    const link = page.headers.get('link') ?? '';
    assert.match(link, /rel="next"/);
  } finally {
    await app.close();
  }
});
