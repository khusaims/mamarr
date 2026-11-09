#!/usr/bin/env node
/**
 * ممرّ — توليد صور المشاركة (Open Graph) لكل صفحة.
 *
 * يقرأ عناوين الصفحات من مصدر الموقع ويولّد صورة 1200×630 لكل واحدة،
 * فتظهر بطاقة أنيقة عند مشاركة الرابط في واتساب أو لينكدإن بدل رابط عارٍ.
 *
 * التشغيل:  node scripts/og-images.mjs
 * المتطلبات: rsvg-convert (حزمة librsvg) وخط IBM Plex Sans Arabic مثبّت في النظام.
 *
 * الصور تُحفظ في src/img/og/ وتُرفع مع المستودع، فلا يحتاج Netlify أي أداة إضافية.
 * أعد تشغيله بعد إضافة أي مقال جديد.
 */

import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = path.join(ROOT, "src/img/og");
const TMP = path.join(ROOT, ".og-tmp");

const C = { ink: "#0e2f3f", buoy: "#f2641b", sand: "#d9cdb6", mist: "#a9bac2", white: "#ffffff" };

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** يلفّ النص على أسطر بتقدير عرض الحرف — تقريبي لكنه كافٍ لعنوان. */
function wrap(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else line = next;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length + 1) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[،,.\s]+$/, "") + "…";
  }
  return lines;
}

function svg({ title, kind, lang }) {
  const rtl = lang === "ar";
  // في SVG مع direction=rtl تكون "start" هي الحافة اليمنى — لذا الإرساء "start" دائمًا
  const anchor = "start";
  const x = rtl ? 1120 : 80;
  const maxChars = rtl ? 34 : 40;
  const lines = wrap(title, maxChars, 3);
  const size = lines.length >= 3 ? 56 : lines.length === 2 ? 64 : 72;
  const startY = 300 - (lines.length - 1) * (size * 0.62);
  const brand = rtl ? "ممرّ" : "Mamarr";
  const foot = rtl ? "لوجستيات الخليج والبحر الأحمر" : "Gulf and Red Sea logistics";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${C.ink}"/>
  <rect x="0" y="0" width="1200" height="10" fill="${C.buoy}"/>
  <path d="M 80 560 C 300 560, 360 470, 600 470 S 900 560, 1120 560" fill="none" stroke="#2a5567" stroke-width="2" stroke-dasharray="4 10"/>
  <path d="M 80 540 C 280 540, 340 455, 600 450 S 920 530, 1120 525" fill="none" stroke="${C.buoy}" stroke-width="4" stroke-linecap="round" opacity="0.85"/>
  <circle cx="80" cy="540" r="8" fill="${C.buoy}"/><circle cx="600" cy="450" r="8" fill="${C.buoy}"/><circle cx="1120" cy="525" r="8" fill="${C.buoy}"/>
  <text x="${x}" y="110" text-anchor="${anchor}" font-family="IBM Plex Sans Arabic" font-size="40" font-weight="700" fill="${C.white}" direction="${rtl ? "rtl" : "ltr"}">${esc(brand)}</text>
  ${kind ? `<text x="${x}" y="165" text-anchor="${anchor}" font-family="IBM Plex Sans Arabic" font-size="26" font-weight="500" fill="${C.buoy}" direction="${rtl ? "rtl" : "ltr"}">${esc(kind)}</text>` : ""}
  ${lines
    .map(
      (l, i) =>
        `<text x="${x}" y="${startY + i * size * 1.3}" text-anchor="${anchor}" font-family="IBM Plex Sans Arabic" font-size="${size}" font-weight="700" fill="${C.white}" direction="${rtl ? "rtl" : "ltr"}">${esc(l)}</text>`
    )
    .join("\n  ")}
  <text x="${x}" y="600" text-anchor="${anchor}" font-family="IBM Plex Sans Arabic" font-size="24" font-weight="400" fill="${C.mist}" direction="${rtl ? "rtl" : "ltr"}">${esc(foot)}</text>
</svg>`;
}

/** يقرأ عنوان الصفحة ونوعها من الـ front matter في ملفات المصدر. */
function frontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const KIND = {
  articles: { ar: "تحليل", en: "Analysis" },
  ports: { ar: "ميناء", en: "Port" }
};

async function collect() {
  const jobs = [];
  for (const lang of ["ar", "en"]) {
    // الصفحات الثابتة
    jobs.push({ slug: `${lang}-home`, lang, kind: "", title: lang === "ar"
      ? "لوجستيات الخليج والبحر الأحمر — لمن يشحن من هنا وإلى هنا"
      : "Gulf and Red Sea logistics, for the people who ship through it" });
    jobs.push({ slug: `${lang}-rates`, lang, kind: lang === "ar" ? "بيانات" : "Data",
      title: lang === "ar" ? "أسعار الشحن للخطوط الخليجية" : "Freight rates on Gulf lanes" });
    jobs.push({ slug: `${lang}-events`, lang, kind: lang === "ar" ? "أجندة" : "Calendar",
      title: lang === "ar" ? "المعارض والمؤتمرات اللوجستية" : "Logistics exhibitions and conferences" });
    jobs.push({ slug: `${lang}-contribute`, lang, kind: lang === "ar" ? "شارك" : "Contribute",
      title: lang === "ar" ? "شارك عرض سعر شحن" : "Share a freight quote" });
    jobs.push({ slug: `${lang}-glossary`, lang, kind: lang === "ar" ? "مرجع" : "Reference",
      title: lang === "ar" ? "المعجم اللوجستي" : "Logistics glossary" });
    jobs.push({ slug: `${lang}-calculator`, lang, kind: lang === "ar" ? "أداة" : "Tool",
      title: lang === "ar" ? "حاسبة التكلفة الواصلة للاستيراد إلى الخليج" : "GCC landed cost calculator" });
    jobs.push({ slug: `${lang}-about`, lang, kind: "", title: lang === "ar" ? "من نحن" : "About Mamarr" });

    // المقالات وصفحات الموانئ
    for (const section of ["articles", "ports"]) {
      const dir = path.join(ROOT, "src", lang, section);
      let files = [];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const f of files.filter((f) => f.endsWith(".md"))) {
        const fm = frontMatter(await readFile(path.join(dir, f), "utf8"));
        if (!fm.title) continue;
        jobs.push({
          slug: `${lang}-${section}-${f.replace(/\.md$/, "")}`,
          lang,
          kind: KIND[section][lang],
          title: fm.title
        });
      }
    }
  }

  // الموانئ المولّدة من ports.json
  const portsData = require("../src/_data/ports.json");
  for (const lang of ["ar", "en"]) {
    for (const p of portsData.ports.filter((x) => !x.detailed)) {
      jobs.push({ slug: `${lang}-portx-${p.slug}`, lang, kind: lang === "ar" ? "ميناء" : "Port", title: p.name[lang] });
    }
  }

  // مصطلحات المعجم
  const glossary = require("../src/_data/glossary.json");
  for (const lang of ["ar", "en"]) {
    for (const t of glossary.terms) {
      jobs.push({
        slug: `${lang}-glossary-${t.slug}`,
        lang,
        kind: lang === "ar" ? "مصطلح" : "Term",
        title: t.term[lang]
      });
    }
  }
  return jobs;
}

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await mkdir(OUT, { recursive: true });

  const jobs = await collect();
  for (const job of jobs) {
    const s = path.join(TMP, `${job.slug}.svg`);
    const p = path.join(OUT, `${job.slug}.png`);
    await writeFile(s, svg(job), "utf8");
    await run("rsvg-convert", ["-w", "1200", "-h", "630", "-o", p, s]);
    console.log(`✓ ${job.slug}.png — ${job.title.slice(0, 48)}`);
  }
  await rm(TMP, { recursive: true, force: true });
  console.log(`\nتم توليد ${jobs.length} صورة في src/img/og/`);
}

main().catch((e) => {
  console.error("فشل التوليد:", e.message);
  console.error("تأكد من تثبيت rsvg-convert وخط IBM Plex Sans Arabic.");
  process.exit(1);
});
