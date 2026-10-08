// Checks a list of an account's groups and pinned chats that session-restore.ps1 wrote: the list it
// keeps for the account (sidebar-list-<account>.json in the profile's .session-restore folder), or
// an export (--file), against the app's settings file and the account's chat entries, without any
// of the script's code. The list must name the account and its org, say when it was saved, and
// hold the account's groups as the settings file saves them, in order, each with the transcripts
// of the chats filed in it, in their saved place, each once; and the transcripts of the account's
// pinned chats, in the pin list's order. No half-written file may be left beside it.
// Usage: node verify-list.js <profile dir> <accountUuid>/<orgUuid> [--file <list or export file>]
// The profile is a sandbox's, or the real one when the settings file is read while the app runs.
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i === -1) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const fileArg = flag('--file');
const [profile, key] = args;
if (!key || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key)) { console.error('usage: node verify-list.js <profile dir> <accountUuid>/<orgUuid> [--file <file>]'); process.exit(2); }
const [account, org] = key.split('/');
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };

const pk = path.join(profile, 'AppData', 'Local', 'Packages');
const hits = fs.readdirSync(pk).filter(n => n.startsWith('Claude_') && fs.existsSync(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')));
if (hits.length !== 1) throw new Error('expected exactly one Claude_* store under ' + pk);
const store = path.join(pk, hits[0], 'LocalCache', 'Roaming', 'Claude');

// the transcript each entry of the account's org resumes: cliSessionId, else unarchivedCliSessionId
const transcriptOf = new Map();
const dir = path.join(store, 'claude-code-sessions', account, org);
for (const f of fs.readdirSync(dir).filter(n => /^local_.*\.json$/.test(n))) {
  let e; try { e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
  const id = (typeof e.sessionId === 'string' && e.sessionId) || f.replace(/\.json$/, '');
  const t = (typeof e.cliSessionId === 'string' && e.cliSessionId) || (typeof e.unarchivedCliSessionId === 'string' && e.unarchivedCliSessionId) || null;
  transcriptOf.set(id, t);
}

// the account's groups as the settings file saves them: each group in order, its chats from the
// group's order list first, then any chat assigned to it that the order list lacks
const prefs = JSON.parse(fs.readFileSync(path.join(store, 'claude_desktop_config.json'), 'utf8'));
const epitaxy = prefs.preferences.epitaxyPrefs || {};
const scope = (epitaxy['dframe-group-scopes'] || {})[key] || null;
const expected = [];
const seenIds = new Set();
for (const g of (scope && scope.groups) || []) {
  if (typeof g.id !== 'string' || typeof g.name !== 'string' || seenIds.has(g.id)) continue;
  seenIds.add(g.id);
  const assigned = k => scope.assignments && scope.assignments[k] === g.id;
  const keys = [];
  for (const k of ((scope.order || {})[g.id]) || []) if (typeof k === 'string' && k.startsWith('code:') && assigned(k) && !keys.includes(k)) keys.push(k);
  for (const k of Object.keys(scope.assignments || {})) if (k.startsWith('code:') && assigned(k) && !keys.includes(k)) keys.push(k);
  const transcripts = [];
  for (const k of keys) { const t = transcriptOf.get(k.slice(5)); if (t && !transcripts.includes(t)) transcripts.push(t); }
  expected.push({ name: g.name, transcripts });
}
// the account's pinned chats: its entries in the one pin list, in that list's order
const expectedPinned = [];
for (const id of (epitaxy['starred-local-code-sessions'] || [])) {
  if (typeof id !== 'string' || !transcriptOf.has(id)) continue;
  const t = transcriptOf.get(id);
  if (t && !expectedPinned.includes(t)) expectedPinned.push(t);
}

const listPath = fileArg ? path.resolve(fileArg) : path.join(profile, '.session-restore', 'sidebar-list-' + account + '.json');
check(fs.existsSync(listPath), 'the list file exists: ' + listPath);
if (fs.existsSync(listPath)) {
  let list = null;
  try { list = JSON.parse(fs.readFileSync(listPath, 'utf8')); } catch (x) { check(false, 'the list file is JSON (' + x.message + ')'); }
  if (list) {
    check(list.v === 1, 'the list is version 1');
    check(list.accountUuid === account && list.organizationUuid === org, 'it names the account and its org');
    check(!Number.isNaN(Date.parse(list.savedAt)), 'it says when it was saved (' + list.savedAt + ')');
    const got = Array.isArray(list.groups) ? list.groups : [];
    check(JSON.stringify(got.map(g => g.name)) === JSON.stringify(expected.map(g => g.name)),
      'its groups are the settings file\'s, in order: ' + (expected.map(g => `"${g.name}" (${g.transcripts.length})`).join(', ') || 'none'));
    let same = true;
    for (const g of expected) {
      const h = got.find(x => x.name === g.name);
      if (!h || JSON.stringify(h.transcripts) !== JSON.stringify(g.transcripts)) { same = false; console.log(`       "${g.name}": the settings file gives ${g.transcripts.length} transcripts, the list ${h && Array.isArray(h.transcripts) ? h.transcripts.length : 0}, or another order`); }
    }
    check(same, 'each group lists exactly the transcripts of the chats filed in it, in their saved place');
    check(Array.isArray(list.pinned) && JSON.stringify(list.pinned) === JSON.stringify(expectedPinned),
      `its pinned chats are the account's ${expectedPinned.length}, in the pin list's order` + (Array.isArray(list.pinned) ? '' : ' (the list has no pins)'));
  }
}
check(!fs.existsSync(listPath + '.session-restore.tmp'), 'no half-written list is left beside it');
console.log(fails === 0 ? 'LIST CHECK CLEAN' : `LIST CHECK FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
