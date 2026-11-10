#!/usr/bin/env node
/**
 * بناء جدول المسافات البرية بين الموانئ المتصلة بشبكة طرق واحدة.
 *
 * المصدر: OpenStreetMap عبر محرك OSRM. المسافات لا تتغيّر، فهذه المهمة
 * تُشغَّل يدويًا مرة واحدة، لا أسبوعيًا. أعد تشغيلها فقط إذا أضفت ميناءً
 * بريًا جديدًا أو صحّحت إحداثية.
 *
 * ما تكتبه: src/_data/distances.json
 * ما تحتاجه: لا مفاتيح، ولا خدمة بحث جغرافي. الإحداثيات كلها في ports.json.
 *
 * قاعدتان:
 *   - لا تُكتب مسافة لم يُرجعها المحرّك. الزوج بلا طريق يبقى بلا قيمة.
 *   - الإحداثيات الآتية من خارج قائمة UN/LOCODE تحمل coordsSource في
 *     ports.json، ويُنقل الوسم إلى المخرج فلا تختلط بغيرها.
 */

import { readFile, writeFile } from "node:fs/promises";

const UA = "Mamarr/1.0 (+https://github.com/khusaims/mamarr) one-off port distance matrix";
const OSRM = "https://router.project-osrm.org";

// الدول الموصولة بشبكة طرق واحدة مع شبه الجزيرة العربية. إيران ومصر
// مستثناتان عن قصد: الطريق إليهما موجود هندسيًا لكنه ليس طريق شحن فعليًا
// من موانئنا، وإدراجه يعطي رقمًا صحيحًا حسابيًا ومضلّلًا عمليًا. واليمن
// مستثنى لأن الشحن البري إليه من الخليج ليس خطًّا قائمًا.
const LAND_CONNECTED = new Set([
  "Oman", "UAE", "Saudi Arabia", "Qatar", "Bahrain", "Kuwait", "Iraq", "Jordan",
]);

async function getJSON(url, label) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const dry = process.argv.includes("--dry");
  const raw = JSON.parse(await readFile("src/_data/ports.json", "utf8"));

  const selected = raw.ports.filter((p) => LAND_CONNECTED.has(p.country.en));
  console.log(`موانئ برية مختارة: ${selected.length}`);

  // ١. العقد: الإحداثيات كلها من المستودع. لا خدمة خارجية، ولا تخمين.
  const nodes = selected
    .filter((p) => p.coords)
    .map((p) => ({
      slug: p.slug,
      locode: p.locode || null,
      name: p.name,
      country: p.country,
      coords: p.coords,
      coordsFrom: p.coordsSource || "unlocode",
    }));

  const dropped = selected.length - nodes.length;
  if (dropped) console.log(`سقطت ${dropped} بلا إحداثيات في ports.json`);
  if (nodes.length < 2) throw new Error("لا توجد عقدتان صالحتان");

  // ٢. مصفوفة واحدة من OSRM. طلب واحد لكل الأزواج.
  const coordList = nodes.map((n) => `${n.coords[1]},${n.coords[0]}`).join(";");
  const url = `${OSRM}/table/v1/driving/${coordList}?annotations=distance,duration`;
  console.log(`طلب مصفوفة ${nodes.length}×${nodes.length} من OSRM…`);
  const table = await getJSON(url, "osrm table");
  if (table.code !== "Ok") throw new Error(`osrm: ${table.code} ${table.message || ""}`);

  // ٣. أزواج فريدة فقط. القيمة الفارغة تبقى فارغة.
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
      "الموانئ الموسومة coordsFrom بغير unlocode إحداثياتها من مصدر مرجعي لا من قائمة UN/LOCODE، ودقتها على مستوى الموقع لا البوابة.",
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
