// Read-only. How far is each transcript's last write time from the time of its last timestamped
// record? A sidebar entry dated from its transcript file's times is off by exactly that much, and
// the sidebar orders chats by those dates.
// Usage: node measure-file-times.js --receiving <account uuid> [--source <account uuid>] [--profile <dir>]
//   --receiving  the account folder under claude-code-sessions that would receive new entries
//   --source     another account folder; counts how many of those chats have an entry there
//   --profile    a user profile or sandbox profile (default: the current user's)
const fs = require('fs');
const path = require('path');
const os = require('os');

function arg(name) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; }
function storeRoot(profile) {
  const pk = path.join(profile, 'AppData', 'Local', 'Packages');
  const hits = fs.readdirSync(pk).filter(n => n.startsWith('Claude_') && fs.existsSync(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')));
  if (hits.length !== 1) throw new Error('expected exactly one Claude_* store under ' + pk + ', found ' + hits.length);
  return path.join(pk, hits[0], 'LocalCache', 'Roaming', 'Claude');
}
// An account switch can leave an org folder holding no entries, so the account's org is the one
// holding the most entries.
function mainOrg(accountDir) {
  let best = null, most = -1;
  for (const o of fs.readdirSync(accountDir)) {
    const p = path.join(accountDir, o);
    if (!fs.statSync(p).isDirectory()) continue;
    const n = fs.readdirSync(p).filter(f => /^local_.*\.json$/.test(f)).length;
    if (n > most) { most = n; best = p; }
  }
  if (!best) throw new Error('no org folder under ' + accountDir);
  return best;
}
function index(dir) {
  const m = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!/^local_.*\.json$/.test(f)) continue;
    try { const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (e.cliSessionId) m.set(e.cliSessionId, e); } catch { }
  }
  return m;
}
function lastRecordTime(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let take = Math.min(size, 262144);
    for (;;) {
      const b = Buffer.alloc(take);
      fs.readSync(fd, b, 0, take, size - take);
      const hits = [...b.toString('utf8').matchAll(/"timestamp":"([^"]+)"/g)];
      if (hits.length) return Date.parse(hits[hits.length - 1][1]);
      if (take >= size) return null;
      take = Math.min(size, take * 4);
    }
  } finally { fs.closeSync(fd); }
}
const minute = ms => {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};
function top(map, n) { return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n); }

const profile = arg('profile') || os.homedir();
const receiving = arg('receiving');
if (!receiving) { console.error('usage: node measure-file-times.js --receiving <account uuid> [--source <account uuid>] [--profile <dir>]'); process.exit(2); }
const sessions = path.join(storeRoot(profile), 'claude-code-sessions');
const recvDir = mainOrg(path.join(sessions, receiving));
const recv = index(recvDir);
const src = arg('source') ? index(mainOrg(path.join(sessions, arg('source')))) : null;
console.log('receiving entries: ' + recv.size + ' in ' + recvDir);

const projects = path.join(profile, '.claude', 'projects');
const transcripts = [];
for (const d of fs.readdirSync(projects)) {
  const p = path.join(projects, d);
  if (!fs.statSync(p).isDirectory()) continue;
  for (const f of fs.readdirSync(p)) if (f.endsWith('.jsonl')) transcripts.push(path.join(p, f));
}
const all = new Map();
for (const f of transcripts) { const k = minute(fs.statSync(f).mtimeMs); all.set(k, (all.get(k) || 0) + 1); }
console.log('transcripts (the .jsonl files directly inside each project folder): ' + transcripts.length);
console.log('most common last-write minutes among all of them:');
for (const [k, v] of top(all, 6)) console.log('  ' + String(v).padStart(4) + ' at ' + k);

let lacking = 0, inSource = 0, noRecord = 0, over1h = 0, over1d = 0;
const lackingMinutes = new Map(), examples = [];
for (const f of transcripts) {
  const cli = path.basename(f, '.jsonl');
  if (recv.has(cli)) continue;
  lacking++;
  if (src && src.has(cli)) inSource++;
  const mtime = fs.statSync(f).mtimeMs;
  const k = minute(mtime);
  lackingMinutes.set(k, (lackingMinutes.get(k) || 0) + 1);
  const last = lastRecordTime(f);
  if (last == null) { noRecord++; continue; }
  const off = Math.abs(mtime - last);
  if (off > 3600e3) over1h++;
  if (off > 86400e3) { over1d++; if (examples.length < 4) examples.push(cli.slice(0, 8) + ' written ' + k + ', last record ' + minute(last)); }
}
console.log('transcripts the receiving account has no entry for: ' + lacking +
            (src ? ' | of them with an entry in the source account: ' + inSource : '') +
            ' | with no timestamped record: ' + noRecord);
console.log('last write time more than 1 hour from the last record: ' + over1h + ' | more than 1 day: ' + over1d);
console.log('most common last-write minutes among them:');
for (const [k, v] of top(lackingMinutes, 6)) console.log('  ' + String(v).padStart(4) + ' at ' + k);
for (const e of examples) console.log('  e.g. ' + e);
