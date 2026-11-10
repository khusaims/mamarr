#!/usr/bin/env node
/**
 * بناء جدول المسافات البرية بين الموانئ المتصلة بشبكة طرق واحدة.
 *
 * المصدر: OpenStreetMap عبر محرك OSRM. المسافات لا تتغيّر، فهذه المهمة
 * تُشغَّل يدويًا مرة واحدة، لا أسبوعيًا. أعد تشغيلها فقط إذا أضفت ميناءً
 * بريًا جديدًا أو صحّحت إحداثية.
 *
 * ما تكتبه: src/_data/distances.json
 * ما تحتاجه: لا مفاتيح. شبكة فقط.
 *
 * قاعدتان:
 *   - لا تُكتب مسافة لم يُرجعها المحرّك. الزوج بلا طريق يبقى بلا قيمة.
 *   - الإحداثيات المُستنبطة من Nominatim تُوسم بمصدرها ولا تُخلط بإحداثيات
 *     UN/LOCODE في ports.json.
 */

import { readFile, writeFile } from "node:fs/promises";

const UA = "Mamarr/1.0 (+https://github.com/khusaims/mamarr) one-off port distance matrix";
const OSRM = "https://router.project-osrm.org";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";

// الدول الموصولة بشبكة طرق واحدة مع شبه الجزيرة العربية. إيران ومصر
// مستثناتان عن قصد: الطريق إليهما موجود هندسيًا لكنه ليس طريق شحن فعليًا
// من موانئنا، وإدراجه يعطي رقمًا صحيحًا حسابيًا ومضلّلًا عمليًا.
const LAND_CONNECTED = new Set([
  "Oman", "UAE", "Saudi Arabia", "Qatar", "Bahrain", "Kuwait", "Iraq", "Jordan", "Yemen",
]);

// استعلام البحث لكل ميناء تنقصه إحداثية. مكتوب هنا لا مُشتقًّا من الاسم،
// لأن اسم الميناء وحده يعيد مركز المدينة أحيانًا.
const GEOCODE_QUERIES = {
  sohar: "Port of Sohar, Oman",
  salalah: "Port of Salalah, Oman",
  "jebel-ali": "Jebel Ali Port, Dubai, United Arab Emirates",
  aden: "Port of Aden, Yemen",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, label) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

async function geocode(slug, query) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const hits = await getJSON(url, `nominatim ${slug}`);
  if (!Array.isArray(hits) || !hits.length) return null;
  const { lat, lon, display_name } = hits[0];
  const coords = [Number(Number(lat).toFixed(4)), Number(Number(lon).toFixed(4))];
  if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;
  return { coords, matched: display_name };
}

async function main() {
  const dry = process.argv.includes("--dry");
  const raw = JSON.parse(await readFile("src/_data/ports.json", "utf8"));

  const selected = raw.ports.filter((p) => LAND_CONNECTED.has(p.country.en));
  console.log(`موانئ برية مختارة: ${selected.length}`);

  // ١. استكمال الإحداثيات الناقصة من OSM، موسومة بمصدرها.
  const geocoded = {};
  for (const p of selected) {
    if (p.coords) continue;
    const query = GEOCODE_QUERIES[p.slug];
    if (!query) {
      console.log(`  تخطّي ${p.slug}: لا إحداثية ولا استعلام بحث مكتوب له`);
      continue;
    }
    const hit = await geocode(p.slug, query);
    await sleep(1100); // Nominatim: طلب واحد في الثانية كحدّ أقصى
    if (!hit) {
      console.log(`  تعذّر تحديد ${p.slug}`);
      continue;
    }
    geocoded[p.slug] = hit;
    console.log(`  ${p.slug} ← ${hit.coords.join(", ")}  (${hit.matched.slice(0, 60)})`);
  }

  // ٢. بناء قائمة العقد. الميناء بلا إحداثية — مكتوبة أو مُستنبطة — يسقط.
  const nodes = selected
    .map((p) => {
      const g = geocoded[p.slug];
      const coords = p.coords || (g && g.coords);
      if (!coords) return null;
      return {
        slug: p.slug,
        locode: p.locode || null,
        name: p.name,
        country: p.country,
        coords,
        coordsFrom: p.coords ? "unlocode" : "osm",
      };
    })
    .filter(Boolean);

  const dropped = selected.length - nodes.length;
  if (dropped) console.log(`سقطت ${dropped} بلا إحداثيات`);
  if (nodes.length < 2) throw new Error("لا توجد عقدتان صالحتان");

  // ٣. مصفوفة واحدة من OSRM. طلب واحد لكل الأزواج.
  const coordList = nodes.map((n) => `${n.coords[1]},${n.coords[0]}`).join(";");
  const url = `${OSRM}/table/v1/driving/${coordList}?annotations=distance,duration`;
  console.log(`طلب مصفوفة ${nodes.length}×${nodes.length} من OSRM…`);
  const table = await getJSON(url, "osrm table");
  if (table.code !== "Ok") throw new Error(`osrm: ${table.code} ${table.message || ""}`);

  // ٤. أزواج فريدة فقط. القيمة الفارغة تبقى فارغة.
  const pairs = [];
  let unroutable = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const m = table.distances?.[i]?.[j];
      const s = table.durations?.[i]?.[j];
      if (typeof m !== "number" || typeof s !== "number" || m <= 0) {
        unroutable++;
        continue;
      }
      pairs.push({
        from: nodes[i].slug,
        to: nodes[j].slug,
        km: Math.round(m / 1000),
        hours: Number((s / 3600).toFixed(1)),
      });
    }
  }
  pairs.sort((a, b) => a.km - b.km);
  console.log(`أزواج بطريق: ${pairs.length}  —  بلا طريق: ${unroutable}`);

  const out = {
    _readme: [
      "مسافات القيادة بين الموانئ المتصلة برًّا، محسوبة مرة واحدة من OpenStreetMap عبر OSRM.",
      "hours هو زمن قيادة صافٍ: لا يشمل الانتظار على المنافذ الحدودية ولا التحميل ولا الراحة.",
      "لا تُحرّر هذه الأرقام يدويًا. أعد تشغيل scripts/build-distances.mjs عبر مهمة build-distances.",
      "الموانئ الموسومة coordsFrom: osm إحداثياتها من Nominatim لا من UN/LOCODE، ودقتها على مستوى الموقع لا البوابة.",
    ],
    builtAt: new Date().toISOString().slice(0, 10),
    engine: "OSRM (router.project-osrm.org)",
    attribution: {
      ar: "بيانات الطرق © مساهمو OpenStreetMap، بموجب ODbL",
      en: "Road data © OpenStreetMap contributors, under the ODbL",
    },
    nodes,
    pairs,
  };

  if (dry) {
    console.log(JSON.stringify({ ...out, pairs: pairs.slice(0, 8) }, null, 2));
    console.log(`\n(تجربة فقط — لم يُكتب شيء. ${pairs.length} زوجًا جاهز)`);
    return;
  }

  await writeFile("src/_data/distances.json", JSON.stringify(out, null, 2) + "\n");
  console.log("كُتب src/_data/distances.json");
}

main().catch((err) => {
  console.error(`فشل: ${err.message}`);
  process.exit(1);
});
