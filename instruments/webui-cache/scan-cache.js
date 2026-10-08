// Read-only probe: decode every body in the app's HTTP cache folder and report which
// ones contain the given needles. Decoded matches are written to the output folder.
// Usage: node scan-cache.js <Cache_Data dir> <out dir> <needle> [<needle> ...]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [cacheDir, outDir, ...needles] = process.argv.slice(2);
if (!cacheDir || !outDir || needles.length === 0) {
  console.error('usage: node scan-cache.js <Cache_Data dir> <out dir> <needle> [...]');
  process.exit(2);
}

function decodings(buf) {
  const out = [['raw', buf]];
  const tries = [
    ['br', () => zlib.brotliDecompressSync(buf)],
    ['gzip', () => zlib.gunzipSync(buf)],
    ['deflate', () => zlib.inflateSync(buf)],
    ['deflate-raw', () => zlib.inflateRawSync(buf)],
  ];
  if (typeof zlib.zstdDecompressSync === 'function') tries.push(['zstd', () => zlib.zstdDecompressSync(buf)]);
  for (const [name, fn] of tries) {
    try { out.push([name, fn()]); } catch (_) { /* not this encoding */ }
  }
  return out;
}

let scanned = 0, hits = 0;
for (const name of fs.readdirSync(cacheDir)) {
  if (!name.startsWith('f_')) continue;
  const full = path.join(cacheDir, name);
  let buf;
  try { buf = fs.readFileSync(full); } catch (e) { console.log(`unreadable ${name}: ${e.message}`); continue; }
  scanned++;
  for (const [enc, data] of decodings(buf)) {
    const text = data.toString('utf8');
    const found = needles.filter(n => text.includes(n));
    if (found.length) {
      hits++;
      const outFile = path.join(outDir, `${name}.${enc}.js`);
      fs.writeFileSync(outFile, text);
      console.log(`${name}  enc=${enc}  bytes=${data.length}  found=[${found.join(', ')}]  -> ${outFile}`);
      break;
    }
  }
}
console.log(`scanned ${scanned} f_ files, ${hits} matched`);
