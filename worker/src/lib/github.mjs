// Publish pipeline: commit content.json + draft images to the site repo in ONE
// commit via the Git Data API (blobs -> tree -> commit -> ref), then let the
// Pages workflow build. Commit failures and build failures surface separately.

const API = 'https://api.github.com';

function ghHeaders(pat) {
  return {
    authorization: `Bearer ${pat}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'seanhase-publish-worker',
    'x-github-api-version': '2022-11-28',
  };
}

async function gh(pat, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: ghHeaders(pat),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 400);
    const err = new Error(`github ${method} ${path} -> ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Commits files to the repo. files: [{path, content (string) | base64 (string)}]
 * Retries once on a stale-ref race (concurrent publish).
 */
export async function commitFiles(env, files, message) {
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const branch = env.GITHUB_BRANCH || 'main';
  const pat = env.GITHUB_PAT;
  if (!pat) throw new Error('GITHUB_PAT secret is not configured');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ref = await gh(pat, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      const baseSha = ref.object.sha;
      const baseCommit = await gh(pat, 'GET', `/repos/${owner}/${repo}/git/commits/${baseSha}`);

      const treeItems = [];
      for (const f of files) {
        const blob = await gh(pat, 'POST', `/repos/${owner}/${repo}/git/blobs`,
          f.base64 != null
            ? { content: f.base64, encoding: 'base64' }
            : { content: f.content, encoding: 'utf-8' });
        treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }

      const tree = await gh(pat, 'POST', `/repos/${owner}/${repo}/git/trees`, {
        base_tree: baseCommit.tree.sha,
        tree: treeItems,
      });
      const commit = await gh(pat, 'POST', `/repos/${owner}/${repo}/git/commits`, {
        message,
        tree: tree.sha,
        parents: [baseSha],
      });
      await gh(pat, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        sha: commit.sha,
        force: false,
      });
      return { sha: commit.sha };
    } catch (e) {
      const retriable = e.status === 409 || e.status === 422;
      if (attempt === 0 && retriable) continue; // stale ref: re-read and retry once
      throw e;
    }
  }
  throw new Error('unreachable');
}

/** Latest Pages/Actions build state for the repo's deploy workflow. */
export async function latestBuildStatus(env, sinceSha) {
  const [owner, repo] = env.GITHUB_REPO.split('/');
  const runs = await gh(env.GITHUB_PAT, 'GET',
    `/repos/${owner}/${repo}/actions/runs?per_page=10&branch=${env.GITHUB_BRANCH || 'main'}`);
  const match = (runs.workflow_runs || []).find((r) => !sinceSha || r.head_sha === sinceSha);
  if (!match) return { state: 'pending' };
  if (match.status !== 'completed') return { state: 'building' };
  return { state: match.conclusion === 'success' ? 'live' : 'build_failed', url: match.html_url };
}

/** Days until the configured PAT expiry date (null if not set). */
export function patDaysLeft(patExpiresOn) {
  if (!patExpiresOn) return null;
  const ms = new Date(`${patExpiresOn}T00:00:00Z`).getTime() - Date.now();
  return Math.floor(ms / 86_400_000);
}
