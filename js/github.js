// GitHub REST API（読み取りのみ）
const API = "https://api.github.com";

export function parseRepo(text) {
  const t = String(text || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = t.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/) || t.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function parseCommitUrl(text) {
  const m = String(text || "").trim().match(/github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})/i);
  return m ? { repo: `${m[1]}/${m[2]}`, sha: m[3] } : null;
}

async function gh(path, token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try { res = await fetch(API + path, { headers }); }
  catch { throw new Error("GitHubに接続できません。通信状況を確認してください"); }
  if (res.ok) return res.json();
  if (res.status === 401) throw new Error("GitHubトークンが無効です。設定で入れ直してください");
  if (res.status === 403 || res.status === 429) throw new Error("GitHubの利用回数の上限です。設定でトークンを入れると上限が増えます");
  if (res.status === 404) throw new Error(token ? "リポジトリが見つかりません。名前とトークンの対象リポジトリを確認してください" : "リポジトリが見つかりません。非公開リポジトリなら設定でトークンが必要です");
  if (res.status === 409) return []; // 空のリポジトリ
  throw new Error(`GitHubエラー（${res.status}）`);
}

const toCommit = (repo, c) => ({
  repo,
  sha: c.sha,
  message: String(c.commit?.message || "").split("\n")[0].slice(0, 140),
  url: c.html_url,
  date: c.commit?.author?.date || c.commit?.committer?.date || "",
});

// dateStr（YYYY-MM-DD, 端末の現地時間）の0:00〜24:00のコミット
export async function commitsOn(repo, dateStr, token) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const since = new Date(y, m - 1, d).toISOString();
  const until = new Date(y, m - 1, d + 1).toISOString();
  const list = await gh(`/repos/${repo}/commits?since=${since}&until=${until}&per_page=50`, token);
  return list.map((c) => toCommit(repo, c));
}

export async function commitInfo(repo, sha, token) {
  return toCommit(repo, await gh(`/repos/${repo}/commits/${sha}`, token));
}

/* ---------- リポジトリ内のファイル（資料・成果物用） ---------- */
const encPath = (p) => String(p).split("/").map(encodeURIComponent).join("/");
export const githubFileUrl = (repo, path) => `https://github.com/${repo}/blob/HEAD/${encPath(path)}`;

const DOC_EXT = /\.(pdf|docx|pptx|md|markdown|txt|png|jpe?g|gif|webp|svg)$/i;
export async function listRepoFiles(repo, token) {
  const r = await gh(`/repos/${repo}/git/trees/HEAD?recursive=1`, token);
  return (r.tree || []).filter((t) => t.type === "blob" && DOC_EXT.test(t.path)).map((t) => ({ path: t.path, size: t.size || 0 }));
}

export async function fetchRepoFile(repo, path, token) {
  const headers = { Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try { res = await fetch(`${API}/repos/${repo}/contents/${encPath(path)}`, { headers }); }
  catch { throw new Error("GitHubに接続できません。通信状況を確認してください"); }
  if (res.ok) return res.blob();
  if (res.status === 404) throw new Error("GitHub上にファイルが見つかりません。名前を変えたり消したりしていないか確認してください");
  if (res.status === 401) throw new Error("GitHubトークンが無効です。設定で入れ直してください");
  if (res.status === 403) throw new Error("GitHubの利用回数の上限か、ファイルが大きすぎます。「GitHubで開く」から見てください");
  throw new Error(`GitHubエラー（${res.status}）`);
}
