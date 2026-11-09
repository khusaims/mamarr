// الموانئ التي تُولَّد صفحاتها من ports.json — أي ما عدا الموانئ التي لها صفحة تفصيلية مكتوبة بصيغة md.
const ports = require("./ports.json");
module.exports = ports.ports.filter((p) => !p.detailed);
