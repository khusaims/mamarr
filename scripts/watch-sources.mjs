#!/usr/bin/env node
/**
 * مراقب التغيّر — يعيد جلب كل مصدر يستشهد به الموقع، ويقارن ما نشرناه بما يقوله المصدر اليوم.
 *
 * المبدأ: الآلة تلاحظ، وأنت تحكم. السكربت لا يعدّل بيانات الموقع أبدًا — يفتح تذكرة
 * تقول بالضبط ما اختفى من الصفحة، وأنت تقرر ما الرقم الجديد.
 *
 * قائمة المراقبة تُبنى من ملفات البيانات نفسها (freetime.json و advisories.json)،
 * فلا يوجد مكان ثانٍ تحدّثه: أضف مصدرًا إلى البيانات وهو يُراقَب تلقائيًا.
 *
 * ما يستطيع وما لا يستطيع:
 *   - المبالغ (١٠٠ فأكثر) تُبحَث نصًّا في الصفحة. اختفاء مبلغ = إشارة قوية أن الرقم تغيّر.
 *   - الأعداد الصغيرة (٣ أيام، ٧ أيام) شائعة جدًا في أي صفحة، فلا تُبحَث. يكتفي السكربت
 *     بالإبلاغ أن نص الصفحة تغيّر، وهي إشارة ضعيفة تستحق نظرة لا أكثر.
 *
 * التشغيل محليًا:  node scripts/watch-sources.mjs --dry
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const DRY = process.argv.includes("--dry");
const STATE_FILE = ".watch-state.json";
const UA = "MamarrSourceWatcher/1.0 (+https://mamarr.com)";
const TIMEOUT_MS = 25000;

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** يبني قائمة المراقبة من ملفات البيانات: رابط واحد لكل مصدر، ومعه المبالغ المنشورة عنه. */
function buildTargets() {
  const byUrl = new Map();
  const add = (url, name, label, tokens = []) => {
    if (!url || !/^https?:\/\//.test(url)) return;
    const t = byUrl.get(url) || { url, name, labels: new Set(), tokens: new Set() };
    t.labels.add(label);
    tokens.filter((n) => typeof n === "number" && n >= 100).forEach((n) => t.tokens.add(String(n)));
    byUrl.set(url, t);
  };

  const ft = read("src/_data/freetime.json");
  for (const e of ft.entries) {
    add(e.carrier?.source, e.carrier?.sourceName, `الأيام المجانية — ${e.port}`);
    add(e.terminal?.source, e.terminal?.sourceName, `ساعة المحطة — ${e.port}`);
  }

  const ad = read("src/_data/advisories.json");
  const money = [...(ad.dropoff || []), ...(ad.pickup || [])]
    .flatMap((r) => [r.d20, r.d40, r.reefer]);
  add(ad.carrier?.source, ad.carrier?.sourceName, "إشعارات الناقلين — الإشعار الأصلي", money);
  add(ad.carrier?.latest, ad.carrier?.latestName, "إشعارات الناقلين — آخر تحديث", money);

  return [...byUrl.values()].map((t) => ({ ...t, labels: [...t.labels], tokens: [...t.tokens] }));
}

/** نص الصفحة بلا وسوم، بأرقام بلا فواصل، حتى تتطابق «1,200» مع «1200». */
function normalize(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.replace(/(\d)[,٬’'](?=\d{3}\b)/g, "$1");
}

async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,*/*" }, signal: ctl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { text: normalize(await res.text()) };
  } catch (err) {
    return { error: err.name === "AbortError" ? "انتهت المهلة" : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function issueBody(changed, drifted, failed, when) {
  const L = [];
  L.push(`مراجعة المصادر — ${when}`, "");
  if (changed.length) {
    L.push("## أرقام لم تعد موجودة في صفحتها", "");
    L.push("هذه إشارة قوية إلى أن الرقم المنشور عندنا قديم. افتح الرابط، واقرأ القيمة الجديدة، وحدّث ملف البيانات.", "");
    for (const c of changed) {
      L.push(`### ${c.name || c.url}`);
      L.push(`- ما نقوله: **${c.missing.join("، ")}** — لم نعد نجده في الصفحة`);
      L.push(`- يخص: ${c.labels.join(" · ")}`);
      L.push(`- المصدر: ${c.url}`, "");
    }
  }
  if (drifted.length) {
    L.push("## صفحات تغيّر نصّها وأرقامنا ما زالت فيها", "");
    L.push("إشارة ضعيفة: قد يكون تغييرًا تحريريًا لا رقميًا. نظرة سريعة تكفي، وقد لا تحتاج تعديلًا.", "");
    for (const d of drifted) L.push(`- ${d.name || d.url} — ${d.labels.join(" · ")}\n  ${d.url}`);
    L.push("");
  }
  if (failed.length) {
    L.push("## مصادر تعذّر الوصول إليها", "");
    L.push("لا يعني هذا أن الرقم تغيّر. قد يكون انقطاعًا مؤقتًا أو صفحة نُقلت — وإن تكرر أسبوعين، فالرابط على الأرجح مات.", "");
    for (const f of failed) L.push(`- ${f.name || f.url} — ${f.error}\n  ${f.url}`);
    L.push("");
  }
  L.push("---", "");
  L.push("بعد التحديث: غيّر `verified` أو `asOf` في ملف البيانات حتى لو لم يتغير الرقم، ثم أغلق هذه التذكرة.");
  L.push("فُتحت تلقائيًا بواسطة `scripts/watch-sources.mjs`.");
  return L.join("\n");
}

function openIssue(title, body) {
  if (DRY || !process.env.GITHUB_TOKEN) {
    console.log("\n--- التذكرة التي كانت ستُفتح ---\n");
    console.log(`# ${title}\n`);
    console.log(body);
    return;
  }
  try {
    execFileSync("gh", ["issue", "create", "--title", title, "--body", body, "--label", "sources"], {
      stdio: "inherit",
      env: process.env,
    });
  } catch (err) {
    // تسمية غير موجودة أو صلاحية ناقصة — أعد المحاولة بلا تسمية بدل أن تفشل المهمة
    console.error("تعذّر فتح التذكرة مع التسمية، إعادة المحاولة بدونها:", err.message);
    execFileSync("gh", ["issue", "create", "--title", title, "--body", body], { stdio: "inherit", env: process.env });
  }
}

const targets = buildTargets();
const state = existsSync(STATE_FILE) ? read(STATE_FILE) : { sources: {} };
const today = new Date().toISOString().slice(0, 10);

const changed = [];
const drifted = [];
const failed = [];

console.log(`يراقب ${targets.length} مصدرًا…`);

for (const t of targets) {
  const prev = state.sources[t.url] || {};
  const { text, error } = await fetchText(t.url);

  if (error) {
    failed.push({ ...t, error });
    state.sources[t.url] = { ...prev, lastError: error, lastTried: today };
    console.log(`  ✗ ${t.url} — ${error}`);
    continue;
  }

  const h = hash(text);
  const missing = t.tokens.filter((tok) => !text.includes(tok));

  if (missing.length) {
    changed.push({ ...t, missing });
    console.log(`  ! ${t.url} — اختفى: ${missing.join("، ")}`);
  } else if (prev.hash && prev.hash !== h) {
    drifted.push(t);
    console.log(`  ~ ${t.url} — تغيّر النص، والأرقام ما زالت موجودة`);
  } else {
    console.log(`  ✓ ${t.url}`);
  }

  state.sources[t.url] = { hash: h, tokens: t.tokens, lastSeen: today, lastError: null };
}

state.lastRun = today;
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

if (!changed.length && !drifted.length && !failed.length) {
  console.log("\nلا جديد. لم تُفتح تذكرة.");
  process.exit(0);
}

// الصمت نفسه معلومة: لا تذكرة إلا حين يوجد ما يُقرأ
const title = changed.length
  ? `مصادر تحتاج تحديثًا (${changed.length}) — ${today}`
  : failed.length && !drifted.length
    ? `مصادر تعذّر الوصول إليها (${failed.length}) — ${today}`
    : `مصادر تغيّرت صفحاتها (${drifted.length}) — ${today}`;

openIssue(title, issueBody(changed, drifted, failed, today));
process.exit(0);
