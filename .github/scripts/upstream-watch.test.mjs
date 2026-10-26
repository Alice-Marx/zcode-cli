import assert from 'node:assert/strict';
import test from 'node:test';
import { changesSince, githubApi, MARKER, normalizeRelease, paginate, readCheckpoint, renderIssue, runWatch } from './upstream-watch.mjs';

const head = 'a'.repeat(40), next = 'b'.repeat(40), date = '2026-10-26T08:00:00Z';
const release = (id = 1) => ({ id, tag_name: `v${id}.0.0`, name: `Version ${id}`, prerelease: false, draft: false,
  published_at: date, updated_at: date, body: 'release notes',
  assets: [{ id: id * 10, name: 'runtime.tar.gz', size: 123, digest: 'sha256:original', updated_at: date }] });

function fixture({ initialIssue = true } = {}) {
  const f = { releases: [release()], head, writes: [], comments: [], issues: [], fail: null };
  f.baseline = { branch: 'main', head, commitDate: date, releases: f.releases.map(normalizeRelease) };
  f.options = { baseline: f.baseline, pin: head, version: '3.16.2', now: date };
  f.issue = body => ({ number: 1, html_url: 'https://github.com/Alice-Marx/zcode-cli/issues/1', user: { type: 'Bot' }, state: 'open', body });
  if (initialIssue) f.issues.push(f.issue(renderIssue({ current: f.baseline, pin: head, version: '3.16.2', now: date })));
  f.api = async (path, method = 'GET', body) => {
    if (method !== 'GET') f.writes.push({ path, method, body });
    if (f.fail?.(path, method)) throw new Error('simulated API failure');
    if (path === '/repos/zai-org/ZCode') return { default_branch: 'main' };
    if (path.startsWith('/repos/zai-org/ZCode/commits?')) return [{ sha: f.head, commit: { committer: { date } } }];
    if (path.startsWith('/repos/zai-org/ZCode/releases?')) return structuredClone(f.releases);
    assert.ok(path.startsWith('/repos/Alice-Marx/zcode-cli/issues'), 'writes are restricted to the downstream repository');
    if (method === 'GET') return path.includes('/comments?') ? structuredClone(f.comments) : structuredClone(f.issues);
    if (method === 'POST' && path.endsWith('/comments')) {
      const comment = { id: f.comments.length + 1, user: { type: 'Bot' }, ...body }; f.comments.push(comment); return comment;
    }
    if (method === 'POST') { const issue = f.issue(body.body); f.issues.push(issue); return issue; }
    assert.equal(method, 'PATCH'); Object.assign(f.issues[0], body); return f.issues[0];
  };
  f.run = options => runWatch({ api: f.api, ...f.options, ...options });
  return f;
}

test('first check creates the assigned repository dashboard without inventing an upstream update', async () => {
  const f = fixture({ initialIssue: false });
  assert.equal((await f.run()).action, 'initialized');
  assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0].body.assignees, ['Alice-Marx']);
  assert.ok(f.issues[0].body.includes(MARKER)); assert.match(f.issues[0].body, /未发现基线之后的新变化/);
  assert.equal(readCheckpoint(f.issues[0].body).upstream.head, head);
  assert.equal((await f.run()).action, 'unchanged'); assert.equal(f.writes.length, 1);
});

test('unchanged upstream makes no writes, including download-count changes', async () => {
  const f = fixture(); f.releases[0].assets[0].download_count = 9000;
  assert.equal((await f.run()).action, 'unchanged'); assert.deepEqual(f.writes, []);
});

test('new source creates a notification comment, checkpoints after delivery and is deduplicated', async () => {
  const f = fixture(); f.head = next;
  assert.equal((await f.run()).action, 'notified');
  assert.deepEqual(f.writes.map(write => write.method), ['POST', 'PATCH']);
  assert.match(f.comments[0].body, /请评估并更新/);
  assert.ok(f.comments[0].body.includes(`${head}...${next}`));
  assert.equal(readCheckpoint(f.issues[0].body).upstream.head, next);
  assert.equal(readCheckpoint(f.issues[0].body).extractedCommit, head);
  assert.equal((await f.run()).action, 'unchanged'); assert.equal(f.comments.length, 1);
});

test('all new releases including prereleases are reported, while drafts are excluded', async () => {
  const f = fixture(); f.releases.push(release(2), { ...release(3), prerelease: true }, { ...release(4), draft: true });
  const outcome = await f.run(); assert.equal(outcome.changes, 2);
  assert.match(f.comments[0].body, /v2\.0\.0/); assert.match(f.comments[0].body, /预发布/);
  assert.doesNotMatch(f.comments[0].body, /v4\.0\.0/);
});

test('notes, asset digests and release withdrawal are detected even with an unchanged head', async () => {
  for (const change of [
    f => { f.releases[0].body = 'amended notes'; },
    f => { f.releases[0].assets[0].digest = 'sha256:replaced'; },
    f => { f.releases = []; },
  ]) {
    const f = fixture(); change(f);
    assert.equal((await f.run()).action, 'notified'); assert.equal(f.comments.length, 1);
    assert.equal((await f.run()).action, 'unchanged');
  }
});

test('a failed checkpoint retries without posting the delivered notification twice', async () => {
  const f = fixture(); f.head = next; f.fail = (path, method) => method === 'PATCH';
  await assert.rejects(f.run(), /simulated API failure/);
  assert.equal(f.comments.length, 1); assert.equal(readCheckpoint(f.issues[0].body).upstream.head, head);
  f.fail = null; assert.equal((await f.run()).action, 'notified');
  assert.equal(f.comments.length, 1); assert.equal(readCheckpoint(f.issues[0].body).upstream.head, next);
});

test('a failed comment does not advance the checkpoint', async () => {
  const f = fixture(); f.head = next; f.fail = (path, method) => method === 'POST';
  await assert.rejects(f.run(), /simulated API failure/);
  assert.equal(f.comments.length, 0); assert.equal(f.writes.length, 1);
  assert.equal(readCheckpoint(f.issues[0].body).upstream.head, head);
});

test('failed upstream queries and invalid issue checkpoints never mutate the issue', async () => {
  const failed = fixture(); failed.fail = path => path.startsWith('/repos/zai-org/ZCode/releases');
  await assert.rejects(failed.run(), /simulated API failure/); assert.deepEqual(failed.writes, []);
  const corrupted = fixture(); corrupted.issues[0].body = MARKER;
  await assert.rejects(corrupted.run(), /checkpoint is missing/); assert.deepEqual(corrupted.writes, []);
});

test('updating the extraction pin only refreshes status without fabricating a new upstream event', async () => {
  const f = fixture(); f.head = next; await f.run(); f.writes.length = 0;
  assert.equal((await f.run({ pin: next })).action, 'extraction-updated');
  assert.equal(f.comments.length, 1); assert.deepEqual(f.writes.map(write => write.method), ['PATCH']);
  assert.match(f.issues[0].body, /来源与上游默认分支一致/);
});

test('a closed dashboard stays closed when unchanged and reopens for a new event', async () => {
  const f = fixture(); f.issues[0].state = 'closed';
  assert.equal((await f.run()).action, 'unchanged'); assert.deepEqual(f.writes, []);
  f.head = next; await f.run(); assert.equal(f.issues[0].state, 'open');
});

test('pagination reads beyond the first page and fails safely when truncated', async () => {
  const pages = [];
  const results = await paginate(async path => { pages.push(path); return path.endsWith('page=1') ? Array(100).fill(1) : [2]; }, '/releases?state=all');
  assert.equal(results.length, 101); assert.match(pages[1], /state=all&per_page=100&page=2$/);
  await assert.rejects(paginate(async () => Array(100).fill(1), '/releases'), /pagination limit/);
});

test('ambiguous bot trackers fail while ordinary user issues are untouched', async () => {
  const f = fixture(); f.issues.push(structuredClone(f.issues[0]));
  await assert.rejects(f.run(), /Multiple bot tracking issues/); assert.deepEqual(f.writes, []);
  f.issues[1].user.type = 'User'; f.head = next; await f.run();
  assert.equal(f.comments.length, 1); assert.equal(f.issues[1].body, renderIssue({ current: f.baseline, pin: head, version: '3.16.2', now: date }));
});

test('upstream text is escaped and raw release notes are never republished', () => {
  const previous = fixture().baseline;
  const added = normalizeRelease({ ...release(9), tag_name: '@everyone [tag]', body: '@person do something' });
  const changes = changesSince(previous, { ...previous, releases: [...previous.releases, added] });
  assert.doesNotMatch(changes.join(''), /@everyone|@person/);
  assert.match(changes.join(''), /%40everyone/);
});

test('first run includes changes made after the committed baseline', async () => {
  const f = fixture({ initialIssue: false }); f.head = next;
  await f.run(); assert.match(f.issues[0].body, /上游源码已变化/); assert.ok(f.issues[0].body.includes(`${head}...${next}`));
});

test('GitHub HTTP errors do not log credentials and requests retain TLS/redirect protections', async () => {
  let request;
  const api = githubApi('test-secret', async (url, options) => { request = { url, options }; return { ok: false, status: 403 }; });
  await assert.rejects(api('/repos/zai-org/ZCode'), error => error.message.includes('HTTP 403') && !error.message.includes('test-secret'));
  assert.equal(request.url, 'https://api.github.com/repos/zai-org/ZCode');
  assert.equal(request.options.redirect, 'error');
  await assert.rejects(api('https://unrelated.example'), /Unsupported/);
});
