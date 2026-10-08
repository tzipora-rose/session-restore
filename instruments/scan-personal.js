// Scans files before they are published for personal details, read from where they live on this
// computer rather than written here: email addresses (the tool's known-accounts file), account,
// organization and session ids and the first 8 characters of each, as a short pointer gives them
// (the Claude desktop app's store and Claude Code's transcripts folders), sidebar group ids (the
// app's settings file), the Windows user name, and any words passed in. Each kind is first looked for in a control file holding one detail of each kind, and
// a kind the control does not match makes the scan fail: a clean scan means the patterns could
// have found something. It prints counts and places, never the details.
// Usage: node scan-personal.js [--known <file>] [--store <dir>] [--projects <dir>] [--user <name>]
//          [--word <word>]... [--allow <file name>::<text of an allowed line>]... <file or folder>...
//   --known     default: .session-restore\known-accounts.json in the user profile
//   --store     the app's Roaming\Claude folder; default: found under the local app data's Packages
//   --projects  default: .claude\projects in the user profile; every folder in it is read
//   --user      default: the Windows user name
//   --word      a word that must not appear, such as a name; matched without regard to case
//   --allow     a line that may carry a detail, by its file's name and its whole text
// A folder is scanned whole, its .git folder aside. Exit 0: clean; 1: a detail found or a control
// that did not match; 2: wrong arguments.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const args = process.argv.slice(2);
const opt = { word: [], allow: [], targets: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--word' || a === '--allow') opt[a.slice(2)].push(args[++i]);
  else if (['--known', '--store', '--projects', '--user'].includes(a)) opt[a.slice(2)] = args[++i];
  else if (a.startsWith('--')) { console.error('unknown argument ' + a); process.exit(2); }
  else opt.targets.push(a);
}
if (!opt.targets.length) { console.error('usage: node scan-personal.js [options] <file or folder>... (see the header of this file)'); process.exit(2); }
const known = opt.known || path.join(os.homedir(), '.session-restore', 'known-accounts.json');
const projects = opt.projects || path.join(os.homedir(), '.claude', 'projects');
const user = opt.user || os.userInfo().username;
let store = opt.store;
if (!store) {
  const pk = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Packages');
  const hit = fs.existsSync(pk) ? fs.readdirSync(pk).find(n => n.startsWith('Claude_') && fs.existsSync(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'))) : null;
  if (!hit) { console.error('no Claude package store found; pass --store'); process.exit(2); }
  store = path.join(pk, hit, 'LocalCache', 'Roaming', 'Claude');
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const kinds = { email: new Set(), account: new Set(), session: new Set(), group: new Set() };
if (fs.existsSync(known)) for (const m of fs.readFileSync(known, 'utf8').match(emailRe) || []) kinds.email.add(m.toLowerCase());
const ccs = path.join(store, 'claude-code-sessions');
for (const acc of fs.readdirSync(ccs).filter(n => uuid.test(n))) {
  kinds.account.add(acc.toLowerCase());
  for (const org of fs.readdirSync(path.join(ccs, acc)).filter(n => uuid.test(n))) {
    const dir = path.join(ccs, acc, org);
    if (!fs.statSync(dir).isDirectory()) continue;
    kinds.account.add(org.toLowerCase());
    for (const f of fs.readdirSync(dir)) {
      const m = /^local_(.+)\.json$/.exec(f); if (!m) continue;
      kinds.session.add(m[1].toLowerCase());
      try { const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (e.cliSessionId) kinds.session.add(String(e.cliSessionId).toLowerCase()); } catch { /* an entry being written */ }
    }
  }
}
if (fs.existsSync(projects)) for (const d of fs.readdirSync(projects)) {
  const dir = path.join(projects, d);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) { const m = /^(.+)\.jsonl$/.exec(f); if (m && uuid.test(m[1])) kinds.session.add(m[1].toLowerCase()); }
}
const ep = JSON.parse(fs.readFileSync(path.join(store, 'claude_desktop_config.json'), 'utf8')).preferences.epitaxyPrefs || {};
for (const s of Object.values(ep['dframe-group-scopes'] || {})) for (const g of s.groups || []) kinds.group.add(String(g.id).toLowerCase());
for (const e of Object.values(ep['dframe-code-sections'] || {})) for (const s of e.sections || []) if (s.kind === 'manual') kinds.group.add(String(s.id).toLowerCase());
const words = [user, ...opt.word].map(w => w.toLowerCase());
const prefixes = new Set([...kinds.account].map(id => id.slice(0, 8)));
const sessionPrefixes = new Set([...kinds.session].filter(id => uuid.test(id)).map(id => id.slice(0, 8)));

function findIn(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const low = line.toLowerCase(), found = new Set();
    for (const m of line.match(uuidRe) || []) { const u = m.toLowerCase(); if (kinds.account.has(u)) found.add('account or organization id'); if (kinds.session.has(u)) found.add('session id'); }
    for (const m of low.match(/cg-[0-9a-f-]{36}/g) || []) if (kinds.group.has(m)) found.add('group id');
    for (const m of line.match(emailRe) || []) if (kinds.email.has(m.toLowerCase())) found.add('email address');
    for (const m of low.match(/\b[0-9a-f]{8}\b/g) || []) {
      if (prefixes.has(m)) found.add('start of an account or organization id');
      if (sessionPrefixes.has(m)) found.add('start of a session id');
    }
    words.forEach((w, k) => { if (low.includes(w)) found.add(k === 0 ? 'the Windows user name' : `word ${k}`); });
    if (found.size) hits.push({ line: i + 1, text: line, found: [...found] });
  });
  return hits;
}

// the control: one detail of each kind, each to be found as its own kind
const want = ['the Windows user name', ...opt.word.map((w, k) => `word ${k + 1}`)];
const sample = [...words.map(w => `[${w}]`)];
const firstOf = s => [...s][0];
if (kinds.email.size) { want.push('email address'); sample.push(`a ${firstOf(kinds.email)} b`); }
if (kinds.account.size) { want.push('account or organization id', 'start of an account or organization id'); sample.push(firstOf(kinds.account), `x ${firstOf(kinds.account).slice(0, 8)}... y`); }
if (kinds.session.size) { want.push('session id'); sample.push(firstOf(kinds.session)); }
if (sessionPrefixes.size) { want.push('start of a session id'); sample.push(`by session ${firstOf(sessionPrefixes)} (`); }
if (kinds.group.size) { want.push('group id'); sample.push(firstOf(kinds.group)); }
const controlFile = path.join(os.tmpdir(), `personal-scan-control-${process.pid}.txt`);
fs.writeFileSync(controlFile, sample.join('\n'));
let seen;
try { seen = new Set(findIn(fs.readFileSync(controlFile, 'utf8')).flatMap(h => h.found)); } finally { fs.unlinkSync(controlFile); }
let bad = 0;
console.log(`details read: ${kinds.email.size} email(s), ${kinds.account.size} account and organization id(s), ${kinds.session.size} session id(s), ${kinds.group.size} group id(s), ${words.length} word(s)`);
for (const w of want) { if (seen.has(w)) console.log(`  control ok   ${w}`); else { console.log(`  control FAIL ${w}: not found in the control`); bad++; } }
for (const [k, s] of Object.entries(kinds)) if (!s.size) console.log(`  --   no ${k} detail was found on this computer to look for`);

const files = [];
const walk = p => { const st = fs.statSync(p); if (st.isDirectory()) { for (const n of fs.readdirSync(p)) if (n !== '.git') walk(path.join(p, n)); } else files.push(p); };
for (const t of opt.targets) walk(t);
const allowed = opt.allow.map(a => { const i = a.indexOf('::'); return { file: a.slice(0, i), text: a.slice(i + 2) }; });
let found = 0, allowedHits = 0;
for (const f of files) {
  for (const h of findIn(fs.readFileSync(f, 'utf8'))) {
    if (allowed.some(a => path.basename(f) === a.file && h.text.trim() === a.text)) { allowedHits++; continue; }
    found++;
    console.log(`  FOUND ${f}:${h.line}: ${h.found.join(', ')}`);
  }
}
console.log(`scanned ${files.length} file(s): ${found} line(s) with a personal detail; ${allowedHits} allowed line(s)`);
console.log(bad === 0 && found === 0 ? 'PERSONAL SCAN CLEAN' : `PERSONAL SCAN FAILED: ${bad} control(s), ${found} line(s)`);
process.exit(bad === 0 && found === 0 ? 0 : 1);
