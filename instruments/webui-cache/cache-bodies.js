// Read-only. Reads Chromium's blockfile HTTP cache (the Claude app's Cache_Data folder): every
// entry whose key contains a filter, its creation time, and its body (stream 1), whether the body
// sits in an external f_ file or inside a block file (data_1..data_4). Bodies are decoded by
// trying zstd, brotli, gzip and raw in turn; the encoding that worked is reported.
// Layout per net/disk_cache/blockfile/disk_format.h and addr.h: 8192-byte block-file header;
// EntryStore in 256-byte blocks of data_1: creation_time @24, key_len @32, long_key @36,
// data_size[4] @40, data_addr[4] @56, key @96.
// Modes:
//   list   <Cache_Data> <filter> [--since ISO]                      one line per entry
//   grep   <Cache_Data> <filter> [--since ISO] <needle> [<needle>...] entries whose decoded body holds a needle
//   dump   <Cache_Data> <filter> <out file> [--since ISO]           every decoded body into ONE file,
//                                                                   each preceded by "//@@@ <created> <url>"
//   one    <Cache_Data> <exact url suffix> <out file>               one decoded body to one file
//   headers <Cache_Data> <exact url suffix>                         the response headers of the last two
//                                                                   entries ending so, and the stored
//                                                                   endpoint (a proxy's address when one
//                                                                   carried the response) and certificate
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const mode = args.shift();
const cacheDir = args.shift();
let since = null;
const si = args.indexOf('--since');
if (si >= 0) { since = Date.parse(args[si + 1]); args.splice(si, 2); }
if (!mode || !cacheDir) { console.error('usage: see header'); process.exit(2); }

const files = {};
function blockFile(n) {
  if (!files[n]) files[n] = fs.readFileSync(path.join(cacheDir, 'data_' + n));
  return files[n];
}
const BLOCK_SIZE = { 1: 36, 2: 256, 3: 1024, 4: 4096, 5: 8, 6: 104, 7: 48 };

function readAddr(addr, size) {
  if ((addr & 0x80000000) === 0 || size <= 0) return null;
  const type = (addr >>> 28) & 0x7;
  if (type === 0) {
    const name = 'f_' + (addr & 0x0fffffff).toString(16).padStart(6, '0');
    try { return { where: name, buf: fs.readFileSync(path.join(cacheDir, name)).subarray(0, size) }; }
    catch (e) { return { where: name + ' (unreadable: ' + e.code + ')', buf: null }; }
  }
  const fileNo = (addr >>> 16) & 0xff, start = addr & 0xffff, blocks = ((addr >>> 24) & 0x3) + 1;
  const bs = BLOCK_SIZE[type];
  const f = blockFile(fileNo);
  const off = 8192 + start * bs;
  if (size > blocks * bs) return { where: `data_${fileNo}[${start}x${blocks}] (size ${size} exceeds blocks)`, buf: null };
  return { where: `data_${fileNo}[${start}x${blocks}]`, buf: f.subarray(off, off + size) };
}

function decode(buf) {
  const tries = [];
  if (typeof zlib.zstdDecompressSync === 'function') tries.push(['zstd', () => zlib.zstdDecompressSync(buf)]);
  tries.push(['br', () => zlib.brotliDecompressSync(buf)], ['gzip', () => zlib.gunzipSync(buf)]);
  for (const [n, fn] of tries) { try { return [n, fn().toString('utf8')]; } catch (_) {} }
  return ['raw', buf.toString('utf8')];
}

function entries(filter) {
  const d1 = blockFile(1);
  const out = [];
  for (let off = 8192; off + 256 <= d1.length; off += 256) {
    const keyLen = d1.readInt32LE(off + 32);
    if (keyLen <= 0 || keyLen > 8192) continue;
    const longKey = d1.readUInt32LE(off + 36);
    let key;
    if (longKey & 0x80000000) {
      const r = readAddr(longKey, keyLen);
      if (!r || !r.buf) continue;
      key = r.buf.toString('latin1');
    } else {
      if (off + 96 + keyLen > d1.length) continue;
      key = d1.toString('latin1', off + 96, off + 96 + keyLen);
    }
    if (!/^[\x20-\x7e]+$/.test(key)) continue;
    if (!key.includes(filter)) continue;
    const created = Number(d1.readBigUInt64LE(off + 24) / 1000n) - 11644473600000;
    if (since !== null && created < since) continue;
    const size = d1.readInt32LE(off + 44), addr = d1.readUInt32LE(off + 60);
    const hsize = d1.readInt32LE(off + 40), haddr = d1.readUInt32LE(off + 56);
    const url = key.slice(Math.max(0, key.lastIndexOf(' https://') + 1));
    out.push({ off, key, url, created, size, addr, hsize, haddr });
  }
  out.sort((a, b) => a.created - b.created);
  return out;
}

function body(e) {
  const r = readAddr(e.addr, e.size);
  if (!r || !r.buf) return { where: r ? r.where : '(no body)', enc: null, text: null };
  const [enc, text] = decode(r.buf);
  return { where: r.where, enc, text };
}

const iso = ms => new Date(ms).toISOString();
if (mode === 'list') {
  const es = entries(args[0]);
  for (const e of es) {
    const r = readAddr(e.addr, e.size);
    console.log(`${iso(e.created)}\t${e.size}\t${r ? r.where : '(no body)'}\t${e.url}`);
  }
  console.log(`control: ${es.length} entries matched`);
} else if (mode === 'grep') {
  const [filter, ...needles] = args;
  const es = entries(filter);
  let decoded = 0, failed = 0, hits = 0;
  for (const e of es) {
    const b = body(e);
    if (b.text === null) { failed++; continue; }
    decoded++;
    const found = needles.filter(n => b.text.includes(n));
    if (found.length) { hits++; console.log(`${iso(e.created)}\t${b.enc}\t${b.text.length}\t${b.where}\t${e.url}\t[${found.join(' | ')}]`); }
  }
  console.log(`control: ${es.length} entries, ${decoded} bodies read, ${failed} without a readable body, ${hits} hold a needle`);
} else if (mode === 'dump') {
  const [filter, outFile] = args;
  const es = entries(filter);
  const fd = fs.openSync(outFile, 'w');
  let n = 0, bytes = 0;
  for (const e of es) {
    const b = body(e);
    if (b.text === null) continue;
    fs.writeSync(fd, `\n//@@@ ${iso(e.created)} ${b.enc} ${e.url}\n`);
    fs.writeSync(fd, b.text);
    n++; bytes += b.text.length;
  }
  fs.closeSync(fd);
  console.log(`control: ${n} of ${es.length} bodies written, ${bytes} characters, to ${outFile}`);
} else if (mode === 'one') {
  const [suffix, outFile] = args;
  const es = entries('').filter(e => e.url.endsWith(suffix));
  if (es.length === 0) { console.log('no entry ends with ' + suffix); process.exit(1); }
  const e = es[es.length - 1];
  const b = body(e);
  if (b.text === null) { console.log('no readable body: ' + b.where); process.exit(1); }
  fs.writeFileSync(outFile, b.text);
  console.log(`control: ${es.length} entr(ies) end with that; wrote the newest (${iso(e.created)}, ${b.enc}, ${b.text.length} chars, ${b.where}) to ${outFile}`);
} else if (mode === 'headers') {
  // Stream 0 is the pickled HttpResponseInfo: the response headers, NUL-separated, then fields such
  // as the remote endpoint the response came from. Printed as its printable runs, and the raw
  // bytes of its tail in hex, so the endpoint can be read.
  const [suffix] = args;
  const es = entries('').filter(e => e.url.endsWith(suffix));
  for (const e of es.slice(-2)) {
    const r = readAddr(e.haddr, e.hsize);
    console.log(`=== ${iso(e.created)} ${e.url} (stream 0: ${e.hsize} bytes at ${r ? r.where : '-'})`);
    if (!r || !r.buf) continue;
    console.log(r.buf.toString('latin1').replace(/[^\x20-\x7e]+/g, ' | '));
    console.log('tail hex: ' + r.buf.subarray(Math.max(0, r.buf.length - 96)).toString('hex'));
  }
} else { console.error('unknown mode ' + mode); process.exit(2); }
