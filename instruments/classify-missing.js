// Read-only. For the receiving account, lists every top-level transcript it has no entry for (the
// ones session-restore would create entries for) and classifies each: an earlier transcript of a
// chat the receiving account already lists (named in one of its entries' priorCliSessionIds); an
// earlier transcript of a chat only another account lists; a chat another account lists under this
// transcript (a twin); or named by no entry at all.
// Usage: node classify-missing.js <receiving account uuid>
const fs = require('fs');
const path = require('path');
const os = require('os');
const recv = process.argv[2];
const pk = path.join(os.homedir(), 'AppData', 'Local', 'Packages');
const store = fs.readdirSync(pk).find(n => n.startsWith('Claude_') && fs.existsSync(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')));
const sessions = path.join(pk, store, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions');
const projects = path.join(os.homedir(), '.claude', 'projects');
const current = new Map(), prior = new Map();
for (const acct of fs.readdirSync(sessions)) {
  const ad = path.join(sessions, acct); if (!fs.statSync(ad).isDirectory()) continue;
  for (const org of fs.readdirSync(ad)) {
    const od = path.join(ad, org); if (!fs.statSync(od).isDirectory()) continue;
    for (const f of fs.readdirSync(od)) {
      if (!/^local_.*\.json$/.test(f)) continue;
      let e; try { e = JSON.parse(fs.readFileSync(path.join(od, f), 'utf8')); } catch { continue; }
      const who = { acct, title: e.title, cli: e.cliSessionId };
      if (e.cliSessionId) { if (!current.has(e.cliSessionId)) current.set(e.cliSessionId, []); current.get(e.cliSessionId).push(who); }
      for (const p of Array.isArray(e.priorCliSessionIds) ? e.priorCliSessionIds : []) { if (!prior.has(p)) prior.set(p, []); prior.get(p).push(who); }
    }
  }
}
const ids = new Set();
for (const d of fs.readdirSync(projects)) {
  const dir = path.join(projects, d); if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) ids.add(f.slice(0, -6));
}
const groups = { priorOfReceiving: [], priorOfOtherOnly: [], twin: [], none: [] };
for (const id of ids) {
  const cur = current.get(id) || [];
  if (cur.some(w => w.acct === recv)) continue;
  const pr = prior.get(id) || [];
  if (pr.some(w => w.acct === recv)) groups.priorOfReceiving.push(id.slice(0, 8) + ' earlier part of "' + pr.find(w => w.acct === recv).title + '"' + (cur.length ? ' (also the current transcript of an entry in ' + cur.map(w => w.acct.slice(0, 8)).join(',') + ')' : ''));
  else if (pr.length) groups.priorOfOtherOnly.push(id.slice(0, 8) + ' earlier part of "' + pr[0].title + '" in ' + pr[0].acct.slice(0, 8) + (cur.length ? ' (also the current transcript of an entry in ' + cur.map(w => w.acct.slice(0, 8)).join(',') + ')' : ''));
  else if (cur.length) groups.twin.push(id.slice(0, 8));
  else groups.none.push(id.slice(0, 8));
}
let total = 0;
for (const [k, v] of Object.entries(groups)) { total += v.length; console.log('\n' + k + ': ' + v.length); if (k !== 'twin') for (const x of v) console.log('  ' + x); }
console.log('\ncontrol: ' + ids.size + ' transcript ids; ' + total + ' without an entry in ' + recv.slice(0, 8) + '; ' + prior.size + ' ids named in some priorCliSessionIds');
