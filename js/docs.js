// 資料（Word / PDF / Markdown など）の保存・取得・表示
// ライブラリは js/vendor に同梱し、必要になった時だけ読み込む

const VENDOR = new URL("./vendor/", import.meta.url).href;
const LIBS = {
  marked: "marked-15.0.12.umd.js",
  purify: "purify-3.2.6.min.js",
  mammoth: "mammoth-1.9.1.browser.min.js",
  turndown: "turndown-7.2.0.umd.js",
  gfm: "turndown-plugin-gfm-1.0.2.js",
};
const loaded = {};
function loadScript(name) {
  return (loaded[name] ??= new Promise((ok, ng) => {
    const s = document.createElement("script");
    s.src = VENDOR + LIBS[name];
    s.onload = ok;
    s.onerror = () => { delete loaded[name]; ng(new Error("表示用の部品を読み込めませんでした")); };
    document.head.appendChild(s);
  }));
}
async function sanitizer() {
  await loadScript("purify");
  const P = window.DOMPurify;
  if (!P.__nexora) {
    P.addHook("afterSanitizeAttributes", (n) => {
      if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener"); }
    });
    P.__nexora = true;
  }
  return (html) => P.sanitize(html);
}

/* ---------- Markdown ---------- */
const mdCache = new Map();
export const cachedMarkdown = (md) => mdCache.get(md);
export async function renderMarkdown(md) {
  if (mdCache.has(md)) return mdCache.get(md);
  await loadScript("marked");
  const clean = await sanitizer();
  const html = clean(window.marked.parse(String(md || ""), { gfm: true, breaks: true }));
  mdCache.set(md, html);
  return html;
}

/* ---------- Word ---------- */
export async function docxToHtml(buf) {
  await loadScript("mammoth");
  const clean = await sanitizer();
  const r = await window.mammoth.convertToHtml({ arrayBuffer: buf });
  return clean(r.value);
}
export async function docxToMarkdown(buf) {
  await Promise.all([loadScript("mammoth"), loadScript("turndown")]);
  await loadScript("gfm");
  const r = await window.mammoth.convertToHtml({ arrayBuffer: buf });
  // Word の表は見出し行が無いので、1行目を見出しとして扱う（Markdown の表にするため）
  const doc = new DOMParser().parseFromString(`<div id="x">${r.value}</div>`, "text/html");
  doc.querySelectorAll("table").forEach((t) => {
    const first = t.querySelector("tr");
    first?.querySelectorAll("td").forEach((td) => {
      const th = doc.createElement("th");
      th.innerHTML = td.innerHTML;
      td.replaceWith(th);
    });
    // セル内の段落は1行にまとめる
    t.querySelectorAll("td p, th p").forEach((p) => p.replaceWith(doc.createTextNode(p.textContent + " ")));
  });
  const td = new window.TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "*" });
  td.use(window.turndownPluginGfm.gfm);
  let md = td.turndown(doc.getElementById("x").innerHTML);
  md = md
    .replace(/^(\s*-\s+)(?:\\\[\s?\\\]|☐|□)\s*/gm, "$1[ ] ")       // [ ] / ☐ チェックボックス
    .replace(/^(\s*-\s+)(?:\\\[[xX✓]\\\]|☑|☒|✅)\s*/gm, "$1[x] ")
    .replace(/^(\s*-)\s{2,}/gm, "$1 ")
    .replace(/\n{3,}/g, "\n\n");
  return md.trim() + "\n";
}

/* ---------- ファイル種別 ---------- */
export function fileKind(name = "", type = "") {
  const ext = name.toLowerCase().split(".").pop();
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (["md", "markdown", "txt"].includes(ext)) return "text";
  if (/^image\//.test(type) || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["pptx", "ppt", "key"].includes(ext)) return "slides";
  return "other";
}
const MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", md: "text/markdown", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
export const mimeOf = (name, fallback = "") => fallback || MIME[name.toLowerCase().split(".").pop()] || "application/octet-stream";

/* ---------- アップロード（Firestore に分割保存） ---------- */
export const MAX_UPLOAD = 15 * 1024 * 1024;
const CHUNK = 700_000; // base64 文字数。Firestore の1文書1MB制限に収める

const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

export async function saveUpload(store, file, id) {
  if (file.size > MAX_UPLOAD) throw new Error(`${file.name}：${(file.size / 1048576).toFixed(1)}MBあります。15MBまでです。大きいファイルはGitHubに置いて「GitHubのファイル」で登録してください`);
  const b64 = toBase64(await file.arrayBuffer());
  const n = Math.ceil(b64.length / CHUNK) || 1;
  for (let i = 0; i < n; i++) {
    await store.put("blobs", `${id}_${i}`, { fileId: id, i, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
  }
  return { id, name: file.name, type: mimeOf(file.name, file.type), size: file.size, chunks: n };
}
export async function loadUpload(store, meta) {
  const parts = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => store.get("blobs", `${meta.id}_${i}`)));
  if (parts.some((p) => !p)) throw new Error("ファイルの一部が見つかりません。保存が途中で止まった可能性があります");
  return new Blob([fromBase64(parts.map((p) => p.data).join(""))], { type: meta.type });
}
export async function removeUpload(store, meta) {
  for (let i = 0; i < (meta?.chunks || 0); i++) await store.remove("blobs", `${meta.id}_${i}`);
}

/* ---------- PDF（スマホ向け：PDF.js で全ページを描画） ---------- */
// iPhone の Safari は埋め込みPDFの1ページ目しか表示しないため、スマホでは PDF.js を使う
const PDFJS = VENDOR + "pdfjs-5.4.394/";
// 埋め込まれていない日本語フォント等が必要なPDFのときだけ、CDNから補助データを取りに行く
const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.394/";
let pdfjsP = null;
function pdfjs() {
  return (pdfjsP ??= import(PDFJS + "pdf.min.mjs").then((m) => {
    m.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
    return m;
  }).catch((e) => { pdfjsP = null; throw e; }));
}

export const isMobile = () =>
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ||
  matchMedia("(pointer: coarse)").matches;

// container に全ページを並べる。見えているページだけ描画し、遠いページは解放してメモリを抑える
export async function renderPdf(container, buf) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: PDFJS_CDN + "cmaps/", cMapPacked: true,
    standardFontDataUrl: PDFJS_CDN + "standard_fonts/",
    isEvalSupported: false,
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    pages.push({ p, w: vp.width, h: vp.height });
  }
  let zoom = 1;
  container.innerHTML = "";
  container.classList.add("pdfjs");
  const wraps = pages.map((pg, i) => {
    const el = document.createElement("div");
    el.className = "pdfpage";
    el.dataset.i = i;
    el.style.aspectRatio = `${pg.w} / ${pg.h}`;
    container.appendChild(el);
    return el;
  });
  const layout = () => wraps.forEach((el) => (el.style.width = `calc(${zoom * 100}% - 20px)`));
  layout();

  const tasks = new Map();
  async function draw(i) {
    const el = wraps[i];
    if (el.dataset.drawn === String(zoom) || tasks.has(i)) return;
    const pg = pages[i];
    const cssW = el.clientWidth || container.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // iPhone のキャンバス上限（約1600万画素）を超えないように抑える
    const scale = Math.min((cssW * dpr) / pg.w, Math.sqrt(12e6 / (pg.w * pg.h)));
    const vp = pg.p.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = pg.p.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: vp });
    tasks.set(i, task);
    try {
      await task.promise;
      el.replaceChildren(canvas);
      el.dataset.drawn = String(zoom);
    } catch { /* キャンセル */ } finally { tasks.delete(i); }
  }
  function release(i) {
    tasks.get(i)?.cancel();
    const c = wraps[i].querySelector("canvas");
    if (c) { c.width = 0; c.height = 0; wraps[i].replaceChildren(); }
    delete wraps[i].dataset.drawn;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = +e.target.dataset.i;
      e.isIntersecting ? draw(i) : release(i);
    }
  }, { root: container.closest(".mbody") || null, rootMargin: "1200px 0px" });
  wraps.forEach((el) => io.observe(el));

  return {
    pages: doc.numPages,
    setZoom(z) {
      zoom = z;
      layout();
      wraps.forEach((el, i) => { if (el.dataset.drawn) { delete el.dataset.drawn; draw(i); } });
    },
    destroy() { io.disconnect(); tasks.forEach((t) => t.cancel()); doc.destroy(); },
  };
}
