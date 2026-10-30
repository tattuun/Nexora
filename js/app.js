import { createStore, isDemo } from "./store.js";
import { ALLOWED_EMAIL } from "./config.js";
import { parseRepo, parseCommitUrl, commitsOn, commitInfo, githubFileUrl, listRepoFiles, fetchRepoFile } from "./github.js";
import { renderMarkdown, cachedMarkdown, docxToHtml, docxToMarkdown, fileKind, mimeOf, saveUpload, loadUpload, removeUpload } from "./docs.js";
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
  cats: [], logs: [], summaries: [], docs: [],
  view: "home", sel: null, showDetail: false, editing: null, q: "",
  draft: null,              // 編集中の記録の付属情報 {commits, att, removed}
  gh: { key: "", loading: false, list: [], errors: [] },
  week: today(), summary: { text: "", busy: false, err: "", loadedFor: "" },
  settings: loadSettings(),
  unsub: [],
  syncError: "",
  flowEdit: false, flowOverride: null,
  openLogs: new Set(),      // 詳細を開いている記録
};

/* ================= storage helpers ================= */
const DENIED_MSG = "Firestoreに読み書きを拒否されています。追加しても保存・表示されません。Firebaseの「Firestore → ルール」が公開済みか、ルール内のUIDが「設定・バックアップ」に表示されるUIDと一字一句同じかを確認してください。";
function fail(e) {
  console.error(e);
  const c = e?.code || "";
  if (c === "permission-denied") { S.syncError = DENIED_MSG; render(); }
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
  v.innerHTML = (S.syncError ? `<div class="banner err-banner" role="alert">${esc(S.syncError)}</div>` : "") + (S.view === "home" ? viewHome() : S.view === "week" ? viewWeek() : S.view === "settings" ? viewSettings() : S.view === "help" ? viewHelp() : viewCat());
  hydrateMarkdown();

  for (const [id, val] of Object.entries(draftVals)) { const el = document.getElementById(id); if (el) el.value = val; }
  openDetails.forEach((id) => { const d = document.getElementById(id); if (d) d.open = true; });
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el?.focus) { el.focus(); if (el.setSelectionRange && /text|search|url|password|textarea/.test(el.type)) try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
  }
}

function renderLogin(err = "") {
  $("#root").innerHTML = `<div class="login"><div class="panel">
    <h1>Nexora</h1>
    <p class="muted" style="margin:0">研究開発支援システム。日々の作業と、その理由を残すための研究ログです。</p>
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
    <button class="brand" data-view="home" type="button" title="ホームに戻る">Nexora<small>研究開発支援システム</small></button>
    <form class="addcat" id="addcat"><input type="text" id="newcat" placeholder="＋ カテゴリ追加" aria-label="新しいカテゴリ名" maxlength="40"><button class="btn sm" type="submit">追加</button></form>
    <div><div class="lbl" style="margin-bottom:6px">カテゴリ</div><ul class="cats">${items}</ul></div>
    <ul class="nav">
      <li><button class="navbtn" data-view="home" aria-current="${S.view === "home"}" type="button">ホーム</button></li>
      <li><button class="navbtn" data-view="week" aria-current="${S.view === "week"}" type="button">週次まとめ</button></li>
      <li><button class="navbtn" data-view="settings" aria-current="${S.view === "settings"}" type="button">設定・バックアップ</button></li>
      <li><button class="navbtn" data-view="help" aria-current="${S.view === "help"}" type="button">使い方</button></li>
    </ul>
    <div class="side-foot">${isDemo ? "デモモード（このブラウザにだけ保存）" : `${esc(S.user.email)}<br>自動保存オン`}</div>`;
}

/* ================= view: home ================= */
function viewHome() {
  const banner = isDemo ? `<div class="banner">デモモードです。js/config.js にFirebaseの設定を入れると、ログインして全端末で同期できます。</div>` : "";
  const d = new Date();
  const head = `${banner}<div class="head"><div><h1>ホーム</h1><div class="purpose">${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）</div></div><div class="actions"><button class="btn" data-view="week" type="button">週次まとめ</button></div></div>`;
  if (!S.cats.length) return head + `<div class="empty">左上の「＋ カテゴリ追加」で研究テーマ（例：卒研、ドローン）を作ると始められます。</div>`;
  const dues = [];
  for (const c of S.cats) {
    for (const m of c.milestones || []) if (!m.done && m.due) dues.push({ cat: c, label: m.title, due: m.due });
    if (c.deadline) dues.push({ cat: c, label: "最終期限", due: c.deadline });
  }
  dues.sort((a, b) => a.due.localeCompare(b.due));
  const recent = [...S.logs].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);
  const catName = (id) => S.cats.find((c) => c.id === id)?.name || "（削除済み）";
  return `${head}
  ${viewThemes()}
  <section class="panel"><h2>近い期限</h2>${dues.length ? `<ul class="hlist">${dues.slice(0, 6).map((x) => { const n = dayDiff(x.due); return `<li><button type="button" data-cat="${esc(x.cat.id)}"><span class="days ${dueCls(n)}">${dueTxt(n)}</span><span class="t">${esc(x.label)}</span><span class="c">${esc(x.cat.name)}</span></button></li>`; }).join("")}</ul>` : `<p class="muted" style="margin:0">期限はまだありません。各カテゴリの「詳細」でロードマップを作ると、ここに並びます。</p>`}</section>
  <section class="panel"><h2>最近の記録</h2>${recent.length ? `<ul class="hlist">${recent.map((l) => `<li><button type="button" data-cat="${esc(l.categoryId)}"><span class="d">${esc((l.date || "").slice(5).replace("-", "/"))}</span><span class="t">${esc(l.title)}</span><span class="c">${esc(catName(l.categoryId))}</span></button></li>`).join("")}</ul>` : `<p class="muted" style="margin:0">まだ記録がありません。カテゴリを選んで「＋ 追加」から始めましょう。</p>`}</section>`;
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
  ${viewOutputs(c)}
  ${S.showDetail ? viewDetail(c) : ""}
  ${S.editing ? viewEditor(c) : ""}
  <div class="tools"><input type="search" id="q" placeholder="このカテゴリの記録を検索（作業・理由・コード・コミット）" value="${esc(S.q)}" aria-label="検索"><span class="lbl">${logs.length}件</span>${logs.length && !S.q ? `<button class="btn sm" id="tg-all" type="button">${logs.every((l) => S.openLogs.has(l.id)) ? "すべて閉じる" : "すべて開く"}</button>` : ""}</div>
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
    ${viewFlow(c)}
    <div class="actions" style="border-top:1px solid var(--line);padding-top:14px"><button class="btn danger sm" data-arm="cat" type="button">このカテゴリを削除</button></div>
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
  const open = !!S.q || S.openLogs.has(l.id);
  const meta = [commits.length ? `コミット ${commits.length}` : "", att.length ? `添付 ${att.length}` : "", l.code ? "コード" : ""].filter(Boolean);
  const head = `<button class="sum" data-log-toggle="${esc(l.id)}" aria-expanded="${open}" type="button"><span class="caret" aria-hidden="true">${open ? "▾" : "▸"}</span><h3>${esc(l.title || "（無題）")}</h3>${part ? `<span class="chip">${esc(part.title)}</span>` : ""}${!open && meta.length ? `<span class="meta">${meta.join("・")}</span>` : ""}</button>`;
  if (!open) return `<li class="entry"><div class="date"><b>${esc(m)}/${esc(d)}</b><span>${esc(y)} (${wd})</span></div><article class="card closed">${head}</article></li>`;
  return `<li class="entry"><div class="date"><b>${esc(m)}/${esc(d)}</b><span>${esc(y)} (${wd})</span></div>
  <article class="card">${head}
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
    for (const c of ["categories", "logs", "summaries", "attachments", "docs", "blobs"]) out[c] = await S.store.all(c);
    download(`research-log-${today()}.json`, JSON.stringify(out, null, 1), "application/json");
  } catch (e) { fail(e); }
}
async function importJson(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("JSONとして読めませんでした"); }
  if (data?.app !== "research-log") return toast("このシステムのバックアップファイルではありません");
  let n = 0;
  try {
    for (const c of ["categories", "logs", "summaries", "attachments", "docs", "blobs"]) {
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
  if (t.dataset.logToggle) { const id = t.dataset.logToggle; S.openLogs.has(id) ? S.openLogs.delete(id) : S.openLogs.add(id); render(); return; }
  if (t.id === "tg-all") { const ls = logsOf(S.sel); const all = ls.every((l) => S.openLogs.has(l.id)); ls.forEach((l) => (all ? S.openLogs.delete(l.id) : S.openLogs.add(l.id))); render(); return; }
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
    if (t.dataset.arm.startsWith("doc:")) {
      const d = S.docs.find((x) => x.id === t.dataset.arm.slice(4));
      if (d) { removeUpload(S.store, d.file).catch(fail); remove("docs", d.id); }
      toast("削除しました");
    } else if (t.dataset.arm === "cat") {
      for (const l of logsOf(c.id)) { for (const a of l.attach || []) remove("attachments", a.id); remove("logs", l.id); }
      for (const d of docsOf(c.id)) { removeUpload(S.store, d.file).catch(fail); remove("docs", d.id); }
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

  // 研究の流れ・資料・成果物
  if (t.id === "flow-edit") { S.flowEdit = true; S.flowOverride = null; lastKey = ""; render(); $("#d-flow")?.focus(); return; }
  if (t.id === "flow-cancel") { S.flowEdit = false; S.flowOverride = null; render(); return; }
  if (t.id === "flow-save") {
    const flow = $("#d-flow").value.replace(/\s+$/, "") + "\n";
    S.flowEdit = false; S.flowOverride = null;
    put("categories", c.id, { ...strip(c), flow });
    render(); toast("研究の流れを保存しました"); return;
  }
  if (t.dataset.docAdd) { openDocForm(t.dataset.docAdd, null); return; }
  if (t.dataset.docEdit) { const d = S.docs.find((x) => x.id === t.dataset.docEdit); if (d) openDocForm(d.section, d); return; }
  if (t.dataset.docView) { const d = S.docs.find((x) => x.id === t.dataset.docView); if (d) openViewer(d); return; }
  if (t.dataset.outOpen) { S.view = "cat"; S.sel = t.dataset.outOpen; S.editing = null; S.draft = null; render(); const b = $("#out-box"); if (b) { b.open = true; b.scrollIntoView({ block: "start" }); } return; }
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
    S.openLogs.add(id);
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
  if (t.id === "flow-import" && t.files[0]) { importFlow(t.files[0]); t.value = ""; }
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
  if (ev.key === "Escape") { $("#lightbox").hidden = true; closeModal(); }
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter" && S.draft) { ev.preventDefault(); $("#editor")?.requestSubmit(); }
});

/* ================= 研究の流れ・資料・成果物 ================= */
const KINDS = {
  output: ["発表スライド", "予稿・論文", "ポスター", "報告書", "デモ動画", "その他"],
  flow: ["ロードマップ", "進捗報告", "計画書", "メモ", "その他"],
};
const docsOf = (catId, section) => S.docs
  .filter((d) => d.categoryId === catId && (!section || d.section === section))
  .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

function viewDocList(c, section) {
  const ds = docsOf(c.id, section);
  const items = ds.map((d) => {
    const canView = d.source === "upload" || d.source === "github";
    const gh = d.source === "github" ? `<a class="btn sm" href="${esc(githubFileUrl(d.gh.repo, d.gh.path))}" target="_blank" rel="noopener">GitHub</a>` : "";
    const link = d.url ? `<a class="btn sm" href="${esc(d.url)}" target="_blank" rel="noopener">リンク</a>` : "";
    const file = d.source === "upload" ? d.file?.name : d.source === "github" ? d.gh?.path.split("/").pop() : "";
    return `<li><span class="chip">${esc(d.kind || "資料")}</span>
      <div class="dm"><b>${esc(d.title)}</b><span class="muted">${esc([d.date ? d.date.replace(/-/g, "/") : "", d.note, file].filter(Boolean).join("　"))}</span></div>
      <span class="actions">${canView ? `<button class="btn sm pri" data-doc-view="${esc(d.id)}" type="button">閲覧</button>` : ""}${gh}${link}<button class="btn sm" data-doc-edit="${esc(d.id)}" type="button">編集</button><button class="btn sm danger" data-arm="doc:${esc(d.id)}" type="button">削除</button></span></li>`;
  }).join("");
  return `${ds.length ? `<ul class="docs">${items}</ul>` : ""}
    <div><button class="btn sm" data-doc-add="${section}" type="button">＋ ${section === "output" ? "成果物" : "資料"}を追加</button></div>`;
}

function viewOutputs(c) {
  const n = docsOf(c.id, "output").length;
  return `<details class="panel outs" id="out-box"><summary><span class="h2">成果物</span><span class="lbl">${n}件</span><span class="hint">発表資料・論文などを閲覧</span></summary>
    <div class="outs-body">${n ? "" : `<p class="muted" style="margin:0">発表スライドや予稿を登録すると、ここから閲覧したりGitHubに飛んだりできます。</p>`}${viewDocList(c, "output")}</div></details>`;
}

function viewFlow(c) {
  const flow = c.flow || "";
  let body;
  if (S.flowEdit) {
    body = `<textarea class="code" id="d-flow" rows="16" spellcheck="false" placeholder="# 研究概要&#10;&#10;## 手法&#10;- …&#10;&#10;## ロードマップ&#10;- [ ] Week 1：…">${esc(S.flowOverride ?? flow)}</textarea>
      <p class="hint" style="margin:0">書き方：<code># 見出し</code>　<code>- 箇条書き</code>　<code>- [ ] やること</code>　<code>**太字**</code>　<code>| 表 | の | 列 |</code>　Wordを取り込むと自動でこの形に変換されます。</p>
      <div class="actions" style="justify-content:space-between"><label class="btn sm">Word・Markdownから取り込む<input type="file" id="flow-import" accept=".docx,.md,.markdown,.txt" hidden></label><span class="actions"><button class="btn sm" id="flow-cancel" type="button">キャンセル</button><button class="btn pri sm" id="flow-save" type="button">研究の流れを保存</button></span></div>`;
  } else if (flow.trim()) {
    body = `<div class="md flow" data-md-cat="${esc(c.id)}">${cachedMarkdown(flow) ?? `<p class="muted">表示を準備中…</p>`}</div>
      <div class="actions"><button class="btn sm" id="flow-edit" type="button">研究の流れを編集</button></div>`;
  } else {
    body = `<p class="muted" style="margin:0">まだありません。Wordの研究ロードマップなどを取り込むと、見出しや表つきでここに表示されます。</p>
      <div class="actions"><button class="btn sm" id="flow-edit" type="button">書く・Wordから取り込む</button></div>`;
  }
  return `<div class="flow-sec">
    <div class="fld"><span>研究の流れ <em>（概要・手法・計画など。目的欄が「簡略版」、ここが「詳しい版」です）</em></span></div>
    ${body}
    <div class="fld" style="margin-top:6px"><span>関連資料 <em>（Word・PDFをそのまま閲覧）</em></span></div>
    ${viewDocList(c, "flow")}
  </div>`;
}

function viewThemes() {
  const cs = sortedCats();
  if (!cs.length) return "";
  return `<section class="panel"><h2>研究テーマ</h2><ul class="themes">${cs.map((c) => {
    const ms = c.milestones || [];
    const done = ms.filter((m) => m.done).length;
    const outs = docsOf(c.id, "output").length;
    return `<li><button type="button" data-cat="${esc(c.id)}" class="theme"><b>${esc(c.name)}</b><span class="p">${c.purpose ? esc(c.purpose) : `<span class="muted">目的は「詳細」で設定できます</span>`}</span>
      ${ms.length ? `<span class="progress" aria-hidden="true"><i style="width:${Math.round((done / ms.length) * 100)}%"></i></span><span class="muted">ロードマップ ${done}/${ms.length}</span>` : ""}</button>
      ${outs ? `<button type="button" class="btn sm" data-out-open="${esc(c.id)}">成果物 ${outs}件</button>` : ""}</li>`;
  }).join("")}</ul></section>`;
}

function hydrateMarkdown() {
  document.querySelectorAll("[data-md-cat]").forEach((el) => {
    const c = S.cats.find((x) => x.id === el.dataset.mdCat);
    if (!c?.flow || cachedMarkdown(c.flow)) return;
    renderMarkdown(c.flow).then((html) => { if (el.isConnected) el.innerHTML = html; })
      .catch((e) => { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; });
  });
}

async function importFlow(file) {
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "doc") return toast("古い形式の .doc は読めません。Wordで .docx として保存し直してください");
  toast("取り込み中…");
  try {
    const md = ext === "docx" ? await docxToMarkdown(await file.arrayBuffer()) : await file.text();
    const cur = $("#d-flow")?.value.trim();
    S.flowOverride = cur ? `${cur}\n\n${md}` : md;
    S.flowEdit = true;
    lastKey = ""; // 取り込んだ内容で入力欄を上書きする
    render();
    toast(cur ? "末尾に取り込みました。確認して保存してください" : "取り込みました。確認して保存してください");
  } catch (e) {
    console.error(e);
    toast("取り込めませんでした。ファイルが壊れていないか確認してください");
  }
}

/* ---------- モーダル（資料の登録・閲覧） ---------- */
let modalUrl = null;
function showModal(html, wide) {
  const m = $("#modal");
  $("#modal-box").className = "modal-box" + (wide ? " wide" : "");
  $("#modal-box").innerHTML = html;
  m.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeModal() {
  if ($("#modal").hidden) return;
  $("#modal").hidden = true;
  $("#modal-box").innerHTML = "";
  document.body.style.overflow = "";
  if (modalUrl) { URL.revokeObjectURL(modalUrl); modalUrl = null; }
}

let docForm = null; // { section, doc, catId }
function openDocForm(section, doc) {
  const c = cat();
  docForm = { section, doc, catId: c.id };
  const d = doc || { kind: KINDS[section][0], date: today(), source: (c.repos || []).length ? "github" : "upload" };
  const repos = c.repos || [];
  const label = section === "output" ? "成果物" : "資料";
  showModal(`<form id="doc-form" class="mform">
    <div class="mhead"><b>${doc ? `${label}を編集` : `${label}を追加`}</b><button class="x" data-modal-close type="button" aria-label="閉じる">×</button></div>
    <div class="mbody pad">
      <label class="fld"><span>タイトル</span><input type="text" id="df-title" value="${esc(d.title)}" required maxlength="120" placeholder="${section === "output" ? "例：電気関係学会東北支部連合大会 発表スライド" : "例：研究ロードマップ（シンポジウムまで）"}"></label>
      <div class="row">
        <label class="fld"><span>種類</span><select id="df-kind">${KINDS[section].map((k) => `<option ${d.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <label class="fld"><span>日付</span><input type="date" id="df-date" value="${esc(d.date)}"></label>
      </div>
      <label class="fld"><span>場所・メモ <em>（任意）</em></span><input type="text" id="df-note" value="${esc(d.note)}" placeholder="例：2026年度 電気関係学会東北支部連合大会"></label>
      <fieldset class="src"><legend>ファイルの置き場所</legend>
        <label><input type="radio" name="df-src" value="github" ${d.source === "github" ? "checked" : ""} ${repos.length ? "" : "disabled"}> GitHubのファイル${repos.length ? "" : "（詳細でリポジトリ登録が必要）"}</label>
        <label><input type="radio" name="df-src" value="upload" ${d.source === "upload" ? "checked" : ""}> Nexoraにアップロード（15MBまで）</label>
        <label><input type="radio" name="df-src" value="link" ${d.source === "link" ? "checked" : ""}> リンクだけ（Google Drive等）</label>
      </fieldset>
      <div class="srcbox" data-src="github">
        <div class="row">
          <label class="fld"><span>リポジトリ</span><select id="df-repo">${repos.map((r) => `<option ${d.gh?.repo === r ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
          <div class="fld"><span>&nbsp;</span><button class="btn sm" id="df-list" type="button">ファイル一覧を読み込む</button></div>
        </div>
        <label class="fld"><span>ファイルのパス</span><input type="text" id="df-path" list="df-paths" value="${esc(d.gh?.path)}" placeholder="例：docs/symposium_slides.pdf"><datalist id="df-paths"></datalist></label>
        <p class="hint" id="df-list-msg" style="margin:0">PDF・Word・画像・Markdown・PowerPointを一覧に出します。PowerPointは閲覧できないので、PDF版も一緒にコミットしておくのがおすすめです。</p>
      </div>
      <div class="srcbox" data-src="upload">
        <label class="fld"><span>ファイル ${d.file ? `<em>（現在：${esc(d.file.name)}。選ぶと差し替え）</em>` : ""}</span><input type="file" id="df-file" accept=".pdf,.docx,.pptx,.md,.txt,.png,.jpg,.jpeg,.gif,.webp"></label>
      </div>
      <label class="fld"><span>関連リンク <em>${d.source === "link" ? "" : "（任意）"}</em></span><input type="url" id="df-url" value="${esc(d.url)}" placeholder="https://…"></label>
      <p class="err" id="df-err" style="margin:0" hidden></p>
    </div>
    <div class="mfoot"><button class="btn" data-modal-close type="button">キャンセル</button><button class="btn pri" id="df-save" type="submit">保存</button></div>
  </form>`);
  syncSrcBoxes();
  $("#df-title").focus();
}
function syncSrcBoxes() {
  const v = document.querySelector('input[name="df-src"]:checked')?.value;
  document.querySelectorAll(".srcbox").forEach((b) => (b.hidden = b.dataset.src !== v));
}
async function loadRepoList() {
  const repo = $("#df-repo").value;
  const msg = $("#df-list-msg");
  msg.textContent = "読み込み中…";
  try {
    const files = await listRepoFiles(repo, S.settings.githubToken);
    $("#df-paths").innerHTML = files.map((f) => `<option value="${esc(f.path)}">${kb(f.size)}</option>`).join("");
    msg.textContent = files.length ? `${files.length}件見つかりました。パスの欄をクリックすると候補が出ます。` : "資料らしいファイルが見つかりません。先にVS Codeでコミット＆同期してください。";
    $("#df-path").focus();
  } catch (e) { msg.textContent = e.message; }
}
async function saveDocForm() {
  const f = docForm;
  const err = $("#df-err");
  const showErr = (m) => { err.textContent = m; err.hidden = false; };
  const src = document.querySelector('input[name="df-src"]:checked')?.value;
  const old = f.doc;
  const body = {
    categoryId: f.catId, section: f.section,
    title: $("#df-title").value.trim(), kind: $("#df-kind").value, date: $("#df-date").value,
    note: $("#df-note").value.trim(), url: $("#df-url").value.trim(), source: src,
    createdAt: old?.createdAt || Date.now(), updatedAt: Date.now(),
  };
  if (!body.title) return showErr("タイトルを入れてください");
  const id = old?.id || uid();
  const fileInput = $("#df-file");
  if (src === "github") {
    const path = $("#df-path").value.trim().replace(/^\/+/, "");
    if (!path) return showErr("ファイルのパスを入れてください（「ファイル一覧を読み込む」で候補が出ます）");
    body.gh = { repo: $("#df-repo").value, path };
  } else if (src === "upload") {
    if (!fileInput.files[0] && !old?.file) return showErr("ファイルを選んでください");
  } else if (!body.url) return showErr("リンクのURLを入れてください");

  const btn = $("#df-save");
  btn.disabled = true;
  try {
    if (src === "upload" && fileInput.files[0]) {
      btn.textContent = "アップロード中…";
      const fileId = uid();
      body.file = await saveUpload(S.store, fileInput.files[0], fileId);
      if (old?.file) removeUpload(S.store, old.file).catch(fail);
    } else if (src === "upload") body.file = old.file;
    else if (old?.file) removeUpload(S.store, old.file).catch(fail);
  } catch (e) {
    btn.disabled = false; btn.textContent = "保存";
    return showErr(e.message?.includes("MB") ? e.message : "アップロードに失敗しました。通信状況を確認してください");
  }
  put("docs", id, body);
  closeModal();
  toast("保存しました");
}

async function openViewer(d) {
  const ghUrl = d.source === "github" ? githubFileUrl(d.gh.repo, d.gh.path) : "";
  const name = d.source === "upload" ? d.file.name : d.gh.path.split("/").pop();
  showModal(`<div class="mhead"><b>${esc(d.title)}</b><span class="actions">
      ${ghUrl ? `<a class="btn sm" href="${esc(ghUrl)}" target="_blank" rel="noopener">GitHubで開く</a>` : ""}
      ${d.url ? `<a class="btn sm" href="${esc(d.url)}" target="_blank" rel="noopener">リンク</a>` : ""}
      <a class="btn sm" id="mv-tab" target="_blank" rel="noopener" hidden>新しいタブで開く</a>
      <a class="btn sm" id="mv-dl" download="${esc(name)}" hidden>ダウンロード</a>
      <button class="x" data-modal-close type="button" aria-label="閉じる">×</button></span></div>
    <div class="mbody" id="mv-body"><p class="muted pad">読み込み中…</p></div>`, true);
  const body = $("#mv-body");
  try {
    let blob = d.source === "upload" ? await loadUpload(S.store, d.file) : await fetchRepoFile(d.gh.repo, d.gh.path, S.settings.githubToken);
    blob = new Blob([blob], { type: mimeOf(name, d.file?.type) });
    if ($("#modal").hidden) return;
    modalUrl = URL.createObjectURL(blob);
    for (const id of ["mv-tab", "mv-dl"]) { const a = $("#" + id); a.href = modalUrl; a.hidden = false; }
    const kind = fileKind(name, blob.type);
    if (kind === "pdf") body.innerHTML = `<iframe class="pdf" src="${modalUrl}" title="${esc(d.title)}"></iframe>`;
    else if (kind === "image") body.innerHTML = `<div class="pad center"><img src="${modalUrl}" alt="${esc(d.title)}"></div>`;
    else if (kind === "docx") body.innerHTML = `<article class="md doc pad">${await docxToHtml(await blob.arrayBuffer())}</article>`;
    else if (kind === "text") body.innerHTML = `<article class="md doc pad">${await renderMarkdown(await blob.text())}</article>`;
    else body.innerHTML = `<div class="pad"><p>${kind === "slides" ? "PowerPointはブラウザで直接表示できません。" : "この形式はプレビューできません。"}「ダウンロード」から開いてください。</p>${kind === "slides" ? `<p class="hint">PowerPointの「エクスポート → PDF」で作ったPDFも一緒に登録しておくと、Nexora上で閲覧できます。</p>` : ""}</div>`;
    $("#mv-tab").hidden = kind === "other" || kind === "slides";
  } catch (e) {
    body.innerHTML = `<p class="err pad">${esc(e.message)}</p>`;
  }
}

document.addEventListener("click", (ev) => {
  if (ev.target.id === "modal" || ev.target.closest("[data-modal-close]")) { closeModal(); return; }
  if (ev.target.id === "df-list") loadRepoList();
});
document.addEventListener("change", (ev) => { if (ev.target.name === "df-src") syncSrcBoxes(); });
document.addEventListener("submit", (ev) => { if (ev.target.id === "doc-form") { ev.preventDefault(); ev.stopImmediatePropagation(); saveDocForm(); } }, true);

/* ================= view: help ================= */
function viewHelp() {
  return `<div class="head"><div><h1>使い方</h1><div class="purpose">Nexoraは「その日、研究のどこを、どうやって、なぜ進めたか」を残すための研究ログです。</div></div></div>
  <section class="panel help">
    <h2>保管場所の役割分担</h2>
    <pre class="diagram">【GitHub】tattuun/Nexora ……… Nexoraアプリ本体
【GitHub】研究コードのリポジトリ … 例：tattuun/check-swing（コードと変更履歴）
【Firebase】Firestore ………… 日々の記録・研究の流れ・アップロードした資料</pre>
    <p>コードの「何を変えたか」はGitHubが正確に覚えます。人が書くのは「なぜそうしたか」だけ、という分担です。</p>
  </section>
  <section class="panel help">
    <h2>普段の1日の流れ</h2>
    <ol class="steps">
      <li><b>研究する</b>：VS Codeでコードを直して、動かして、結果を見ます。</li>
      <li><b>キリのいいところでGitHubに送る</b>：VS Codeの「ソース管理」で、変更内容をひとこと書いて「コミット」、続けて「変更の同期」。1日に何回やっても構いません。</li>
      <li><b>Nexoraで記録を書く</b>：カテゴリで「＋ 追加」。前回の「次にやること」が上に出ます。「この日のコミット」にチェックを付け、「なぜそうしたか」を書いて保存（Ctrl+Enterでも保存）。疲れた日は「ひとことで」だけでもOK。</li>
      <li><b>振り返る</b>：記録のコミットのリンクから、その日どの行をどう変えたかをGitHubで見られます。週末は「週次まとめ」でゼミ報告の下書きを作れます。</li>
    </ol>
  </section>
  <section class="panel help">
    <h2>画面の説明</h2>
    <dl class="kvh">
      <dt>ホーム</dt><dd>研究テーマの一覧（目的＝簡略版）、近い期限、最近の記録。左上の「Nexora」でいつでも戻れます。</dd>
      <dt>カテゴリ</dt><dd>研究テーマごとの日々の記録。検索欄で作業・理由・コード・コミットを横断検索できます。</dd>
      <dt>成果物</dt><dd>カテゴリ画面の上部。発表スライド・予稿・ポスターなどを登録し、「閲覧」でNexora内で読めます。</dd>
      <dt>詳細</dt><dd>目的・最終期限・GitHubリポジトリ・ロードマップ（マイルストーン）・研究の流れ（詳しい版）・関連資料。</dd>
      <dt>週次まとめ</dt><dd>1週間分の記録からゼミ報告の下書きを作成。「依頼文をコピー」してclaude.aiに貼れば、APIキーなしで使えます。</dd>
      <dt>設定・バックアップ</dt><dd>GitHubトークン・APIキー（端末ごとに保存）、Markdown／JSONでの書き出しと復元。</dd>
    </dl>
  </section>
  <section class="panel help">
    <h2>研究の流れ・資料・成果物</h2>
    <ul>
      <li><b>研究の流れ</b>：詳細の中。「Word・Markdownから取り込む」で、Wordのロードマップを見出し・表・チェックボックスつきの文章に変換して保存できます。取り込んだ後もここで編集できます。</li>
      <li><b>資料・成果物の置き場所</b>は3通り。
        <ul>
          <li><b>GitHubのファイル</b>（おすすめ）：研究リポジトリの <code>docs/</code> などにPDFやWordを入れてコミット＆同期 →「ファイル一覧を読み込む」で選ぶ。閲覧もGitHubへのジャンプもできます。</li>
          <li><b>Nexoraにアップロード</b>：15MBまで。Gitに入れたくない資料向け。</li>
          <li><b>リンクだけ</b>：Google Driveや学会ページなど。</li>
        </ul></li>
      <li>閲覧できるのはPDF・Word（.docx）・画像・Markdown。PowerPointはPDFに書き出したものも登録しておくと便利です。</li>
    </ul>
  </section>
  <section class="panel help">
    <h2>コミットのコツ</h2>
    <ul>
      <li>「うまく動いた」「ここで一区切り」と思ったらこまめに。コミットした時点の状態だけが履歴に残ります。</li>
      <li>メッセージは「何を変えたか」を短く。例：<code>閾値を0.6→0.5に変更</code>、<code>右打者に対応</code>。理由はNexoraに書きます。</li>
      <li>重み（.pt .engine .onnx）・動画・出力CSVは <code>.gitignore</code> で除外済み。これらはGitHubにバックアップされないので、大事な重みは別の場所にもコピーを。</li>
    </ul>
  </section>
  <section class="panel help">
    <h2>困ったとき</h2>
    <dl class="kvh">
      <dt>変更が反映されない</dt><dd>Ctrl+Shift+R で再読み込み（スマホはタブを開き直す）。</dd>
      <dt>コミットが出ない</dt><dd>VS Codeで「同期」まで済んでいるか、詳細にリポジトリを登録したか、この端末の設定にトークンを入れたかを確認。表示されるのは既定ブランチ（main）のコミットです。</dd>
      <dt>「トークンが無効」</dt><dd>有効期限切れ。GitHubで作り直して「設定・バックアップ」に入れ直します（Contents: Read-only、対象リポジトリを選択）。新しい研究リポジトリを作った時も、トークンの対象に追加が必要です。</dd>
      <dt>赤い帯が出た</dt><dd>Firestoreに拒否されています。ルールが公開済みか、UIDが一致しているかを確認。</dd>
      <dt>バックアップ</dt><dd>月に1回「JSONで全データ書き出し」を。添付・資料も含めて復元できます。</dd>
    </dl>
  </section>`;
}

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
    S.syncError = "";
    const onErr = (e) => {
      console.error(e);
      S.syncError = e?.code === "permission-denied" ? DENIED_MSG : `データとの同期が切れました（${e?.code || "不明なエラー"}）。ページを再読み込みしてください。`;
      render();
    };
    const sub = (c, setter) => S.unsub.push(S.store.subscribe(c, (docs) => {
      setter(docs);
      render();
    }, onErr));
    sub("categories", (d) => (S.cats = d));
    sub("logs", (d) => (S.logs = d));
    sub("summaries", (d) => (S.summaries = d));
    sub("docs", (d) => (S.docs = d));
    render();
  });
})();
