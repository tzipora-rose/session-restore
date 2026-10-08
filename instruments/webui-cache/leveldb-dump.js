// Read-only. Reads a LevelDB folder (Chromium's Local Storage or IndexedDB) without opening it as a
// database: every table file (.ldb, Snappy blocks decoded here) and the write-ahead log (.log),
// keeping for each key the entry with the highest sequence number, so the result is the store's
// current contents. Files are read with fs.readFileSync, which shares them for writing.
// Formats: leveldb/doc/table_format.md and log_format.md; Snappy per its format_description.txt.
// For Chromium Local Storage, a key is "_" + origin + "\0" + (\x01 + Latin-1 | \x00 + UTF-16LE),
// and a value is \x01 + Latin-1 or \x00 + UTF-16LE.
// --all-versions prints every version of each matching key still held in the files, deletions
// included, oldest first: values a later write replaced, such as earlier states of a queue.
// Usage: node leveldb-dump.js <folder> [--key-filter text] [--value-filter text] [--max-value N] [--raw] [--all-versions]
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const keyFilter = opt('--key-filter', null), valueFilter = opt('--value-filter', null);
const maxValue = Number(opt('--max-value', 600));
const rawMode = args.includes('--raw'); if (rawMode) args.splice(args.indexOf('--raw'), 1);
const dir = args[0];

function varint(buf, pos) { let r = 0, shift = 0, b; do { b = buf[pos++]; r += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return [r, pos]; }

function snappy(src) {
  let [len, p] = varint(src, 0);
  const out = Buffer.alloc(len); let o = 0;
  while (p < src.length) {
    const tag = src[p++], t = tag & 3;
    if (t === 0) {
      let l = tag >> 2;
      if (l >= 60) { const nb = l - 59; l = 0; for (let k = 0; k < nb; k++) l |= src[p++] << (8 * k); }
      l += 1; src.copy(out, o, p, p + l); o += l; p += l;
    } else {
      let l, off;
      if (t === 1) { l = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; }
      else if (t === 2) { l = (tag >> 2) + 1; off = src.readUInt16LE(p); p += 2; }
      else { l = (tag >> 2) + 1; off = src.readUInt32LE(p); p += 4; }
      for (let k = 0; k < l; k++) { out[o] = out[o - off]; o++; }
    }
  }
  if (o !== len) throw new Error(`snappy: wrote ${o} of ${len}`);
  return out;
}

function readBlock(buf, off, size) {
  const data = buf.subarray(off, off + size), type = buf[off + size];
  if (type === 0) return data;
  if (type === 1) return snappy(data);
  throw new Error('unknown block compression ' + type);
}

function blockEntries(block, cb) {
  const nRestarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - nRestarts * 4;
  let p = 0, last = Buffer.alloc(0);
  while (p < end) {
    let shared, nonShared, vlen;
    [shared, p] = varint(block, p); [nonShared, p] = varint(block, p); [vlen, p] = varint(block, p);
    const key = Buffer.concat([last.subarray(0, shared), block.subarray(p, p + nonShared)]); p += nonShared;
    const val = block.subarray(p, p + vlen); p += vlen;
    cb(key, val); last = key;
  }
}

const allVersions = args.includes('--all-versions'); if (allVersions) args.splice(args.indexOf('--all-versions'), 1);
const latest = new Map();
const versions = [];
let tableEntries = 0, logRecords = 0, problems = [];
function put(key, seq, type, val) {
  const k = key.toString('latin1');
  if (allVersions) versions.push({ key, seq, type, val });
  const cur = latest.get(k);
  if (!cur || cur.seq < seq) latest.set(k, { key, seq, type, val });
}

for (const f of fs.readdirSync(dir)) {
  const full = path.join(dir, f);
  if (f.endsWith('.ldb') || f.endsWith('.sst')) {
    try {
      const buf = fs.readFileSync(full);
      const foot = buf.subarray(buf.length - 48);
      let p = 0, mo, ms, io, is;
      [mo, p] = varint(foot, p); [ms, p] = varint(foot, p); [io, p] = varint(foot, p); [is, p] = varint(foot, p);
      const index = readBlock(buf, io, is);
      blockEntries(index, (k, v) => {
        let q = 0, bo, bs; [bo, q] = varint(v, q); [bs, q] = varint(v, q);
        const block = readBlock(buf, bo, bs);
        blockEntries(block, (ik, val) => {
          tableEntries++;
          const user = ik.subarray(0, ik.length - 8);
          const tag = ik.readBigUInt64LE(ik.length - 8);
          put(user, Number(tag >> 8n), Number(tag & 0xffn), val);
        });
      });
    } catch (e) { problems.push(`${f}: ${e.message}`); }
  } else if (f.endsWith('.log') && /^\d+\.log$/.test(f)) {
    try {
      const buf = fs.readFileSync(full);
      let p = 0, pending = [];
      const batches = [];
      while (p + 7 <= buf.length) {
        const blockLeft = 32768 - (p % 32768);
        if (blockLeft < 7) { p += blockLeft; continue; }
        const len = buf.readUInt16LE(p + 4), type = buf[p + 6];
        if (type === 0 && len === 0) { p += blockLeft; continue; }
        const data = buf.subarray(p + 7, p + 7 + len); p += 7 + len;
        if (type === 1) batches.push(data);
        else if (type === 2) pending = [data];
        else if (type === 3) pending.push(data);
        else if (type === 4) { pending.push(data); batches.push(Buffer.concat(pending)); pending = []; }
      }
      for (const b of batches) {
        let seq = Number(b.readBigUInt64LE(0)); const count = b.readUInt32LE(8); let q = 12;
        for (let n = 0; n < count && q < b.length; n++) {
          const t = b[q++]; let kl, vl;
          [kl, q] = varint(b, q); const key = b.subarray(q, q + kl); q += kl;
          let val = Buffer.alloc(0);
          if (t === 1) { [vl, q] = varint(b, q); val = b.subarray(q, q + vl); q += vl; }
          logRecords++; put(key, seq++, t, val);
        }
      }
    } catch (e) { problems.push(`${f}: ${e.message}`); }
  }
}

function decodeLsString(b) {
  if (b.length === 0) return '';
  if (b[0] === 1) return b.subarray(1).toString('latin1');
  if (b[0] === 0) return b.subarray(1).toString('utf16le');
  return null;
}
function show(b) {
  if (rawMode) return b.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  const s = decodeLsString(b);
  return s === null ? b.toString('latin1').replace(/[^\x20-\x7e]/g, '.') : s;
}
let shown = 0, live = 0;
const rows = allVersions ? versions.sort((a, b) => a.seq - b.seq) : [...latest.values()].filter(r => r.type === 1);
for (const r of rows) {
  live++;
  if (allVersions && r.type !== 1) { const ks = r.key.toString('latin1').replace(/[^\x20-\x7e]/g, '.'); if (!keyFilter || ks.includes(keyFilter)) console.log(`seq ${r.seq}  (deleted) ${ks}`); continue; }
  let k;
  const ks = r.key.toString('latin1');
  const nul = ks.indexOf('\x00');
  if (ks.startsWith('_') && nul > 0) k = ks.slice(1, nul) + ' :: ' + show(r.key.subarray(nul + 1));
  else k = ks.replace(/[^\x20-\x7e]/g, '.');
  const v = show(r.val);
  if (keyFilter && !k.includes(keyFilter)) continue;
  if (valueFilter && !v.includes(valueFilter)) continue;
  shown++;
  console.log(`seq ${r.seq}  ${k}\n    = ${v.length > maxValue ? v.slice(0, maxValue) + ` …[${v.length} chars]` : v}`);
}
console.log(`control: ${tableEntries} table entries and ${logRecords} log records read, ${latest.size} keys, ${live} live, ${shown} shown${problems.length ? '; problems: ' + problems.join('; ') : ''}`);
