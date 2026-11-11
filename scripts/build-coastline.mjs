#!/usr/bin/env node
/**
 * توليد مسار الساحل لخريطة الواجهة من بيانات Natural Earth.
 *
 * المصدر: Natural Earth (ملك عام، بلا شروط نسبة). يُنزَّل من مرآته على GitHub.
 * المخرج: src/_data/coastline.json — مسار SVG جاهز، مُسقَط بإطار mapframe.json.
 *
 * يُشغَّل مرة واحدة باليد. السواحل لا تتحرّك، ولا داعي لمهمة دورية:
 *   node scripts/build-coastline.mjs
 *
 * أعد تشغيله فقط إذا غيّرت mapframe.json، وإلا انزاح الساحل عن الموانئ.
 */

import { readFile, writeFile } from "node:fs/promises";

const SOURCE =
  "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/physical/ne_50m_land.json";
const TOLERANCE = 0.45; // بالبكسل على لوحة SVG

const frame = JSON.parse(await readFile("src/_data/mapframe.json", "utf8"));
const [lo0, lo1] = frame.lon;
const [la0, la1] = frame.lat;
const { width: W, height: H } = frame;

const project = ([lon, lat]) => [
  ((lon - lo0) / (lo1 - lo0)) * W,
  ((la1 - lat) / (la1 - la0)) * H,
];

// قصّ المضلّع على حوافّ النافذة الأربع (Sutherland–Hodgman)، وإلا امتدّت
// القارات خارج اللوحة وضخّمت حجم الملف بلا فائدة.
function clip(points, inside, intersect) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const prev = points[(i + points.length - 1) % points.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

function clipToBox(ring) {
  const edges = [
    { inside: (p) => p[0] >= lo0, at: (a, b) => lerpX(a, b, lo0) },
    { inside: (p) => p[0] <= lo1, at: (a, b) => lerpX(a, b, lo1) },
    { inside: (p) => p[1] >= la0, at: (a, b) => lerpY(a, b, la0) },
    { inside: (p) => p[1] <= la1, at: (a, b) => lerpY(a, b, la1) },
  ];
  let poly = ring;
  for (const e of edges) {
    if (!poly.length) return [];
    poly = clip(poly, e.inside, e.at);
  }
  return poly;
}

const lerpX = (a, b, x) => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0] || 1e-12)];
const lerpY = (a, b, y) => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1] || 1e-12), y];

// تبسيط Douglas–Peucker بعد الإسقاط، فالتحمّل يقاس بالبكسل لا بالدرجة
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const sqTol = tol * tol;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0;
    let index = 0;
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegDist(pts[i], pts[first], pts[last]);
      if (sq > maxSq) { index = i; maxSq = sq; }
    }
    if (maxSq > sqTol) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function sqSegDist(p, a, b) {
  let [x, y] = a;
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`تعذّر تنزيل بيانات الساحل: HTTP ${res.status}`);
const geo = await res.json();

const rings = [];
for (const feature of geo.features || []) {
  const g = feature.geometry;
  if (!g) continue;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of polys) {
    for (const ring of poly) {
      // تجاهل سريع لما لا يقترب من النافذة
      let near = false;
      for (const [lon, lat] of ring) {
        if (lon >= lo0 - 2 && lon <= lo1 + 2 && lat >= la0 - 2 && lat <= la1 + 2) { near = true; break; }
      }
      if (!near) continue;

      const clipped = clipToBox(ring);
      if (clipped.length < 3) continue;
      const projected = simplify(clipped.map(project), TOLERANCE);
      if (projected.length < 3) continue;
      rings.push(projected);
    }
  }
}

rings.sort((a, b) => b.length - a.length);
const round = (n) => Math.round(n * 10) / 10;
const d = rings
  .map((r) => "M" + r.map(([x, y]) => `${round(x)} ${round(y)}`).join("L") + "Z")
  .join("");

const out = {
  _readme: [
    "مُولَّد. لا تحرّره بيدك — شغّل scripts/build-coastline.mjs.",
    "مُسقَط بإطار mapframe.json بالضبط؛ أي تغيير في الإطار يوجب إعادة التوليد.",
  ],
  source: "Natural Earth 50m land (public domain)",
  builtAt: new Date().toISOString().slice(0, 10),
  frame: { lon: frame.lon, lat: frame.lat, width: W, height: H },
  rings: rings.length,
  d,
};

await writeFile("src/_data/coastline.json", JSON.stringify(out, null, 2) + "\n");
console.log(`حلقات: ${rings.length}  —  طول المسار: ${(d.length / 1024).toFixed(1)} ك.ب`);
