// Read-only. For every transcript stored in more than one project folder: each copy's size, write
// time, SHA-256, count of records carrying a timestamp, and its last timestamp; and whether the
// copies agree on every timestamped record (records without a timestamp are session state).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const projects = path.join(os.homedir(), '.claude', 'projects');

const where = new Map();
for (const d of fs.readdirSync(projects)) {
  const dir = path.join(projects, d);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    if (!where.has(id)) where.set(id, []);
    where.get(id).push(path.join(dir, f));
  }
}
const local = d => { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
function read(file) {
  const buf = fs.readFileSync(file);
  const stamped = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && typeof o.timestamp === 'string') stamped.push(line.trim());
  }
  const last = stamped.length ? JSON.parse(stamped[stamped.length - 1]).timestamp : null;
  return { file, size: buf.length, mtime: fs.statSync(file).mtime, sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16), stamped, last };
}
let n = 0;
for (const [id, files] of where) {
  if (files.length < 2) continue;
  n++;
  const copies = files.map(read);
  console.log(id);
  for (const c of copies) console.log('  ' + path.basename(path.dirname(c.file)).padEnd(72) + ' ' + String(c.size).padStart(9) + ' B  written ' + local(c.mtime) + '  sha ' + c.sha + '  stamped ' + c.stamped.length + '  last ' + c.last);
  const [a, b] = copies;
  const same = a.stamped.length === b.stamped.length && a.stamped.every((l, i) => l === b.stamped[i]);
  console.log('  timestamped records identical in both copies: ' + same + (a.sha === b.sha ? ' (files byte-identical)' : ' (files differ)'));
}
console.log('control: ' + where.size + ' session ids read, ' + n + ' stored more than once');
