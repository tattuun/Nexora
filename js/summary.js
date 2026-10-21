// 週次まとめ：プロンプト生成と Claude API 呼び出し
export const DEFAULT_MODEL = "claude-sonnet-5-5";

const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 月曜始まりの週
export function weekRange(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  const mon = new Date(y, m - 1, d - ((base.getDay() + 6) % 7));
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return { start: ymd(mon), end: ymd(sun) };
}

export function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + days));
}

export function buildPrompt({ start, end, cats, logs }) {
  const lines = [];
  lines.push(`以下は ${start}〜${end} の1週間分の研究ログです。研究室のゼミ（週次の進捗報告）で話すための下書きを、日本語で作ってください。`);
  lines.push("");
  lines.push("# 出力形式");
  lines.push("## 今週の進捗（テーマ別）");
  lines.push("## 判断とその理由（なぜその方法を選んだか）");
  lines.push("## 結果・わかったこと");
  lines.push("## 課題・相談したいこと");
  lines.push("## 来週の予定");
  lines.push("");
  lines.push("# ルール");
  lines.push("- ログに書かれていない事実・数値は作らない。足りない情報は「（要確認）」と書く");
  lines.push("- 箇条書き中心。1テーマあたり3〜5行程度");
  lines.push("- 「来週の予定」は各ログの「結果・次にやること」とロードマップの期限を優先して組み立てる");
  lines.push("");
  lines.push("# ログ");
  for (const c of cats) {
    const ls = logs.filter((l) => l.categoryId === c.id).sort((a, b) => a.date.localeCompare(b.date));
    if (!ls.length) continue;
    const open = (c.milestones || []).filter((m) => !m.done);
    lines.push("");
    lines.push(`## テーマ：${c.name}`);
    if (c.purpose) lines.push(`目的：${c.purpose}`);
    if (c.deadline) lines.push(`最終期限：${c.deadline}`);
    if (open.length) lines.push(`未完了のマイルストーン：${open.map((m) => m.title + (m.due ? `（${m.due}まで）` : "")).join("、")}`);
    for (const l of ls) {
      const part = (c.milestones || []).find((m) => m.id === l.partId);
      lines.push(`- ${l.date} ${l.title}${part ? ` ［${part.title}］` : ""}`);
      if (l.work) lines.push(`  作業：${l.work.replace(/\n/g, " / ")}`);
      if (l.reason) lines.push(`  理由：${l.reason.replace(/\n/g, " / ")}`);
      if (l.result) lines.push(`  結果・次：${l.result.replace(/\n/g, " / ")}`);
      for (const k of l.commits || []) lines.push(`  コミット：${k.repo}@${k.sha.slice(0, 7)} ${k.message}`);
    }
  }
  return lines.join("\n");
}

export async function callClaude(prompt, { key, model }) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: model || DEFAULT_MODEL, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    });
  } catch {
    throw new Error("Claude APIに接続できません。通信状況を確認してください");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error("APIキーが無効です。設定で入れ直してください");
    if (res.status === 429) throw new Error("利用回数の上限です。少し待ってから試してください");
    if (res.status === 404) throw new Error("モデル名が見つかりません。設定のモデル名を確認してください");
    throw new Error(body?.error?.message || `Claude APIエラー（${res.status}）`);
  }
  return (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}
