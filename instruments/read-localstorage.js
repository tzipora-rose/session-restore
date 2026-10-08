// Read-only probe: decode Chromium "Local Storage/leveldb" (a COPY of it) and print the
// newest value of each requested localStorage key. Implements just enough of LevelDB
// (log records + SSTable blocks) and Snappy to do that.
// Usage: node read-localstorage.js <leveldb dir copy> <origin> <key> [<key> ...]
const fs = require('fs');
const path = require('path');

const [dir, origin, ...wanted] = process.argv.slice(2);
if (!dir || !origin || wanted.length === 0) {
  console.error('usage: node read-localstorage.js <leveldb dir> <origin> <key> [...]');
  process.exit(2);
}

function varint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

function snappyDecompress(src) {
  let [len, pos] = varint(src, 0);
  const out = Buffer.alloc(len);
  let op = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const type = tag & 3;
    if (type === 0) {
      let l = tag >>> 2;
      if (l >= 60) {
        const nb = l - 59;
        l = 0;
        for (let i = 0; i < nb; i++) l |= src[pos + i] << (8 * i);
        pos += nb;
      }
      l += 1;
      src.copy(out, op, pos, pos + l);
      pos += l; op += l;
    } else {
      let l, off;
      if (type === 1) { l = 4 + ((tag >>> 2) & 7); off = ((tag >>> 5) << 8) | src[pos++]; }
      else if (type === 2) { l = 1 + (tag >>> 2); off = src.readUInt16LE(pos); pos += 2; }
      else { l = 1 + (tag >>> 2); off = src.readUInt32LE(pos); pos += 4; }
      for (let i = 0; i < l; i++) { out[op] = out[op - off]; op++; }
    }
  }
  return out;
}

function readBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size);
  const kind = file[offset + size];
  return kind === 1 ? snappyDecompress(raw) : raw;
}

function blockEntries(block) {
  const numRestarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - numRestarts * 4;
  const entries = [];
  let pos = 0, lastKey = Buffer.alloc(0);
  while (pos < end) {
    let shared, nonShared, valLen;
    [shared, pos] = varint(block, pos);
    [nonShared, pos] = varint(block, pos);
    [valLen, pos] = varint(block, pos);
    const key = Buffer.concat([lastKey.subarray(0, shared), block.subarray(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.subarray(pos, pos + valLen);
    pos += valLen;
    entries.push([key, value]);
    lastKey = key;
  }
  return entries;
}

const found = new Map(); // key -> {seq, deleted, value, source}
function consider(userKey, seq, deleted, value, source) {
  const prev = found.get(userKey);
  if (!prev || seq > prev.seq) found.set(userKey, { seq, deleted, value, source });
}

const prefix = Buffer.concat([Buffer.from('_' + origin, 'latin1'), Buffer.from([0, 1])]);
function lsKeyOf(userKeyBuf) {
  if (userKeyBuf.length < prefix.length || !userKeyBuf.subarray(0, prefix.length).equals(prefix)) return null;
  return userKeyBuf.subarray(prefix.length).toString('latin1');
}

function readTable(file, name) {
  const footer = file.subarray(file.length - 48);
  let pos = 0, metaOff, metaSize, idxOff, idxSize;
  [metaOff, pos] = varint(footer, pos); [metaSize, pos] = varint(footer, pos);
  [idxOff, pos] = varint(footer, pos); [idxSize, pos] = varint(footer, pos);
  for (const [, handle] of blockEntries(readBlock(file, idxOff, idxSize))) {
    let p = 0, off, size;
    [off, p] = varint(handle, p); [size, p] = varint(handle, p);
    for (const [ikey, value] of blockEntries(readBlock(file, off, size))) {
      const userKey = ikey.subarray(0, ikey.length - 8);
      const trailer = ikey.readBigUInt64LE(ikey.length - 8);
      const k = lsKeyOf(userKey);
      if (k !== null && wanted.includes(k)) consider(k, Number(trailer >> 8n), Number(trailer & 0xffn) === 0, Buffer.from(value), name);
    }
  }
}

function readLog(file, name) {
  const BLOCK = 32768;
  let pos = 0, pending = [];
  const records = [];
  while (pos + 7 <= file.length) {
    const blockLeft = BLOCK - (pos % BLOCK);
    if (blockLeft < 7) { pos += blockLeft; continue; }
    const len = file.readUInt16LE(pos + 4), type = file[pos + 6];
    if (type === 0 && len === 0) { pos += blockLeft; continue; }
    const data = file.subarray(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 1) records.push(Buffer.from(data));
    else if (type === 2) pending = [Buffer.from(data)];
    else if (type === 3) pending.push(Buffer.from(data));
    else if (type === 4) { pending.push(Buffer.from(data)); records.push(Buffer.concat(pending)); pending = []; }
  }
  for (const rec of records) {
    if (rec.length < 12) continue;
    let seq = Number(rec.readBigUInt64LE(0));
    const count = rec.readUInt32LE(8);
    let p = 12;
    for (let i = 0; i < count && p < rec.length; i++, seq++) {
      const t = rec[p++];
      let kl; [kl, p] = varint(rec, p);
      const key = rec.subarray(p, p + kl); p += kl;
      let value = null;
      if (t === 1) { let vl; [vl, p] = varint(rec, p); value = Buffer.from(rec.subarray(p, p + vl)); p += vl; }
      const k = lsKeyOf(key);
      if (k !== null && wanted.includes(k)) consider(k, seq, t === 0, value, name);
    }
  }
}

for (const name of fs.readdirSync(dir)) {
  const full = path.join(dir, name);
  try {
    if (name.endsWith('.ldb')) readTable(fs.readFileSync(full), name);
    else if (name.endsWith('.log')) readLog(fs.readFileSync(full), name);
  } catch (e) {
    console.error(`could not read ${name}: ${e.message}`);
  }
}

function decodeValue(buf) {
  if (!buf || buf.length === 0) return '';
  return buf[0] === 0 ? buf.subarray(1).toString('utf16le') : buf.subarray(1).toString('latin1');
}

for (const k of wanted) {
  const f = found.get(k);
  if (!f) { console.log(`=== ${k}: NOT FOUND`); continue; }
  console.log(`=== ${k}: seq=${f.seq} source=${f.source} ${f.deleted ? 'DELETED' : ''}`);
  if (!f.deleted) console.log(decodeValue(f.value));
}
