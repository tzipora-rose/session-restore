// Read-only. For the Code sessions under one account folder of the desktop app's
// claude-code-sessions store: each session's creation time, whether another session started it,
// the effort its entry file holds now, and, from its transcript, the effort Claude Code recorded on
// its reply records: the first and the last (the default), or every change (--changes).
// --only <level> keeps the sessions that ever ran at that level. The folder an entry sits in does not
// say which account ran the session when a tool gives one chat an entry under several accounts;
// org-timeline.js, beside this file, does. Transcripts are read with fs.readFileSync, which shares
// them for writing.
// Usage: node session-efforts.js <account folder\organization folder> <transcripts folder>
//          [--since ISO time] [--changes] [--only low|medium|high|xhigh|max]
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let since = 0, only = null, changesMode = false;
let i = args.indexOf('--since'); if (i >= 0) { since = Date.parse(args[i + 1]); args.splice(i, 2); }
i = args.indexOf('--only'); if (i >= 0) { only = args[i + 1]; args.splice(i, 2); }
i = args.indexOf('--changes'); if (i >= 0) { changesMode = true; args.splice(i, 1); }
const [entryDir, trDir] = args;
if (!entryDir || !trDir || Number.isNaN(since)) { console.error('usage: see header'); process.exit(2); }
const fmt = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const rows = [];
let entries = 0, withTranscript = 0;
for (const f of fs.readdirSync(entryDir)) {
  if (!/^local_.*\.json$/.test(f)) continue;
  let e; try { e = JSON.parse(fs.readFileSync(path.join(entryDir, f), 'utf8')); } catch (_) { continue; }
  if ((e.lastActivityAt || e.createdAt || 0) < since) continue;
  entries++;
  const changes = []; let prev = null, n = 0;
  const tr = e.cliSessionId ? path.join(trDir, e.cliSessionId + '.jsonl') : null;
  if (tr && fs.existsSync(tr)) {
    withTranscript++;
    for (const line of fs.readFileSync(tr, 'utf8').split('\n')) {
      if (!line.includes('"effort"')) continue;
      let r; try { r = JSON.parse(line); } catch (_) { continue; }
      if (r.effort === undefined) continue;
      n++;
      const v = r.effort + (r.perTurnEffort !== undefined && r.perTurnEffort !== r.effort ? '/' + r.perTurnEffort : '');
      if (v !== prev) { changes.push({ at: Date.parse(r.timestamp), v }); prev = v; }
    }
  }
  if (only && !changes.some(c => c.v.split('/').includes(only))) continue;
  rows.push({ e, changes, n });
}
rows.sort((a, b) => (a.e.createdAt || 0) - (b.e.createdAt || 0));
for (const { e, changes, n } of rows) {
  const head = `${fmt(e.createdAt)}  ${String(e.sessionId).slice(0, 14)}  ${(e.spawnedFrom ? 'started by ' + String(e.spawnedFrom.sessionId).slice(0, 14) : 'by hand').padEnd(28)}  entry=${String(e.effort).padEnd(7)}`;
  if (changesMode) console.log(`${head}  ${changes.map(c => `${fmt(c.at)} ${c.v}`).join('  ->  ') || '(no reply record carries an effort)'}`);
  else {
    const first = changes[0], last = changes[changes.length - 1];
    console.log(`${head}  first=${String(first ? first.v : null).padEnd(7)} (${first ? fmt(first.at) : ''})  last=${String(last ? last.v : null).padEnd(7)} records=${n}${e.isArchived ? '  archived' : ''}`);
  }
}
console.log(`control: ${entries} entries active since ${new Date(since).toISOString()}, ${withTranscript} with a transcript, ${rows.length} shown`);
