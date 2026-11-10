// ممرّ — Eleventy configuration
// Build:          npm run build          → _site/      (clean URLs, for Netlify / GitHub Pages / any host)
// Preview build:  npm run build:preview  → _preview/   (links end in index.html, for hosts without directory index)

const PREVIEW = !!process.env.PREVIEW;

// الرابط النسبي من صفحة إلى هدف مطلق — تستخدمه فلاتر الربط الداخلي أيضًا
function relative(target, from) {
  if (!target) return "#";
  if (/^(https?:)?\/\//.test(target) || target.startsWith("#") || target.startsWith("mailto:")) return target;
  const fromDir = (from || "/").endsWith("/") ? (from || "/") : (from || "/").slice(0, (from || "/").lastIndexOf("/") + 1);
  const depth = fromDir.split("/").filter(Boolean).length;
  const prefix = depth ? "../".repeat(depth) : "./";
  let t = target.replace(/^\//, "");
  if (PREVIEW && (t === "" || t.endsWith("/"))) t += "index.html";
  return prefix + t;
}

module.exports = function (eleventyConfig) {
  // Static assets copied as-is
  eleventyConfig.addPassthroughCopy({ "src/css": "css" });
  eleventyConfig.addPassthroughCopy({ "src/img": "img" });

  // Relative link from the current page to a root-absolute target.
  // Lets the same build work at a domain root, in a sub-folder, or as a hosted preview.
  eleventyConfig.addFilter("rel", (target, from) => relative(target, from));

  // Swap language prefix: /ar/x/ ↔ /en/x/
  eleventyConfig.addFilter("altLang", (url) => {
    if (url.startsWith("/ar/")) return "/en/" + url.slice(4);
    if (url.startsWith("/en/")) return "/ar/" + url.slice(4);
    return url;
  });

  // ---- Cross-linking: glossary terms and ports mentioned in prose ----
  const glossaryData = require("./src/_data/glossary.json");
  const portsData = require("./src/_data/ports.json");

  // Terms longest-first so "رمز النظام المنسّق" wins over a shorter overlapping term
  const termsByLang = (lang) =>
    glossaryData.terms
      .map((t) => ({ slug: t.slug, text: t.term[lang] }))
      .sort((a, b) => b.text.length - a.text.length);

  const portsByLang = (lang) =>
    portsData.ports
      .map((p) => ({ slug: p.slug, text: p.name[lang] }))
      .sort((a, b) => b.text.length - a.text.length);

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Arabic letters must not sit directly against the match; Latin uses word edges
  const boundaried = (text) => {
    const AR = "\\u0621-\\u064A";
    const L = `(^|[^${AR}\\w])`;
    const R = `($|[^${AR}\\w])`;
    return new RegExp(L + "(" + escRe(text) + ")" + R);
  };

  // Walk HTML, applying fn only to text outside anchors, headings, code and attributes
  function mapTextNodes(html, fn) {
    const parts = String(html).split(/(<[^>]+>)/);
    let skip = 0;
    return parts
      .map((part) => {
        if (part.startsWith("<")) {
          if (/^<(a|h1|h2|h3|code|pre)\b/i.test(part)) skip++;
          else if (/^<\/(a|h1|h2|h3|code|pre)>/i.test(part)) skip = Math.max(0, skip - 1);
          return part;
        }
        return skip > 0 ? part : fn(part);
      })
      .join("");
  }

  // Link the first mention of each glossary term, capped so prose stays readable
  eleventyConfig.addFilter("linkTerms", function (html, lang, fromUrl, max) {
    if (!html || !lang) return html;
    const cap = max || 10;
    const used = new Set();
    let count = 0;
    let out = String(html);
    for (const term of termsByLang(lang)) {
      if (count >= cap || used.has(term.slug)) continue;
      const re = boundaried(term.text);
      let done = false;
      out = mapTextNodes(out, (text) => {
        if (done || count >= cap) return text;
        const m = re.exec(text);
        if (!m) return text;
        done = true;
        count++;
        used.add(term.slug);
        const href = relative(`/${lang}/glossary/${term.slug}/`, fromUrl);
        return (
          text.slice(0, m.index) + m[1] +
          `<a class="gterm" href="${href}">${m[2]}</a>` +
          m[3] + text.slice(m.index + m[0].length)
        );
      });
    }
    return out;
  });

  // Which glossary terms / ports does this prose mention?
  eleventyConfig.addFilter("mentionedTerms", (html, lang, max) => {
    const hits = [];
    const plain = String(html || "").replace(/<[^>]+>/g, " ");
    for (const term of termsByLang(lang)) {
      if (hits.length >= (max || 8)) break;
      if (boundaried(term.text).test(plain)) hits.push(term);
    }
    return hits;
  });
  eleventyConfig.addFilter("mentionedPorts", (html, lang, max) => {
    const hits = [];
    const plain = String(html || "").replace(/<[^>]+>/g, " ");
    for (const p of portsByLang(lang)) {
      if (hits.length >= (max || 8)) break;
      if (boundaried(p.text).test(plain)) hits.push(p);
    }
    return hits;
  });

  // Lanes that touch a given port slug
  eleventyConfig.addFilter("lanesFor", (lanes, slug, max) =>
    (lanes || []).filter((l) => l.from.slug === slug || l.to.slug === slug).slice(0, max || 6));

  // One port record by its slug
  eleventyConfig.addFilter("portBySlug", (list, slug) =>
    (list || []).find((p) => p.slug === slug) || null);

  // The free-time record for a port slug, or null when none is published yet
  eleventyConfig.addFilter("freeTimeFor", (entries, slug) =>
    (entries || []).find((e) => e.port === slug) || null);

  // Smallest and largest value at a nested key path across a list
  const atPath = (item, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), item);
  eleventyConfig.addFilter("minVal", (arr, path) =>
    Math.min(...(arr || []).map((x) => atPath(x, path)).filter((n) => typeof n === "number")));
  eleventyConfig.addFilter("maxVal", (arr, path) =>
    Math.max(...(arr || []).map((x) => atPath(x, path)).filter((n) => typeof n === "number")));

  // Every entry sharing a nested key value with the given one
  eleventyConfig.addFilter("sharing", (arr, path, value) =>
    (arr || []).filter((x) => atPath(x, path) === value));

  // Unique objects by a nested key path, keeping first occurrence
  eleventyConfig.addFilter("uniqueBy", (arr, path) => {
    const seen = new Set();
    const out = [];
    for (const item of arr || []) {
      const key = path.split(".").reduce((o, k) => (o == null ? o : o[k]), item);
      if (key == null || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  });

  // Median of a numeric array
  eleventyConfig.addFilter("median", (arr) => {
    const v = (arr || []).slice().sort((a, b) => a - b);
    if (!v.length) return 0;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
  });

  // Pluck a nested key from each item
  eleventyConfig.addFilter("pluck", (arr, path) =>
    (arr || []).map((i) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), i)));

  eleventyConfig.addFilter("maxOf", (arr) => Math.max.apply(null, arr || [0]));

  // First n items of an array
  eleventyConfig.addFilter("head", (arr, n) => (arr || []).slice(0, n));

  // Dates
  eleventyConfig.addFilter("dateISO", (d) => new Date(d).toISOString().slice(0, 10));
  eleventyConfig.addFilter("dateHuman", (d, lang) => {
    const date = new Date(d);
    return date.toLocaleDateString(lang === "ar" ? "ar-OM" : "en-GB", {
      year: "numeric", month: "long", day: "numeric", numberingSystem: lang === "ar" ? "arab" : "latn"
    });
  });

  // Reading time (Arabic ≈ 180 wpm, English ≈ 220 wpm)
  eleventyConfig.addFilter("readingTime", (content, lang) => {
    const words = (content || "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    const mins = Math.max(1, Math.round(words / (lang === "ar" ? 180 : 220)));
    return lang === "ar" ? `${mins} دقائق قراءة` : `${mins} min read`;
  });

  // Number formatting
  eleventyConfig.addFilter("num", (n, lang) =>
    Number(n).toLocaleString(lang === "ar" ? "ar-EG" : "en-US"));
  eleventyConfig.addFilter("pct", (n, lang) => {
    // Format the magnitude, then add the sign ourselves: ar-EG prefixes a negative
    // with U+061C (Arabic letter mark), which flips "-1.4%" to "1.4-%" when rendered.
    const s = Math.abs(Number(n)).toLocaleString(lang === "ar" ? "ar-EG" : "en-US", { maximumFractionDigits: 1 });
    const sign = n > 0 ? "+" : n < 0 ? "-" : "";
    return sign + s + "%";
  });

  // Sparkline SVG from an array of numbers
  eleventyConfig.addFilter("sparkline", (series, w = 120, h = 28) => {
    if (!series || series.length < 2) return "";
    const min = Math.min(...series), max = Math.max(...series);
    const span = max - min || 1;
    const pts = series.map((v, i) => {
      const x = (i / (series.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - min) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/></svg>`;
  });

  // Collections per language
  eleventyConfig.addCollection("articles_ar", (api) =>
    api.getFilteredByGlob("src/ar/articles/*.md").sort((a, b) => b.date - a.date));
  eleventyConfig.addCollection("articles_en", (api) =>
    api.getFilteredByGlob("src/en/articles/*.md").sort((a, b) => b.date - a.date));
  eleventyConfig.addCollection("ports_ar", (api) =>
    api.getFilteredByGlob("src/ar/ports/*.md").sort((a, b) => (a.data.order || 0) - (b.data.order || 0)));
  eleventyConfig.addCollection("ports_en", (api) =>
    api.getFilteredByGlob("src/en/ports/*.md").sort((a, b) => (a.data.order || 0) - (b.data.order || 0)));

  return {
    dir: { input: "src", includes: "_includes", data: "_data", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "md", "html"]
  };
};
