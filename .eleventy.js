// ممرّ — Eleventy configuration
// Build:          npm run build          → _site/      (clean URLs, for Netlify / GitHub Pages / any host)
// Preview build:  npm run build:preview  → _preview/   (links end in index.html, for hosts without directory index)

const PREVIEW = !!process.env.PREVIEW;

module.exports = function (eleventyConfig) {
  // Static assets copied as-is
  eleventyConfig.addPassthroughCopy({ "src/css": "css" });
  eleventyConfig.addPassthroughCopy({ "src/img": "img" });

  // Relative link from the current page to a root-absolute target.
  // Lets the same build work at a domain root, in a sub-folder, or as a hosted preview.
  eleventyConfig.addFilter("rel", (target, from) => {
    if (!target) return "#";
    if (/^(https?:)?\/\//.test(target) || target.startsWith("#") || target.startsWith("mailto:")) return target;
    const fromDir = from.endsWith("/") ? from : from.slice(0, from.lastIndexOf("/") + 1);
    const depth = fromDir.split("/").filter(Boolean).length;
    const prefix = depth ? "../".repeat(depth) : "./";
    let t = target.replace(/^\//, "");
    if (PREVIEW && (t === "" || t.endsWith("/"))) t += "index.html";
    return prefix + t;
  });

  // Swap language prefix: /ar/x/ ↔ /en/x/
  eleventyConfig.addFilter("altLang", (url) => {
    if (url.startsWith("/ar/")) return "/en/" + url.slice(4);
    if (url.startsWith("/en/")) return "/ar/" + url.slice(4);
    return url;
  });

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
    const s = Number(n).toLocaleString(lang === "ar" ? "ar-EG" : "en-US", { maximumFractionDigits: 1 });
    return (n > 0 ? "+" : "") + s + "%";
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
