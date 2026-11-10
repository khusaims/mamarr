#!/usr/bin/env node
/**
 * مِجسّ تغطية AIS — قياس، لا ميزة.
 *
 * السؤال الذي يجيب عنه: هل يرى البثّ المجاني من aisstream.io سفنًا كافية
 * عند موانئنا لنبني عليها شيئًا؟ البثّ أرضي، أي أنه ضعيف في عرض البحر
 * وقويّ قرب الساحل. وموضوع ممرّ هو الساحل. هذا المِجسّ يتحقّق من ذلك
 * بالعدّ بدل الظنّ.
 *
 * لا يكتب في المستودع شيئًا، ولا يُنشر منه رقم على الموقع. مخرجه تقرير
 * في ملخّص المهمة فقط.
 *
 * يحتاج: AISSTREAM_KEY  (مفتاح مجاني من aisstream.io)
 */

import WebSocket from "ws";

const KEY = process.env.AISSTREAM_KEY;
const SECONDS = Number(process.env.PROBE_SECONDS || 90);

if (!KEY) {
  console.error("AISSTREAM_KEY غير موجود. أضفه في Settings → Secrets → Actions.");
  process.exit(1);
}

// صندوقان يغطيان موانئنا: بحر العرب وخليج عُمان، ثم الخليج العربي.
// الترتيب الذي تتوقّعه الخدمة: الركن الشمالي الغربي أولًا ثم الجنوبي الشرقي،
// أي خطّ العرض الأعلى أولًا. عكسه يُقبل بلا خطأ ويُعيد لا شيء.
const BOXES = [
  [[27.0, 53.0], [16.0, 60.5]],
  [[31.0, 47.0], [24.0, 57.0]],
];

// الموانئ التي نقيس عندها. إحداثيات تقريبية للموقع، كافية لقياس الجوار.
const PORTS = [
  { slug: "sohar",            ar: "صحار",          lat: 24.50, lon: 56.62 },
  { slug: "sultan-qaboos",    ar: "السلطان قابوس", lat: 23.62, lon: 58.55 },
  { slug: "duqm",             ar: "الدقم",         lat: 19.65, lon: 57.70 },
  { slug: "salalah",          ar: "صلالة",         lat: 16.95, lon: 54.00 },
  { slug: "fujairah",         ar: "الفجيرة",       lat: 25.12, lon: 56.33 },
  { slug: "khor-fakkan",      ar: "خورفكان",       lat: 25.33, lon: 56.35 },
  { slug: "jebel-ali",        ar: "جبل علي",       lat: 25.01, lon: 55.06 },
  { slug: "khalifa-port",     ar: "خليفة",         lat: 24.83, lon: 54.67 },
  { slug: "hamad-port",       ar: "حمد",           lat: 25.00, lon: 51.62 },
  { slug: "dammam",           ar: "الدمام",        lat: 26.50, lon: 50.20 },
];

const RADIUS_KM = 50;
const STILL_KNOTS = 1.0;

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const vessels = new Map(); // mmsi → { lat, lon, sog, name, type }
const messageTypes = new Map();
let frames = 0;
// أول ردود الخدمة، نصًّا. حين يعود المِجسّ بصفر نحتاج أن نعرف
// أرفضت المفتاح أم قبلته ولم ترَ شيئًا — والفرق بينهما كل شيء.
const firstReplies = [];

// حزمة ws لا WebSocket المدمج في Node: الخدمة تضغط الإطارات بامتداد
// permessage-deflate، والمدمج لا يتفاوض عليه. رسالة التأكيد تصل غير
// مضغوطة فتُقرأ، ثم يبدأ الضغط فيصير كل إطار بعدها رُكامًا صامتًا.
const socket = new WebSocket("wss://stream.aisstream.io/v0/stream", {
  perMessageDeflate: true,
});
const decoder = new TextDecoder();
let settled = false;

const timer = setTimeout(() => {
  try { socket.close(); } catch {}
}, SECONDS * 1000);

socket.on("open", () => {
  console.log(`متصل. أجمع ${SECONDS} ثانية…`);
  socket.send(JSON.stringify({ APIKey: KEY, BoundingBoxes: BOXES }));
});

socket.on("message", (data) => {
  frames++;
  let text;
  try {
    text = typeof data === "string" ? data : decoder.decode(data);
  } catch {
    return;
  }
  if (firstReplies.length < 3) firstReplies.push(text.slice(0, 300));

  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.error) {
    console.error(`رفض من الخدمة: ${msg.error}`);
    try { socket.close(); } catch {}
    return;
  }

  const kind = msg.MessageType;
  if (kind) messageTypes.set(kind, (messageTypes.get(kind) || 0) + 1);

  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI || meta.MMSI_String || "");
  if (!mmsi) return;

  const existing = vessels.get(mmsi) || {};

  if (kind === "PositionReport") {
    const r = msg.Message?.PositionReport;
    if (r && Number.isFinite(r.Latitude) && Number.isFinite(r.Longitude)) {
      existing.lat = r.Latitude;
      existing.lon = r.Longitude;
      existing.sog = r.Sog;
    }
  } else if (kind === "ShipStaticData") {
    const r = msg.Message?.ShipStaticData;
    if (r) {
      existing.name = (r.Name || "").trim();
      existing.type = r.Type;
    }
  }
  if (meta.ShipName && !existing.name) existing.name = String(meta.ShipName).trim();
  vessels.set(mmsi, existing);
});

socket.on("error", () => {
  if (!settled) {
    settled = true;
    clearTimeout(timer);
    console.error("تعذّر الاتصال بالبثّ. تحقّق من المفتاح ومن أن الخدمة تعمل.");
    process.exit(1);
  }
});

socket.on("close", () => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  report();
});

function report() {
  const positioned = [...vessels.entries()].filter(([, v]) => Number.isFinite(v.lat));
  const lines = [];
  const say = (s = "") => { lines.push(s); console.log(s); };

  say(`## مِجسّ تغطية AIS`);
  say();
  say(`نافذة القياس: ${SECONDS} ثانية — ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`);
  say();
  say(`- رسائل مستلمة: **${frames}**`);
  say(`- سفن مميّزة (MMSI): **${vessels.size}**`);
  say(`- منها بموقع صالح: **${positioned.length}**`);
  say();

  if (!positioned.length) {
    say(`> لم تُستلم مواقع.`);
    say();
    if (firstReplies.length) {
      say(`أول ما ردّت به الخدمة — منه يُعرف السبب:`);
      say();
      say("```");
      firstReplies.forEach((r) => say(r));
      say("```");
    } else {
      say(`ولم تردّ الخدمة بشيء إطلاقًا: الاتصال فُتح وبقي صامتًا.`);
    }
    flush(lines);
    return;
  }

  say(`### السفن حول كل ميناء (نصف قطر ${RADIUS_KM} كم)`);
  say();
  say(`| الميناء | سفن | واقفة | متحرّكة |`);
  say(`| --- | --- | --- | --- |`);

  let anyNear = 0;
  for (const p of PORTS) {
    const near = positioned.filter(([, v]) => haversineKm(p.lat, p.lon, v.lat, v.lon) <= RADIUS_KM);
    const still = near.filter(([, v]) => Number.isFinite(v.sog) && v.sog < STILL_KNOTS).length;
    anyNear += near.length;
    say(`| ${p.ar} | ${near.length} | ${still} | ${near.length - still} |`);
  }
  say();

  const types = [...messageTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  say(`### أنواع الرسائل`);
  say();
  say(types.map(([k, n]) => `- ${k}: ${n}`).join("\n"));
  say();

  say(`### الحكم`);
  say();
  if (anyNear === 0) {
    say(`التغطية لا تصل موانئنا في هذه النافذة. البثّ يرى سفنًا لكن ليس عندنا — لا تبنِ عليه.`);
  } else if (anyNear < 10) {
    say(`التغطية موجودة لكنها رقيقة (${anyNear} رصدًا قرب الموانئ). تكفي لمؤشّر وصفي، لا لعدّاد يُنشَر رقمه.`);
  } else {
    say(`التغطية كافية (${anyNear} رصدًا قرب الموانئ). يستحق الخطوة التالية: التحقّق من الترخيص قبل نشر أي رقم.`);
  }
  say();
  say(`المصدر: aisstream.io — AIS أرضي. القياس نافذة واحدة قصيرة، لا حكم على الخدمة في كل وقت.`);

  flush(lines);
}

function flush(lines) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    import("node:fs").then((fs) => fs.appendFileSync(summary, lines.join("\n") + "\n"));
  }
}
