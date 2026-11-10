#!/usr/bin/env node
/**
 * ممرّ — تحديث مؤشرات الشحن العالمية آليًا.
 *
 * يجلب المؤشرات من OilPriceAPI ويحدّث قسم "indices" في src/_data/rates.json.
 * لا يلمس قسم "lanes" إطلاقًا — أسعار الخطوط الخليجية تجمعها أنت يدويًا.
 *
 * التشغيل محليًا:   OILPRICEAPI_KEY=xxxx node scripts/update-rates.mjs
 * في GitHub:        يعمل تلقائيًا كل جمعة عبر .github/workflows/update-rates.yml
 *
 * بدون مفتاح: يخرج بنجاح دون تغيير شيء (حتى لا يفشل البناء).
 */

import { readFile, writeFile } from "node:fs/promises";

const FILE = new URL("../src/_data/rates.json", import.meta.url);
// يمكن تجاوز العنوان بمتغير بيئة عند الاختبار المحلي
const API = process.env.OILPRICEAPI_URL || "https://api.oilpriceapi.com/v1/prices/latest";
/**
 * ينظّف المفتاح من الأخطاء الشائعة عند اللصق:
 * مسافات، أسطر جديدة، علامات اقتباس، وبادئة "Token " أو "Bearer ".
 */
function cleanKey(raw) {
  if (!raw) return "";
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^(Token|Bearer)\s+/i, "")
    .trim();
}

const RAW_KEY = process.env.OILPRICEAPI_KEY;
const KEY = cleanKey(RAW_KEY);
const HISTORY = 8; // عدد القيم المحفوظة في السلسلة

// لكل مؤشر عدة رموز محتملة — نجرّبها بالترتيب ونأخذ أول ما ينجح.
const INDICES = [
  {
    id: "wci",
    codes: ["CONTAINER_FREIGHT_COMPOSITE_USD", "DREWRY_WCI_USD", "WCI_INDEX", "DREWRY_WCI", "WCI_COMPOSITE_USD"],
    name: { ar: "مؤشر درووري العالمي للحاويات", en: "Drewry World Container Index" },
    short: { ar: "WCI", en: "WCI" },
    unit: { ar: "دولار / حاوية ٤٠ قدمًا", en: "USD / 40ft container" },
    cadence: { ar: "أسبوعي — الخميس", en: "Weekly — Thursday" }
  },
  {
    id: "scfi",
    codes: ["SCFI_INDEX", "SCFI", "SHANGHAI_CONTAINERIZED_FREIGHT_INDEX"],
    name: { ar: "مؤشر شنغهاي للشحن بالحاويات", en: "Shanghai Containerized Freight Index" },
    short: { ar: "SCFI", en: "SCFI" },
    unit: { ar: "نقطة", en: "points" },
    cadence: { ar: "أسبوعي — الجمعة", en: "Weekly — Friday" }
  },
  {
    id: "bdi",
    codes: ["BALTIC_DRY_INDEX", "BDI", "BALTIC_DRY"],
    name: { ar: "مؤشر البلطيق للبضائع الجافة", en: "Baltic Dry Index" },
    short: { ar: "BDI", en: "BDI" },
    unit: { ar: "نقطة", en: "points" },
    cadence: { ar: "يومي — أيام عمل لندن", en: "Daily — London business days" }
  },
  // المؤشران التاليان رموزهما تخمين: لا نعرف إن كان المزوّد يحملهما.
  // إن لم ينجح أي رمز، لا يُكتب شيء ولا يظهر شيء — وهذا السلوك المقصود.
  {
    id: "fbx",
    codes: ["FREIGHTOS_BALTIC_INDEX", "FBX_INDEX", "FBX", "FREIGHTOS_BALTIC_GLOBAL_USD"],
    name: { ar: "مؤشر فريتوس بالتيك", en: "Freightos Baltic Index" },
    short: { ar: "FBX", en: "FBX" },
    unit: { ar: "دولار / حاوية ٤٠ قدمًا", en: "USD / 40ft container" },
    cadence: { ar: "يومي — بمتوسط أسبوعي", en: "Daily — weekly average" },
    attribution: {
      ar: "مؤشر فريتوس بالتيك، بالتعاون مع بورصة البلطيق",
      en: "Freightos Baltic Index, with the Baltic Exchange"
    }
  },
  {
    id: "xsi",
    codes: ["XENETA_SHIPPING_INDEX", "XSI_INDEX", "XSI_C", "XSI"],
    name: { ar: "مؤشر زينيتا للشحن", en: "Xeneta Shipping Index" },
    short: { ar: "XSI", en: "XSI" },
    unit: { ar: "دولار / حاوية", en: "USD / container" },
    cadence: { ar: "شهري — فوري وتعاقدي", en: "Monthly — spot and contract" },
    // زينيتا تسمح للجميع باستخدام بيانات XSI-C مقابل إسناد صريح. الإسناد شرط لا تزيين.
    attribution: {
      ar: "البيانات منسوبة إلى مؤشر زينيتا للشحن (XSI®-C)",
      en: "Data accredited to the Xeneta Shipping Index (XSI®-C)"
    }
  }
];

function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** يستخرج القيمة من أشكال الاستجابة المحتملة دون افتراض بنية واحدة. */
function extractPrice(payload) {
  const d = payload?.data ?? payload;
  for (const k of ["price", "value", "last", "close", "latest"]) {
    const n = num(d?.[k]);
    if (n !== null) return n;
  }
  return null;
}

function extractDate(payload) {
  const d = payload?.data ?? payload;
  for (const k of ["created_at", "date", "published_at", "timestamp", "updated_at"]) {
    const v = d?.[k];
    if (typeof v === "string" && v.length >= 10) return v.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/** يقتطع جسم الرد للتشخيص، مع إخفاء المفتاح إن ظهر فيه. */
function snippet(text) {
  return String(text).replace(KEY, "***").replace(/\s+/g, " ").slice(0, 180);
}

async function fetchCode(code) {
  const res = await fetch(`${API}?by_code=${encodeURIComponent(code)}`, {
    headers: { Authorization: `Token ${KEY}`, Accept: "application/json" }
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${snippet(body)}`);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`رد ليس JSON — ${snippet(body)}`);
  }
  const price = extractPrice(json);
  if (price === null) throw new Error(`لا يوجد حقل سعر — ${snippet(body)}`);
  return { price, date: extractDate(json) };
}

async function fetchIndex(spec) {
  const errors = [];
  for (const code of spec.codes) {
    try {
      const r = await fetchCode(code);
      return { ...r, code };
    } catch (e) {
      errors.push(`${code}: ${e.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

function pctChange(curr, prev) {
  if (prev === null || prev === undefined || prev === 0) return 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

async function main() {
  if (!KEY) {
    console.log("OILPRICEAPI_KEY غير مضبوط — لم يُغيَّر شيء.");
    return;
  }

  // تشخيص شكل المفتاح دون كشفه: الطول والنمط فقط.
  console.log(`طول المفتاح بعد التنظيف: ${KEY.length} حرفًا`);
  if (KEY !== String(RAW_KEY)) {
    console.log("ملاحظة: نُظّف المفتاح من مسافات أو اقتباس أو بادئة Token قبل الاستخدام.");
  }
  if (!/^[0-9a-f]{32,}$/i.test(KEY)) {
    console.warn(
      "⚠ المفتاح لا يبدو مفتاحًا سداسيًا عشريًا (المتوقع ٦٤ حرفًا من 0-9 و a-f)." +
      "\n  تأكد أن خانة Name فيها OILPRICEAPI_KEY وخانة Secret فيها المفتاح وحده —" +
      "\n  لا اسم المتغير، ولا كلمة Token، ولا أمر curl كاملًا."
    );
  }

  const raw = await readFile(FILE, "utf8");
  const data = JSON.parse(raw);
  const before = JSON.stringify(data);

  if (!Array.isArray(data.indices)) data.indices = [];

  let updated = 0;
  const failures = [];

  for (const spec of INDICES) {
    let result;
    try {
      result = await fetchIndex(spec);
    } catch (e) {
      failures.push(`${spec.id} (${e.message})`);
      continue;
    }

    let entry = data.indices.find((i) => i.id === spec.id);
    if (!entry) {
      entry = { id: spec.id, name: spec.name, short: spec.short, unit: spec.unit, cadence: spec.cadence, series: [] };
      data.indices.push(entry);
    }
    // حافظ على النصوص إن عُدّلت يدويًا، وأضف الناقص فقط
    entry.name ??= spec.name;
    entry.short ??= spec.short;
    entry.unit ??= spec.unit;
    entry.cadence ??= spec.cadence;
    entry.series ??= [];
    if (spec.attribution) entry.attribution = spec.attribution;

    const prev = entry.series.length ? entry.series[entry.series.length - 1] : null;
    const sameDay = entry.published === result.date;

    if (sameDay) {
      // نفس يوم النشر: صحّح آخر قيمة بدل إضافة واحدة جديدة
      if (entry.series.length) entry.series[entry.series.length - 1] = result.price;
      else entry.series.push(result.price);
    } else {
      entry.series.push(result.price);
      if (entry.series.length > HISTORY) entry.series = entry.series.slice(-HISTORY);
    }

    entry.value = result.price;
    entry.published = result.date;
    entry.source_code = result.code;
    entry.change_pct = sameDay
      ? (entry.change_pct ?? 0)
      : pctChange(result.price, prev);
    updated++;
    console.log(`✓ ${spec.id}: ${result.price} (${result.date}, ${result.code})`);
  }

  if (failures.length) {
    console.warn("\n⚠ تعذّر جلب هذه المؤشرات:");
    for (const f of failures) console.warn("  - " + f);
    console.warn(
      "\nإن كان السبب 401 فالمفتاح خاطئ أو غير مضبوط في Secrets." +
      "\nإن كان 404 أو 'unknown code' فالرمز غير موجود — أرسل لي السطر أعلاه وأصحّحه." +
      "\nإن كان 403 فالمؤشر غير مشمول في خطة حسابك.\n"
    );
  }

  if (!updated) {
    // لا نُفشل التشغيل: الموقع يبقى يعمل بالقيم الحالية، والسجل أعلاه يشرح السبب.
    console.log("لم يُجلب أي مؤشر — لم يُغيَّر الملف، والموقع يعمل بالقيم الموجودة.");
    return;
  }

  data.indices_updated = new Date().toISOString().slice(0, 10);

  const next = JSON.stringify(data, null, 2) + "\n";
  if (JSON.stringify(JSON.parse(next)) === before) {
    console.log("لا تغيير في القيم.");
    return;
  }
  await writeFile(FILE, next, "utf8");
  console.log(`تم تحديث ${updated} مؤشرًا في rates.json`);
}

main().catch((e) => {
  console.error("فشل التحديث:", e.message);
  process.exit(1);
});
