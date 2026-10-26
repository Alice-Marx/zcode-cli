import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = 'zai-org/ZCode';
const TARGET = 'Alice-Marx/zcode-cli';
export const MARKER = '<!-- zcode-upstream-watch:v1 -->';
const TITLE = '[上游监控] zai-org/ZCode 更新通知';
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => hash(JSON.stringify(value));
const safe = value => String(value).replace(/[\r\n]/g, ' ').replace(/@/g, '＠').replace(/[\\`*_{}[\]()<>#!|]/g, '\\$&');
const sourceUrl = `https://github.com/${SOURCE}`;

function validSnapshot(snapshot) {
  if (typeof snapshot?.branch !== 'string' || !/^[a-f0-9]{40}$/.test(snapshot?.head)
    || !Array.isArray(snapshot?.releases)) throw new Error('Invalid upstream snapshot; checkpoint was not advanced.');
  return snapshot;
}

export function normalizeRelease(release) {
  return {
    id: release.id,
    tag: release.tag_name,
    name: release.name,
    prerelease: release.prerelease === true,
    publishedAt: release.published_at,
    updatedAt: release.updated_at,
    notesHash: hash(release.body ?? ''),
    assets: release.assets.map(asset => ({
      id: asset.id, name: asset.name, size: asset.size,
      digest: asset.digest ?? null, updatedAt: asset.updated_at,
    })).sort((a, b) => a.id - b.id),
  };
}

export async function paginate(api, path) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const result = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(result)) throw new Error('Unexpected GitHub list response.');
    items.push(...result);
    if (result.length < 100) return items;
  }
  throw new Error('GitHub pagination limit reached; checkpoint was not advanced.');
}

export async function readUpstream(api) {
  const repository = await api(`/repos/${SOURCE}`);
  const branch = repository.default_branch;
  if (typeof branch !== 'string' || !branch) throw new Error('Missing upstream default branch.');
  const commits = await api(`/repos/${SOURCE}/commits?sha=${encodeURIComponent(branch)}&per_page=1`);
  const releases = await paginate(api, `/repos/${SOURCE}/releases`);
  return validSnapshot({
    branch, head: commits[0]?.sha, commitDate: commits[0]?.commit?.committer?.date,
    releases: releases.filter(release => !release.draft).map(normalizeRelease).sort((a, b) => a.id - b.id),
  });
}

export function changesSince(previous, current) {
  validSnapshot(previous); validSnapshot(current);
  const changes = [];
  if (previous.head !== current.head || previous.branch !== current.branch) {
    changes.push(`默认分支 ${safe(current.branch)} 有更新：[${current.head.slice(0, 7)}](${sourceUrl}/commit/${current.head}) · [比较全部提交](${sourceUrl}/compare/${previous.head}...${current.head})`);
  }
  const old = new Map(previous.releases.map(release => [release.id, release]));
  const next = new Set(current.releases.map(release => release.id));
  for (const release of current.releases) {
    const label = `${safe(release.tag)}${release.prerelease ? '（预发布）' : ''}`;
    const link = `${sourceUrl}/releases/tag/${encodeURIComponent(release.tag)}`;
    if (!old.has(release.id)) changes.push(`新增 Release：[${label}](${link})`);
    else if (fingerprint(old.get(release.id)) !== fingerprint(release)) changes.push(`Release 说明或安装资源有变化：[${label}](${link})`);
  }
  for (const release of previous.releases) {
    if (!next.has(release.id)) changes.push(`此前公开的 Release ${safe(release.tag)} 已不在公开列表，请核对上游。`);
  }
  return changes;
}

export function readCheckpoint(body) {
  const encoded = /<!-- zcode-upstream-state:([A-Za-z0-9+/=]+) -->/.exec(body ?? '')?.[1];
  if (!encoded) throw new Error('Tracking issue checkpoint is missing; refusing to reset notification history.');
  const state = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (state.schemaVersion !== 1 || state.source !== SOURCE || !/^[a-f0-9]{40}$/.test(state.extractedCommit)) throw new Error('Invalid tracking issue checkpoint.');
  validSnapshot(state.upstream);
  return state;
}

export function renderIssue({ current, pin, version, changes = [], now }) {
  const state = { schemaVersion: 1, source: SOURCE, upstream: current, extractedCommit: pin, version };
  const aligned = pin === current.head;
  return `${MARKER}
此 Issue 由 [Upstream ZCode notifications](https://github.com/${TARGET}/actions/workflows/upstream-watch.yml) 自动维护，每小时检查一次，也可在 Actions 手动运行。通知保存在本仓库，不依赖本机或 Codex。

- 上游：[${SOURCE}](${sourceUrl})，默认分支 ${safe(current.branch)}，当前提交 [${current.head.slice(0, 7)}](${sourceUrl}/commit/${current.head})。
- 本仓版本：${safe(version)}；已抽取来源：[${pin.slice(0, 7)}](${sourceUrl}/commit/${pin})。
- 同步状态：${aligned ? '已抽取来源与上游默认分支一致；新的发行说明或安装资源仍需单独核对。' : `**上游源码已变化，请评估并更新 zcode-cli。** [查看待核对差异](${sourceUrl}/compare/${pin}...${current.head})`}
- 最近记录时间：${now}。

${changes.length ? `本次上游变化：\n\n${changes.map(change => `- ${change}`).join('\n')}` : '监控已启用；初始检查未发现基线之后的新变化。'}

新变化会作为评论追加，同一变化不重复通知。此 Issue 已分配给仓库维护者，也可以使用 GitHub 的 Subscribe 接收后续评论通知。请保留 Issue 正文末尾的机器状态；工作流只更新此机器人通知 Issue，不自动合并源码或发布新版本。

<!-- zcode-upstream-state:${Buffer.from(JSON.stringify(state)).toString('base64')} -->
`;
}

export async function runWatch({ api, baseline, pin, version, now = new Date().toISOString() }) {
  if (!/^[a-f0-9]{40}$/.test(pin)) throw new Error('Invalid extraction source commit.');
  validSnapshot(baseline);
  // Complete all upstream reads before making any notification/checkpoint writes.
  const current = await readUpstream(api);
  const issues = (await paginate(api, `/repos/${TARGET}/issues?state=all`))
    .filter(issue => !issue.pull_request && issue.user?.type === 'Bot' && issue.body?.includes(MARKER));
  if (issues.length > 1) throw new Error('Multiple bot tracking issues found; refusing to choose one.');
  const issue = issues[0];
  if (!issue) {
    const created = await api(`/repos/${TARGET}/issues`, 'POST', {
      title: TITLE, assignees: ['Alice-Marx'],
      body: renderIssue({ current, pin, version, changes: changesSince(baseline, current), now }),
    });
    return { action: 'initialized', issue: created.html_url };
  }
  const previous = readCheckpoint(issue.body);
  const changes = changesSince(previous.upstream, current);
  if (!changes.length && previous.extractedCommit === pin && previous.version === version) return { action: 'unchanged', issue: issue.html_url };
  if (changes.length) {
    const event = `<!-- zcode-upstream-event:${fingerprint([previous.upstream, current])} -->`;
    const comments = await paginate(api, `/repos/${TARGET}/issues/${issue.number}/comments`);
    if (!comments.some(comment => comment.user?.type === 'Bot' && comment.body?.includes(event))) {
      await api(`/repos/${TARGET}/issues/${issue.number}/comments`, 'POST', {
        body: `${event}\n检测到上游 **${SOURCE}** 更新（${now}）：\n\n${changes.map(change => `- ${change}`).join('\n')}\n\n${pin === current.head ? 'zcode-cli 的来源提交已跟进，请核对发行说明和资源变化。' : `请评估并更新 **zcode-cli** 的 CLI/TUI/Web 抽取及运行资源。[查看与当前抽取来源的差异](${sourceUrl}/compare/${pin}...${current.head})`}`,
      });
    }
  }
  // A comment is delivered first. Failed PATCH retries find its event marker.
  await api(`/repos/${TARGET}/issues/${issue.number}`, 'PATCH', {
    body: renderIssue({ current, pin, version, changes, now }),
    ...(changes.length && issue.state === 'closed' ? { state: 'open' } : {}),
  });
  return { action: changes.length ? 'notified' : 'extraction-updated', issue: issue.html_url, changes: changes.length };
}

export function githubApi(token, fetcher = fetch) {
  return async (path, method = 'GET', body) => {
    if (!path.startsWith('/repos/')) throw new Error('Unsupported GitHub API path.');
    const response = await fetcher(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'zcode-cli-upstream-watch',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}; checkpoint was not advanced.`);
    return response.json();
  };
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== TARGET || !process.env.GITHUB_TOKEN) throw new Error('Run this monitor in Alice-Marx/zcode-cli GitHub Actions.');
  const root = new URL('../../', import.meta.url);
  const [baseline, upstream, pkg] = await Promise.all(['.github/upstream-watch-baseline.json', 'upstream.json', 'package.json']
    .map(async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))));
  if (upstream.repository !== sourceUrl) throw new Error('Unexpected extraction upstream.');
  console.log(JSON.stringify(await runWatch({ api: githubApi(process.env.GITHUB_TOKEN), baseline, pin: upstream.commit, version: pkg.version })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
