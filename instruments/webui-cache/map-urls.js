// Read-only probe: parse Chromium's blockfile cache entry file (data_1) and print which
// external f_ file holds the body (stream 1) of each cached URL matching a filter.
// Layout per net/disk_cache/blockfile/disk_format.h: 8192-byte block-file header, then
// 256-byte EntryStore blocks; key_len @32, data_addr[4] @56, inline key @96.
// Usage: node map-urls.js <Cache_Data dir> <substring> [<substring> ...]
const fs = require('fs');
const path = require('path');

const [cacheDir, ...filters] = process.argv.slice(2);
if (!cacheDir || filters.length === 0) {
  console.error('usage: node map-urls.js <Cache_Data dir> <substring> [...]');
  process.exit(2);
}
const buf = fs.readFileSync(path.join(cacheDir, 'data_1'));
const HEADER = 8192, BLOCK = 256;

function describeAddr(addr) {
  if ((addr & 0x80000000) === 0) return null;
  const type = (addr >>> 28) & 0x7;
  if (type === 0) return 'f_' + (addr & 0x0fffffff).toString(16).padStart(6, '0');
  const file = (addr >>> 16) & 0xff, start = addr & 0xffff, blocks = ((addr >>> 24) & 0x3) + 1;
  return `data_${file}[block ${start} x${blocks}] (type ${type})`;
}

for (let off = HEADER; off + BLOCK <= buf.length; off += BLOCK) {
  const keyLen = buf.readInt32LE(off + 32);
  if (keyLen <= 0 || keyLen > 4096) continue;
  const avail = Math.min(keyLen, buf.length - (off + 96));
  const key = buf.toString('latin1', off + 96, off + 96 + avail);
  if (!/^[\x20-\x7e]+$/.test(key.slice(0, Math.min(key.length, 40)))) continue;
  if (!filters.some(f => key.includes(f))) continue;
  const bodyAddr = buf.readUInt32LE(off + 56 + 4);
  const bodySize = buf.readInt32LE(off + 40 + 4);
  const created = buf.readBigUInt64LE(off + 24);
  // Chromium time: microseconds since 1601-01-01
  const ms = Number(created / 1000n) - 11644473600000;
  console.log(`${describeAddr(bodyAddr) ?? '(no body)'}\tsize=${bodySize}\tcreated=${new Date(ms).toISOString()}\t${key}`);
}
