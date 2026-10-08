// Read-only probe: decode every cached body written at or after a given time (one web
// build), save each decoded JS file, and print which ones export all of the given names.
// Usage: node decode-build.js <Cache_Data dir> <out dir> <ISO start time> <name,name,...> [<name,name,...> ...]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [cacheDir, outDir, since, ...nameSets] = process.argv.slice(2);
const sinceMs = Date.parse(since);
if (!cacheDir || !outDir || Number.isNaN(sinceMs) || nameSets.length === 0) {
  console.error('usage: node decode-build.js <Cache_Data dir> <out dir> <ISO time> <names,...> [...]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

function decode(buf) {
  const tries = [() => zlib.zstdDecompressSync(buf), () => zlib.brotliDecompressSync(buf), () => zlib.gunzipSync(buf)];
  for (const t of tries) { try { return t().toString('utf8'); } catch (_) {} }
  return null;
}

// "export{a as b,c as d}" -> Map(exportedName -> localName)
function exportMap(text) {
  const m = text.match(/export\{([^}]*)\}\s*;?\s*(\/\/[^\n]*)?\s*$/);
  const map = new Map();
  if (!m) return map;
  for (const part of m[1].split(',')) {
    const [local, exported] = part.split(' as ').map(s => s.trim());
    map.set(exported ?? local, local);
  }
  return map;
}

const results = [];
for (const name of fs.readdirSync(cacheDir)) {
  if (!name.startsWith('f_')) continue;
  const full = path.join(cacheDir, name);
  const st = fs.statSync(full);
  if (st.mtimeMs < sinceMs) continue;
  const text = decode(fs.readFileSync(full));
  if (text === null) continue;
  fs.writeFileSync(path.join(outDir, name + '.js'), text);
  results.push({ name, text, exports: exportMap(text) });
}
console.log(`decoded ${results.length} bodies cached since ${since}`);
for (const set of nameSets) {
  const names = set.split(',');
  const hits = results.filter(r => names.every(n => r.exports.has(n)));
  console.log(`\nexports [${names.join(', ')}]:`);
  for (const h of hits) console.log(`  ${h.name}  ` + names.map(n => `${n}=${h.exports.get(n)}`).join('  '));
  if (hits.length === 0) console.log('  (none)');
}
