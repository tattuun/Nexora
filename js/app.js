import { createStore, isDemo } from "./store.js";
import { ALLOWED_EMAIL } from "./config.js";
import { parseRepo, parseCommitUrl, commitsOn, commitInfo } from "./github.js";
import { DEFAULT_MODEL, weekRange, shiftDate, buildPrompt, callClaude, ymd } from "./summary.js";

/* ================= util ================= */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => ymd(new Date());
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const WD = "日月火水木金土";
const dayDiff = (s) => {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5);
};
const dueCls = (n) => (n == null ? "" : n < 0 ? "over" : n <= 7 ? "warn" : "");
const dueTxt = (n) => (n == null ? "" : n < 0 ? `${-n}日超過` : n === 0 ? "今日まで" : `あと${n}日`);
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB");
const byCreated = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);

let toastT;
function toast(m) {
  const t = $("#toast");
  t.textContent = m;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2600);
}

/* 端末ごとの設定（トークン類はこの端末にだけ保存） */
const SETTINGS_KEY = "rlog-settings";
function loadSettings() {
  try { return { githubToken: "", anthropicKey: "", model: DEFAULT_MODEL, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch { return { githubToken: "", anthropicKey: "", model: DEFAULT_MODEL }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch {}
}

/* ================= state ================= */
const S = {
  store: null, user: null,
  cats: [], logs: [], summaries: [],
  view: "cat", sel: null, showDetail: false, editing: null, q: "",
  draft: null,              // 編集中の記録の付属情報 {commits, att, removed}
  gh: { key: "", loading: false, list: [], errors: [] },
  week: today(), summary: { text: "", busy: false, err: "", loadedFor: "" },
  settings: loadSettings(),
  unsub: [],
};

/* ================= storage helpers ================= */
function fail(e) {
  console.error(e);
  const c = e?.code || "";
  toast(c === "quota" || c === "resource-exhausted" ? "保存容量の上限です。古い添付を削除してください"
    : c === "permission-denied" ? "保存が拒否されました。firestore.rules とログイン中のアカウントを確認してください"
    : "保存に失敗しました。通信状況を確認して、もう一度お試しください");
}
// Firestore は書き込みを手元に即反映し、送信はバックグラウンドで行う。画面は待たせない
const put = (c, id, v) => S.store.put(c, id, v).catch(fail);
const remove = (c, id) => S.store.remove(c, id).catch(fail);
const strip = (o) => { const { id, ...r } = o; return r; };

/* ================= derived ================= */
const cat = () => S.cats.find((c) => c.id === S.sel);
const sortedCats = () => [...S.cats].sort(byCreated);
const logsOf = (id) => S.logs.filter((l) => l.categoryId === id)
  .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
function nextDue(c) {
  const open = (c.milestones || []).filter((m) => !m.done && m.due).sort((a, b) => a.due.localeCompare(b.due));
  if (open[0]) return { label: open[0].title, due: open[0].due };
  if (c.deadline) return { label: "最終期限", due: c.deadline };
  return null;
}
// 編集中の記録より前で、いちばん新しい記録
function prevLog(catId, date, selfId, selfCreated) {
  return logsOf(catId).find((l) => l.id !== selfId &&
    (l.date < date || (l.date === date && (l.createdAt || 0) < (selfCreated ?? Infinity))));
}

/* ================= render: frame ================= */
let lastKey = "";
function render() {
  const root = $("#root");
  if (!S.user) return renderLogin();
  if (!root.querySelector(".app")) {
    root.innerHTML = `<div class="app"><aside class="side" id="side"></aside><main class="main"><div class="wrap" id="view"></div></main></div>`;
  }
  // 再描画しても入力途中の文字と入力位置を失わない
  const v = $("#view");
  const key = [S.view, S.sel, S.editing, S.week].join("|");
  const draftVals = {};
  if (key === lastKey) v.querySelectorAll("input[id],textarea[id],select[id]").forEach((el) => {
    if (!["checkbox", "file"].includes(el.type)) draftVals[el.id] = el.value;
  });
  const active = document.activeElement;
  const focusId = active && v.contains(active) ? active.id : null;
  const openDetails = [...v.querySelectorAll("details[id]")].filter((d) => d.open).map((d) => d.id);
  lastKey = key;

  renderSide();
  v.innerHTML = S.view === "week" ? viewWeek() : S.view === "settings" ? viewSettings() : viewCat();

  for (const [id, val] of Object.entries(draftVals)) { const el = document.getElementById(id); if (el) el.value = val; }
  openDetails.forEach((id) => { const d = document.getElementById(id); if (d) d.open = true; });
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el?.focus) { el.focus(); if (el.setSelectionRange && /text|search|url|password|textarea/.test(el.type)) try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
  }
}

function renderLogin(err = "") {
  $("#root").innerHTML = `<div class="login"><div class="panel">
    <h1>研究開発支援システム</h1>
    <p class="muted" style="margin:0">日々の作業と、その理由を残すための研究ログです。</p>
    ${err ? `<p class="err" style="margin:0">${esc(err)}</p>` : ""}
    <button class="btn pri" id="login" type="button">Googleでログイン</button>
  </div></div>`;
}

function renderSide() {
  const items = sortedCats().map((c) => {
    const n = logsOf(c.id).length;
    const nd = nextDue(c);
    const dd = nd && dayDiff(nd.due);
    const cur = S.view === "cat" && c.id === S.sel;
    return `<li><button class="cat" data-cat="${esc(c.id)}" aria-current="${cur}" type="button"><span class="nm">${esc(c.name)}</span><span class="ct">${n}件</span>${nd ? `<span class="sub ${dueCls(dd)}">${esc(nd.label)}：${dueTxt(dd)}</span>` : ""}</button></li>`;
  }).join("") || `<li class="muted">まだありません</li>`;
  $("#side").innerHTML = `
    <div class="brand">研究開発支援システム<small>RESEARCH LOGBOOK</small></div>
    <form class="addcat" id="addcat"><input type="text" id="newcat" placeholder="＋ カテゴリ追加" aria-label="新しいカテゴリ名" maxlength="40"><button class="btn sm" type="submit">追加</button></form>
    <div><div class="lbl" style="margin-bottom:6px">カテゴリ</div><ul class="cats">${items}</ul></div>
    <ul class="nav">
      <li><button class="navbtn" data-view="week" aria-current="${S.view === "week"}" type="button">週次まとめ</button></li>
      <li><button class="navbtn" data-view="settings" aria-current="${S.view === "settings"}" type="button">設定・バックアップ</button></li>
    </ul>
    <div class="side-foot">${isDemo ? "デモモード（このブラウザにだけ保存）" : `${esc(S.user.email)}<br>自動保存オン`}</div>`;
}

/* ================= view: category ================= */
function viewCat() {
  const c = cat();
  const banner = isDemo ? `<div class="banner">デモモードです。js/config.js にFirebaseの設定を入れると、ログインして全端末で同期できます。</div>` : "";
  if (!c) return banner + `<div class="empty">${S.cats.length ? "左のカテゴリを選ぶと、日ごとの作業履歴が表示されます。" : "左上の「＋ カテゴリ追加」で研究テーマ（例：卒研、ドローン）を作ると始められます。"}</div>`;
  const nd = nextDue(c);
  const dd = nd && dayDiff(nd.due);
  let logs = logsOf(c.id);
  if (S.q) {
    const q = S.q.toLowerCase();
    logs = logs.filter((l) => [l.title, l.work, l.reason, l.result, l.code, l.lang, ...(l.commits || []).map((k) => k.message)].join("\n").toLowerCase().includes(q));
  }
  return `${banner}
  <div class="head"><div><h1>${esc(c.name)}</h1><div class="purpose">${c.purpose ? esc(c.purpose) : "目的・期限・リポジトリは「詳細」から設定できます"}${nd ? ` <span class="days ${dueCls(dd)}" style="margin-left:6px">${esc(nd.label)} ${dueTxt(dd)}</span>` : ""}</div></div>
  <div class="actions"><button class="btn" id="tg-detail" aria-pressed="${S.showDetail}" type="button">詳細</button><button class="btn pri" id="new-log" type="button">＋ 追加</button></div></div>
  ${S.showDetail ? viewDetail(c) : ""}
  ${S.editing ? viewEditor(c) : ""}
  <div class="tools"><input type="search" id="q" placeholder="このカテゴリの記録を検索（作業・理由・コード・コミット）" value="${esc(S.q)}" aria-label="検索"><span class="lbl">${logs.length}件</span></div>
  ${logs.length ? `<ol class="tl">${logs.map((l) => viewLog(l, c)).join("")}</ol>` : `<div class="empty">${S.q ? "一致する記録はありません。" : "まだ記録がありません。「＋ 追加」から今日の作業を残しましょう。"}</div>`}`;
}

function viewDetail(c) {
  const ms = c.milestones || [];
  const done = ms.filter((m) => m.done).length;
  const pct = ms.length ? Math.round((done / ms.length) * 100) : 0;
  const dd = dayDiff(c.deadline);
  return `<section class="panel" aria-label="詳細">
    <h2>詳細：目的・期限・ロードマップ</h2>
    <label class="fld"><span>このテーマの目的・ゴール</span><textarea id="d-purpose" rows="2">${esc(c.purpose)}</textarea></label>
    <div class="row">
      <label class="fld"><span>最終期限</span><input type="date" id="d-deadline" value="${esc(c.deadline)}"></label>
      <div class="fld"><span>残り</span><div style="padding-top:6px">${c.deadline ? `<span class="days ${dueCls(dd)}">${dueTxt(dd)}</span>` : `<span class="muted">期限未設定</span>`}</div></div>
    </div>
    <label class="fld"><span>GitHubリポジトリ <em>（1行に1つ。owner/name またはURL）</em></span><textarea id="d-repos" rows="2" style="min-height:56px" placeholder="例：tattu/check-swing">${esc((c.repos || []).join("\n"))}</textarea></label>
    <div class="actions" style="justify-content:flex-end"><button class="btn pri sm" id="d-save" type="button">目的・期限・リポジトリを保存</button></div>
    <div class="fld"><span>ロードマップ <em>（${done}/${ms.length} 完了）</em></span><div class="progress" aria-hidden="true"><i style="width:${pct}%"></i></div></div>
    <ul class="ms">${ms.map((m) => {
      const d = dayDiff(m.due);
      return `<li class="${m.done ? "done" : ""}"><input type="checkbox" data-ms-toggle="${esc(m.id)}" ${m.done ? "checked" : ""} aria-label="完了"><span class="t">${esc(m.title)}</span><span class="due ${m.done ? "" : dueCls(d)}">${m.due ? esc(m.due.slice(5).replace("-", "/")) + (m.done ? "" : " · " + dueTxt(d)) : "期限なし"}</span><button class="x" data-ms-del="${esc(m.id)}" aria-label="削除" type="button">×</button></li>`;
    }).join("") || `<li class="muted" style="display:block">マイルストーンを追加すると、記録をその段階に紐づけられます</li>`}</ul>
    <form class="ms-add" id="ms-add"><input type="text" id="ms-title" placeholder="マイルストーン（例：データセット作成）" aria-label="マイルストーン名"><input type="date" id="ms-due" aria-label="期限"><button class="btn sm" type="submit">追加</button></form>
    <div class="actions"><button class="btn danger sm" data-arm="cat" type="button">このカテゴリを削除</button></div>
  </section>`;
}

function viewCommits(c) {
  const repos = c.repos || [];
  const sel = S.draft.commits;
  const selShas = new Set(sel.map((k) => k.sha));
  const shown = [...S.gh.list];
  for (const k of sel) if (!shown.some((x) => x.sha === k.sha)) shown.push(k);
  let body;
  if (!repos.length && !shown.length) body = `<p class="muted" style="margin:0">「詳細」でGitHubリポジトリを登録すると、この日のコミットが自動で一覧に出ます。</p>`;
  else if (S.gh.loading && !shown.length) body = `<p class="muted" style="margin:0">コミットを読み込み中…</p>`;
  else if (!shown.length) body = `<p class="muted" style="margin:0">この日のコミットはありません（既定ブランチのみ表示）。</p>`;
  else body = `<ul class="commits">${shown.map((k) => `<li><label><input type="checkbox" data-commit="${esc(k.sha)}" ${selShas.has(k.sha) ? "checked" : ""}><code class="sha">${esc(k.repo.split("/")[1])}@${esc(k.sha.slice(0, 7))}</code><span class="msg" title="${esc(k.message)}">${esc(k.message)}</span></label></li>`).join("")}</ul>`;
  return `${body}${S.gh.errors.map((e) => `<p class="err" style="margin:0">${esc(e)}</p>`).join("")}`;
}

function viewEditor(c) {
  const isNew = S.editing === "new";
  const e = isNew ? { date: today() } : S.logs.find((l) => l.id === S.editing) || {};
  const ms = c.milestones || [];
  const dateNow = $("#e-date")?.value || e.date;
  const prev = prevLog(c.id, dateNow, e.id, isNew ? undefined : e.createdAt);
  const att = S.draft.att;
  return `<form class="panel" id="editor" aria-label="作業記録">
    <h2>${isNew ? "作業を記録" : "記録を編集"}</h2>
    ${prev && prev.result ? `<div class="callout"><b>前回（${esc(prev.date.slice(5).replace("-", "/"))}「${esc(prev.title)}」）の結果・次にやること</b><p>${esc(prev.result)}</p></div>` : ""}
    <div class="row">
      <label class="fld"><span>日付</span><input type="date" id="e-date" value="${esc(e.date)}" required></label>
      <label class="fld"><span>研究のどの部分か</span><select id="e-part"><option value="">（指定なし）</option>${ms.map((m) => `<option value="${esc(m.id)}" ${e.partId === m.id ? "selected" : ""}>${esc(m.title)}</option>`).join("")}</select></label>
    </div>
    <label class="fld"><span>ひとことで</span><input type="text" id="e-title" value="${esc(e.title)}" placeholder="例：推論をFP16化して速度比較" maxlength="80" required></label>
    <label class="fld"><span>何を・どうやって進めたか</span><textarea id="e-work" rows="3">${esc(e.work)}</textarea></label>
    <label class="fld"><span>なぜそうしたか <em>（意図・判断理由。後から一番知りたくなる所）</em></span><textarea id="e-reason" rows="3">${esc(e.reason)}</textarea></label>
    <label class="fld"><span>結果・次にやること <em>（次回の記録で上に表示されます）</em></span><textarea id="e-result" rows="2">${esc(e.result)}</textarea></label>
    <div class="fld"><span>この日のコミット <em>（チェックしたものを記録に紐づけ）</em></span>
      <div id="commit-area">${viewCommits(c)}</div>
      <div class="inline"><input type="url" id="e-commit-url" placeholder="他のコミットはURLを貼って追加"><button class="btn sm" id="add-commit" type="button">追加</button></div>
    </div>
    <details class="att" id="att-box"${att.length ? " open" : ""}><summary>添付（任意）：写真・スクショ・小さなファイル${att.length ? `　${att.length}件` : ""}</summary>
      <div class="drop" id="drop">ここにドロップ、または Ctrl+V でスクショを貼り付け　<label class="btn sm">ファイルを選ぶ<input type="file" id="e-file" multiple hidden></label><br><span class="hint">画像は自動で縮小します。画像以外は600KBまで。大きいログ（.ulg等）はリンク欄へ。</span></div>
      ${att.length ? `<ul class="att-list">${att.map((a) => `<li>${a.thumb ? `<img src="${a.thumb}" alt="">` : ""}<span class="fn">${esc(a.name)}</span><span class="muted">${kb(a.size)}</span><button class="x" data-att-del="${esc(a.id)}" type="button" aria-label="添付を外す">×</button></li>`).join("")}</ul>` : ""}
    </details>
    <details class="att" id="code-box"${e.code ? " open" : ""}><summary>コード断片・参考リンク（任意）</summary>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
        <div class="row">
          <label class="fld"><span>言語・ファイル名</span><input type="text" id="e-lang" value="${esc(e.lang)}" placeholder="例：python / infer.py"></label>
          <label class="fld"><span>参考リンク <em>（1行に1つ）</em></span><textarea id="e-links" rows="1" style="min-height:38px">${esc((e.links || []).join("\n"))}</textarea></label>
        </div>
        <label class="fld"><span>コード断片 <em>（要点だけ。全体はコミットで）</em></span><textarea class="code" id="e-code" spellcheck="false">${esc(e.code)}</textarea></label>
      </div>
    </details>
    <div class="actions" style="justify-content:flex-end"><button class="btn" type="button" id="e-cancel">キャンセル</button><button class="btn pri" type="submit" id="e-save">保存</button></div>
  </form>`;
}

function viewLog(l, c) {
  const [y, m, d] = (l.date || "----").split("-");
  const wd = l.date ? WD[new Date(+y, +m - 1, +d).getDay()] : "";
  const part = (c.milestones || []).find((x) => x.id === l.partId);
  const links = (l.links || []).filter(Boolean);
  const commits = l.commits || [];
  const att = l.attach || [];
  return `<li class="entry"><div class="date"><b>${esc(m)}/${esc(d)}</b><span>${esc(y)} (${wd})</span></div>
  <article class="card"><div class="top"><h3>${esc(l.title)}</h3>${part ? `<span class="chip">${esc(part.title)}</span>` : ""}</div>
  <dl class="sec">${l.work ? `<dt>作業内容</dt><dd>${esc(l.work)}</dd>` : ""}${l.reason ? `<dt>理由・意図</dt><dd class="why">${esc(l.reason)}</dd>` : ""}${l.result ? `<dt>結果・次</dt><dd>${esc(l.result)}</dd>` : ""}${commits.length ? `<dt>コミット</dt><dd class="ck">${commits.map((k) => `<a href="${esc(k.url)}" target="_blank" rel="noopener" title="${esc(k.message)}"><code>${esc(k.repo.split("/")[1])}@${esc(k.sha.slice(0, 7))}</code>${esc(k.message)}</a>`).join("")}</dd>` : ""}${links.length ? `<dt>リンク</dt><dd class="links">${links.map((u) => (/^https?:\/\//.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>` : esc(u))).join("<br>")}</dd>` : ""}</dl>
  ${att.length ? `<div class="thumbs">${att.map((a) => `<button type="button" data-open-att="${esc(a.id)}" title="${esc(a.name)}">${a.thumb ? `<img src="${a.thumb}" alt="${esc(a.name)}">` : `<span class="file">${esc(a.name)}</span>`}</button>`).join("")}</div>` : ""}
  ${l.code ? `<div class="codebox"><div class="bar"><span>${esc(l.lang || "code")}</span><button class="btn sm" data-copy="${esc(l.id)}" type="button">コピー</button></div><pre><code>${esc(l.code)}</code></pre></div>` : ""}
  <div class="foot"><button class="btn sm" data-edit="${esc(l.id)}" type="button">編集</button><button class="btn sm danger" data-arm="log:${esc(l.id)}" type="button">削除</button></div></article></li>`;
}

/* ================= view: week ================= */
function weekData() {
  const { start, end } = weekRange(S.week);
  const logs = S.logs.filter((l) => l.date >= start && l.date <= end);
  return { start, end, logs, cats: sortedCats() };
}
function viewWeek() {
  const w = weekData();
  const saved = S.summaries.find((s) => s.id === w.start);
  if (S.summary.loadedFor !== w.start) { S.summary.text = saved?.text || ""; S.summary.err = ""; S.summary.loadedFor = w.start; }
  const groups = w.cats.map((c) => {
    const ls = w.logs.filter((l) => l.categoryId === c.id).sort((a, b) => a.date.localeCompare(b.date));
    return ls.length ? `<div class="wk-cat"><h3>${esc(c.name)}</h3><ul>${ls.map((l) => `<li><span>${esc(l.date.slice(5).replace("-", "/"))}</span>${esc(l.title)}</li>`).join("")}</ul></div>` : "";
  }).join("");
  const hasKey = !!S.settings.anthropicKey;
  return `<div class="head"><div><h1>週次まとめ</h1><div class="purpose">1週間の記録から、ゼミ報告の下書きを作ります。</div></div></div>
  <div class="weeknav"><button class="btn sm" data-week="-7" type="button">← 前の週</button><span class="range">${esc(w.start.replace(/-/g, "/"))} 〜 ${esc(w.end.slice(5).replace("-", "/"))}</span><button class="btn sm" data-week="7" type="button">次の週 →</button><button class="btn sm" data-week="0" type="button">今週</button></div>
  <section class="panel"><h2>この週の記録（${w.logs.length}件）</h2>${groups || `<p class="muted" style="margin:0">この週の記録はありません。</p>`}</section>
  <section class="panel"><h2>ゼミ報告の下書き</h2>
    <div class="actions">
      <button class="btn pri" id="sum-gen" type="button" ${!w.logs.length || !hasKey || S.summary.busy ? "disabled" : ""}>${S.summary.busy ? "作成中…" : "Claudeで下書きを作成"}</button>
      <button class="btn" id="sum-copy-prompt" type="button" ${w.logs.length ? "" : "disabled"}>依頼文をコピー（claude.aiに貼る用）</button>
    </div>
    ${hasKey ? "" : `<p class="hint" style="margin:0">APIキー未設定のため、「依頼文をコピー」→ claude.ai に貼り付け → 返ってきた文章を下に貼って保存、の流れで使えます。APIキーは「設定」で登録できます。</p>`}
    ${S.summary.err ? `<p class="err" style="margin:0">${esc(S.summary.err)}</p>` : ""}
    <textarea class="out" id="sum-text" placeholder="ここに下書きが入ります（手で直してから保存できます）">${esc(S.summary.text)}</textarea>
    <div class="actions" style="justify-content:space-between"><span class="hint">${saved ? `保存済み：${new Date(saved.updatedAt).toLocaleString("ja-JP")}` : "未保存"}</span><span class="actions"><button class="btn" id="sum-copy" type="button">下書きをコピー</button><button class="btn pri" id="sum-save" type="button">この週の下書きとして保存</button></span></div>
  </section>`;
}

/* ================= view: settings ================= */
function viewSettings() {
  const s = S.settings;
  return `<div class="head"><div><h1>設定・バックアップ</h1><div class="purpose">トークンとAPIキーは、この端末のブラウザにだけ保存されます（同期されません）。</div></div></div>
  <section class="panel"><h2>GitHub連携</h2>
    <label class="fld"><span>GitHubトークン <em>（非公開リポジトリのコミット表示に必要。公開リポジトリだけなら空でOK）</em></span><input type="password" id="s-gh" value="${esc(s.githubToken)}" autocomplete="off" placeholder="github_pat_…"></label>
    <p class="hint" style="margin:0">GitHub → Settings → Developer settings → Fine-grained tokens で作成。対象リポジトリを選び、権限は Contents: Read-only のみ。</p>
  </section>
  <section class="panel"><h2>週次まとめ（Claude API）</h2>
    <label class="fld"><span>Anthropic APIキー <em>（任意。無ければ「依頼文をコピー」方式で使えます）</em></span><input type="password" id="s-ak" value="${esc(s.anthropicKey)}" autocomplete="off" placeholder="sk-ant-…"></label>
    <label class="fld"><span>モデル名</span><input type="text" id="s-model" value="${esc(s.model)}"></label>
    <p class="hint" style="margin:0">従量課金です。Claude Console でワークスペースの利用上限を設定しておくと安心です。</p>
  </section>
  <div class="actions" style="justify-content:flex-end"><button class="btn pri" id="s-save" type="button">設定を保存</button></div>
  <section class="panel"><h2>バックアップ</h2>
    <div class="actions">
      <button class="btn" id="exp-md" type="button">Markdownで書き出し</button>
      <button class="btn" id="exp-json" type="button">JSONで全データ書き出し</button>
      <label class="btn">JSONから読み込み<input type="file" id="imp-json" accept="application/json,.json" hidden></label>
    </div>
    <p class="hint" style="margin:0">JSONには添付も含まれます。読み込みは同じIDの記録を上書きし、それ以外は残します。</p>
  </section>
  <section class="panel"><h2>アカウント</h2>
    <div class="kv"><span class="muted">保存先</span><span>${isDemo ? "このブラウザ（デモモード）" : "Firebase（Firestore）"}</span>
    ${isDemo ? "" : `<span class="muted">ログイン中</span><span>${esc(S.user.email)}</span><span class="muted">あなたのUID</span><code>${esc(S.user.uid)}</code>`}</div>
    ${isDemo ? "" : `<p class="hint" style="margin:0">UID は firestore.rules に書き込むと、このアカウント以外を完全に締め出せます（README参照）。</p><div class="actions"><button class="btn" id="logout" type="button">ログアウト</button></div>`}
  </section>`;
}

/* ================= editor helpers ================= */
function openEditor(id) {
  S.editing = id;
  const l = id === "new" ? null : S.logs.find((x) => x.id === id);
  S.draft = { commits: [...(l?.commits || [])], att: [...(l?.attach || [])], removed: [] };
  S.gh = { key: "", loading: false, list: [], errors: [] };
  render();
  loadCommits();
}

async function loadCommits() {
  const c = cat();
  const date = $("#e-date")?.value;
  if (!c || !date || !(c.repos || []).length) return;
  const key = c.id + "|" + date + "|" + c.repos.join(",");
  if (S.gh.key === key) return;
  S.gh = { key, loading: true, list: [], errors: [] };
  refreshCommits();
  const results = await Promise.allSettled(c.repos.map((r) => commitsOn(r, date, S.settings.githubToken)));
  if (S.gh.key !== key) return;
  S.gh.loading = false;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") S.gh.list.push(...r.value);
    else S.gh.errors.push(`${c.repos[i]}：${r.reason.message}`);
  });
  S.gh.list.sort((a, b) => b.date.localeCompare(a.date));
  refreshCommits();
}
function refreshCommits() {
  const c = cat();
  const box = $("#commit-area");
  if (box && c && S.draft) box.innerHTML = viewCommits(c);
}

/* 画像は縮小して JPEG に。Firestore の1文書1MB制限に収める */
const MAX_DATA = 850_000;
const MAX_RAW = 600 * 1024;
function readDataURL(file) {
  return new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ng; r.readAsDataURL(file); });
}
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function scaled(img, maxDim, quality) {
  const r = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement("canvas");
  cv.width = Math.round(img.naturalWidth * r);
  cv.height = Math.round(img.naturalHeight * r);
  const g = cv.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", quality);
}
async function toAttachment(file) {
  const id = uid();
  if (/^image\/(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(file.type)) {
    let img;
    try { img = await loadImage(file); } catch { throw new Error(`${file.name}：この形式の画像は読み込めません`); }
    let data = "";
    for (const [dim, q] of [[1600, 0.85], [1600, 0.7], [1280, 0.65], [1024, 0.6], [800, 0.55]]) {
      data = scaled(img, dim, q);
      if (data.length < MAX_DATA) break;
    }
    if (data.length >= MAX_DATA) throw new Error(`${file.name}：画像が大きすぎます`);
    const name = file.name && file.name !== "image.png" ? file.name.replace(/\.\w+$/, "") + ".jpg" : `screenshot-${today()}.jpg`;
    return { id, name, type: "image/jpeg", size: Math.round(data.length * 0.75), thumb: scaled(img, 240, 0.6), data, isNew: true };
  }
  if (file.size > MAX_RAW) throw new Error(`${file.name}：${kb(file.size)}あるため添付できません（600KBまで）。リンク欄を使ってください`);
  return { id, name: file.name, type: file.type || "application/octet-stream", size: file.size, thumb: "", data: await readDataURL(file), isNew: true };
}
async function addFiles(files) {
  if (!S.draft) return;
  for (const f of files) {
    try { S.draft.att.push(await toAttachment(f)); }
    catch (e) { toast(e.message); }
  }
  render();
  const box = $("#att-box");
  if (box) box.open = true;
}

async function openAttachment(id) {
  let a;
  try { a = await S.store.get("attachments", id); } catch (e) { return fail(e); }
  if (!a) return toast("添付が見つかりません");
  if (a.type.startsWith("image/")) {
    $("#lightbox-img").src = a.data;
    $("#lightbox").hidden = false;
  } else {
    const link = document.createElement("a");
    link.href = a.data;
    link.download = a.name;
    link.click();
  }
}

/* ================= export / import ================= */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportMd() {
  let md = `# 研究開発ログ（${today()} 書き出し）\n`;
  for (const c of sortedCats()) {
    md += `\n## ${c.name}\n`;
    if (c.purpose) md += `\n目的：${c.purpose}\n`;
    if (c.deadline) md += `最終期限：${c.deadline}\n`;
    if ((c.repos || []).length) md += `リポジトリ：${c.repos.join(", ")}\n`;
    if ((c.milestones || []).length) md += `\n### ロードマップ\n` + c.milestones.map((m) => `- [${m.done ? "x" : " "}] ${m.title}${m.due ? `（${m.due}）` : ""}`).join("\n") + "\n";
    for (const l of [...logsOf(c.id)].reverse()) {
      const p = (c.milestones || []).find((x) => x.id === l.partId);
      md += `\n### ${l.date} ${l.title}${p ? ` ［${p.title}］` : ""}\n`;
      if (l.work) md += `\n**作業内容**\n${l.work}\n`;
      if (l.reason) md += `\n**理由・意図**\n${l.reason}\n`;
      if (l.result) md += `\n**結果・次**\n${l.result}\n`;
      if (l.commits?.length) md += `\n**コミット**\n` + l.commits.map((k) => `- [${k.repo}@${k.sha.slice(0, 7)}](${k.url}) ${k.message}`).join("\n") + "\n";
      if (l.links?.length) md += `\n**リンク**\n` + l.links.map((u) => `- ${u}`).join("\n") + "\n";
      if (l.attach?.length) md += `\n**添付**：${l.attach.map((a) => a.name).join("、")}（JSONバックアップに含まれます）\n`;
      if (l.code) md += "\n```" + (l.lang || "").split(/[\s/]/)[0] + "\n" + l.code + "\n```\n";
    }
  }
  download(`research-log-${today()}.md`, md, "text/markdown");
}
async function exportJson() {
  toast("書き出し中…");
  try {
    const out = { app: "research-log", version: 1, exportedAt: new Date().toISOString() };
    for (const c of ["categories", "logs", "summaries", "attachments"]) out[c] = await S.store.all(c);
    download(`research-log-${today()}.json`, JSON.stringify(out, null, 1), "application/json");
  } catch (e) { fail(e); }
}
async function importJson(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("JSONとして読めませんでした"); }
  if (data?.app !== "research-log") return toast("このシステムのバックアップファイルではありません");
  let n = 0;
  try {
    for (const c of ["categories", "logs", "summaries", "attachments"]) {
      for (const d of data[c] || []) { if (d?.id) { await S.store.put(c, d.id, strip(d)); n++; } }
    }
    toast(`${n}件を読み込みました`);
  } catch (e) { fail(e); }
}

/* ================= events ================= */
let armed = null, armT;
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("button,input[type=checkbox]");
  if (ev.target.closest("#lightbox") && !ev.target.closest("img")) { $("#lightbox").hidden = true; return; }
  if (!t) return;
  const c = cat();

  if (t.id === "login") {
    try { await S.store.signIn(); } catch (e) { if (e?.code !== "auth/popup-closed-by-user") renderLogin("ログインできませんでした。ポップアップがブロックされていないか確認してください"); }
    return;
  }
  if (t.id === "logout") { S.unsub.forEach((f) => f()); S.unsub = []; await S.store.signOut(); return; }
  if (t.dataset.cat) { S.view = "cat"; S.sel = t.dataset.cat; S.editing = null; S.draft = null; S.showDetail = false; S.q = ""; render(); window.scrollTo({ top: 0 }); return; }
  if (t.dataset.view) { S.view = t.dataset.view; S.editing = null; S.draft = null; render(); window.scrollTo({ top: 0 }); return; }
  if (t.id === "tg-detail") { S.showDetail = !S.showDetail; render(); return; }
  if (t.id === "new-log") { openEditor("new"); $("#e-title")?.focus(); return; }
  if (t.id === "e-cancel") { S.editing = null; S.draft = null; render(); return; }
  if (t.dataset.edit) { openEditor(t.dataset.edit); $("#editor")?.scrollIntoView({ block: "start" }); return; }
  if (t.dataset.openAtt) { openAttachment(t.dataset.openAtt); return; }
  if (t.dataset.attDel) {
    const a = S.draft.att.find((x) => x.id === t.dataset.attDel);
    S.draft.att = S.draft.att.filter((x) => x.id !== t.dataset.attDel);
    if (a && !a.isNew) S.draft.removed.push(a.id);
    render(); return;
  }
  if (t.dataset.commit) {
    const sha = t.dataset.commit;
    if (t.checked) { const k = S.gh.list.find((x) => x.sha === sha); if (k && !S.draft.commits.some((x) => x.sha === sha)) S.draft.commits.push(k); }
    else S.draft.commits = S.draft.commits.filter((x) => x.sha !== sha);
    return;
  }
  if (t.id === "add-commit") {
    const inp = $("#e-commit-url");
    const p = parseCommitUrl(inp.value);
    if (!p) return toast("GitHubのコミットURL（…/commit/英数字）を貼ってください");
    t.disabled = true;
    try {
      const k = await commitInfo(p.repo, p.sha, S.settings.githubToken);
      if (!S.draft.commits.some((x) => x.sha === k.sha)) S.draft.commits.push(k);
      inp.value = "";
      refreshCommits();
    } catch (e) { toast(e.message); }
    t.disabled = false;
    return;
  }
  if (t.dataset.copy) {
    const l = S.logs.find((x) => x.id === t.dataset.copy);
    try { await navigator.clipboard.writeText(l.code); toast("コピーしました"); } catch { toast("コピーできませんでした"); }
    return;
  }
  if (t.dataset.arm) {
    if (armed !== t.dataset.arm) {
      armed = t.dataset.arm;
      t.classList.add("arm");
      t.textContent = "もう一度押すと削除";
      clearTimeout(armT);
      armT = setTimeout(() => { armed = null; render(); }, 3500);
      return;
    }
    armed = null; clearTimeout(armT);
    if (t.dataset.arm === "cat") {
      for (const l of logsOf(c.id)) { for (const a of l.attach || []) remove("attachments", a.id); remove("logs", l.id); }
      remove("categories", c.id);
      S.sel = null; S.showDetail = false;
      toast("カテゴリを削除しました");
    } else {
      const l = S.logs.find((x) => x.id === t.dataset.arm.slice(4));
      if (l) { for (const a of l.attach || []) remove("attachments", a.id); remove("logs", l.id); }
      toast("記録を削除しました");
    }
    render(); return;
  }
  if (t.id === "d-save") {
    const repos = [];
    const bad = [];
    for (const line of $("#d-repos").value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)) {
      const r = parseRepo(line);
      r ? repos.includes(r) || repos.push(r) : bad.push(line);
    }
    if (bad.length) return toast(`リポジトリ名が読めません：${bad[0]}`);
    put("categories", c.id, { ...strip(c), purpose: $("#d-purpose").value.trim(), deadline: $("#d-deadline").value, repos });
    toast("保存しました"); return;
  }
  if (t.dataset.msToggle) {
    put("categories", c.id, { ...strip(c), milestones: (c.milestones || []).map((m) => (m.id === t.dataset.msToggle ? { ...m, done: t.checked } : m)) });
    return;
  }
  if (t.dataset.msDel) { put("categories", c.id, { ...strip(c), milestones: (c.milestones || []).filter((m) => m.id !== t.dataset.msDel) }); return; }

  // 週次まとめ
  if (t.dataset.week) { S.week = t.dataset.week === "0" ? today() : shiftDate(S.week, +t.dataset.week); render(); return; }
  if (t.id === "sum-copy-prompt") {
    try { await navigator.clipboard.writeText(buildPrompt(weekData())); toast("依頼文をコピーしました。claude.ai に貼り付けてください"); }
    catch { $("#sum-text").value = buildPrompt(weekData()); toast("コピーできなかったため、下の欄に依頼文を入れました"); }
    return;
  }
  if (t.id === "sum-gen") {
    S.summary.busy = true; S.summary.err = ""; render();
    try { S.summary.text = await callClaude(buildPrompt(weekData()), { key: S.settings.anthropicKey, model: S.settings.model }); }
    catch (e) { S.summary.err = e.message; }
    S.summary.busy = false;
    const ta = $("#sum-text");
    lastKey = ""; // 生成結果で入力欄を上書きする
    render();
    if (ta && !S.summary.err) toast("下書きを作成しました。直してから保存できます");
    return;
  }
  if (t.id === "sum-copy") { try { await navigator.clipboard.writeText($("#sum-text").value); toast("コピーしました"); } catch { toast("コピーできませんでした"); } return; }
  if (t.id === "sum-save") {
    const { start, end } = weekRange(S.week);
    S.summary.text = $("#sum-text").value;
    put("summaries", start, { start, end, text: S.summary.text, updatedAt: Date.now() });
    toast("保存しました"); return;
  }

  // 設定
  if (t.id === "s-save") {
    S.settings = { githubToken: $("#s-gh").value.trim(), anthropicKey: $("#s-ak").value.trim(), model: $("#s-model").value.trim() || DEFAULT_MODEL };
    saveSettings(); S.gh.key = ""; toast("設定を保存しました"); return;
  }
  if (t.id === "exp-md") { exportMd(); return; }
  if (t.id === "exp-json") { exportJson(); return; }
});

document.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const c = cat();
  if (ev.target.id === "addcat") {
    const n = $("#newcat").value.trim();
    if (!n) return;
    const id = uid();
    $("#newcat").value = "";
    put("categories", id, { name: n, purpose: "", deadline: "", repos: [], milestones: [], createdAt: Date.now() });
    S.view = "cat"; S.sel = id; S.showDetail = true; S.editing = null; S.draft = null;
    render(); return;
  }
  if (ev.target.id === "ms-add") {
    const title = $("#ms-title").value.trim();
    if (!title) return;
    const due = $("#ms-due").value;
    $("#ms-title").value = ""; $("#ms-due").value = "";
    const ms = [...(c.milestones || []), { id: uid(), title, due, done: false }].sort((a, b) => (a.due || "9").localeCompare(b.due || "9"));
    put("categories", c.id, { ...strip(c), milestones: ms });
    return;
  }
  if (ev.target.id === "editor") {
    const old = S.editing === "new" ? null : S.logs.find((l) => l.id === S.editing);
    const id = old ? old.id : uid();
    const d = S.draft;
    for (const a of d.att.filter((x) => x.isNew)) put("attachments", a.id, { logId: id, name: a.name, type: a.type, size: a.size, data: a.data, createdAt: Date.now() });
    for (const aid of d.removed) remove("attachments", aid);
    const body = {
      categoryId: c.id,
      date: $("#e-date").value || today(),
      partId: $("#e-part").value,
      title: $("#e-title").value.trim(),
      work: $("#e-work").value.trim(),
      reason: $("#e-reason").value.trim(),
      result: $("#e-result").value.trim(),
      lang: $("#e-lang").value.trim(),
      code: $("#e-code").value.replace(/\s+$/, ""),
      links: $("#e-links").value.split("\n").map((s) => s.trim()).filter(Boolean),
      commits: d.commits.map(({ repo, sha, message, url, date }) => ({ repo, sha, message, url, date })),
      attach: d.att.map(({ id, name, type, size, thumb }) => ({ id, name, type, size, thumb })),
      createdAt: old?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    if (JSON.stringify(body).length > 900_000) return toast("1件の記録が大きすぎます。コード断片を短くしてください");
    S.editing = null; S.draft = null;
    put("logs", id, body);
    toast("記録しました");
    render();
  }
});

let qT;
document.addEventListener("input", (ev) => {
  if (ev.target.id === "q") { clearTimeout(qT); qT = setTimeout(() => { S.q = ev.target.value; render(); }, 250); }
});
document.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.id === "e-date") { render(); loadCommits(); }
  if (t.id === "e-file") { addFiles([...t.files]); t.value = ""; }
  if (t.id === "imp-json" && t.files[0]) { importJson(t.files[0]); t.value = ""; }
});
document.addEventListener("paste", (ev) => {
  if (!S.draft) return;
  const files = [...(ev.clipboardData?.files || [])];
  if (files.length) { ev.preventDefault(); addFiles(files); }
});
document.addEventListener("dragover", (ev) => {
  const d = ev.target.closest?.("#drop");
  if (d) { ev.preventDefault(); d.classList.add("over"); }
});
document.addEventListener("dragleave", (ev) => ev.target.closest?.("#drop")?.classList.remove("over"));
document.addEventListener("drop", (ev) => {
  const d = ev.target.closest?.("#drop");
  if (!d) return;
  ev.preventDefault();
  d.classList.remove("over");
  addFiles([...ev.dataTransfer.files]);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") $("#lightbox").hidden = true;
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter" && S.draft) { ev.preventDefault(); $("#editor")?.requestSubmit(); }
});

/* ================= boot ================= */
(async () => {
  try { S.store = await createStore(); }
  catch (e) { console.error(e); $("#root").innerHTML = `<div class="login"><div class="panel"><p class="err">Firebaseを読み込めませんでした。js/config.js の値と通信状況を確認してください。</p></div></div>`; return; }
  S.store.onAuth(async (user) => {
    S.unsub.forEach((f) => f()); S.unsub = [];
    if (user && ALLOWED_EMAIL && user.email !== ALLOWED_EMAIL) {
      await S.store.signOut();
      return renderLogin("このアカウントでは使えません。");
    }
    S.user = user;
    if (!user) { S.cats = []; S.logs = []; S.summaries = []; return renderLogin(); }
    const onErr = (e) => { console.error(e); toast(e?.code === "permission-denied" ? "読み込みが拒否されました。firestore.rules を確認してください" : "同期が切れました。再読み込みしてください"); };
    let first = 0;
    const sub = (c, setter) => S.unsub.push(S.store.subscribe(c, (docs) => {
      setter(docs);
      if (first < 3 && ++first === 3 && !S.sel && S.cats.length) S.sel = sortedCats()[0].id;
      render();
    }, onErr));
    sub("categories", (d) => (S.cats = d));
    sub("logs", (d) => (S.logs = d));
    sub("summaries", (d) => (S.summaries = d));
    render();
  });
})();
