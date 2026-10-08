// Checks the sidebar plan a run of session-restore.ps1 saved, against the sandbox it was made in,
// without any of the script's code: the plan must say that the receiving account's groups and
// pins become the source account's, chat for chat, and must record the receiving account's own
// groups and pins as they were.
// Usage: node verify-plan.js <sandbox profile dir> <plan file> <source key> <receiving key> [--source-from store|prefs|list:<file>|file:<file>|none]
//   keys           "<accountUuid>/<orgUuid>"
//   --source-from  where the run should have read the source's groups: the sidebar's own storage
//                  (default), the app's settings file, or a list file the script saved earlier;
//                  none when the source has no groups saved anywhere, so that the plan must
//                  leave the groups alone and plan the pins only; file:<file> for a plan made
//                  by -Import from that file, whose groups and pins (when it has pins) are the
//                  ones to reach, the source key being the account the file names
// The sidebar's own storage is read with read-localstorage.js beside this file.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i === -1) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const sourceFrom = flag('--source-from') || 'store';
const [profile, planPath, sourceKey, destKey] = args;
if (!destKey) { console.error('usage: node verify-plan.js <profile> <plan file> <source key> <receiving key> [--source-from store|prefs|list:<file>|file:<file>|none]'); process.exit(2); }
const importFile = sourceFrom.startsWith('file:') ? sourceFrom.slice(5) : null;
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };
const text = v => (typeof v === 'string' && v) ? v : null;
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x));
const sameSeq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function storeRoot(p) {
  const pk = path.join(p, 'AppData', 'Local', 'Packages');
  const hits = fs.readdirSync(pk).filter(n => n.startsWith('Claude_') && fs.existsSync(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')));
  if (hits.length !== 1) throw new Error('expected exactly one Claude_* store under ' + pk);
  return path.join(pk, hits[0], 'LocalCache', 'Roaming', 'Claude');
}
const store = storeRoot(profile);
const [sourceAccount, sourceOrg] = sourceKey.split('/');
const [destAccount, destOrg] = destKey.split('/');

// every entry of an account's org folder, in file-name order; the transcript its chat resumes is
// cliSessionId, else unarchivedCliSessionId (the desktop app's own rule)
function entriesOf(account, org) {
  const dir = path.join(store, 'claude-code-sessions', account, org);
  const list = [];
  for (const f of fs.readdirSync(dir).filter(n => /^local_.*\.json$/.test(n)).sort()) {
    let e; try { e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    list.push({ id: text(e.sessionId) || f.replace(/\.json$/, ''), transcript: text(e.cliSessionId) || text(e.unarchivedCliSessionId),
      usable: e.isArchived !== true && !e.scheduledTaskId });
  }
  return list;
}
const sourceEntries = entriesOf(sourceAccount, sourceOrg);
const destEntries = entriesOf(destAccount, destOrg);
const sourceById = new Map(sourceEntries.map(e => [e.id, e]));
const destById = new Map(destEntries.map(e => [e.id, e]));
const destByTranscript = new Map();
for (const e of destEntries) if (e.transcript) { if (!destByTranscript.has(e.transcript)) destByTranscript.set(e.transcript, []); destByTranscript.get(e.transcript).push(e); }

const prefs = JSON.parse(fs.readFileSync(path.join(store, 'claude_desktop_config.json'), 'utf8'));
const epitaxy = prefs.preferences.epitaxyPrefs;
const prefScopes = epitaxy['dframe-group-scopes'] || {};
const pinList = (epitaxy['starred-local-code-sessions'] || []).filter(x => typeof x === 'string');
let storeScopes = null;
const ldb = path.join(store, 'Local Storage', 'leveldb');
if (fs.existsSync(ldb)) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'read-localstorage.js'), ldb, 'https://claude.ai', 'dframe-store'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = out.split('\n');
  const head = lines.findIndex(l => l.startsWith('=== dframe-store:'));
  if (head >= 0) storeScopes = (JSON.parse(lines[head + 1]).state || {}).customGroupsByScope || {};
}

// a scope's groups in order, each with its local Code chats: the order list first, then any
// assignment the order list lacks
function groupsOf(scope) {
  const out = [];
  for (const g of (scope && scope.groups) || []) {
    if (typeof g.id !== 'string' || typeof g.name !== 'string') continue;
    const keys = [];
    const assigned = k => scope.assignments && scope.assignments[k] === g.id;
    for (const k of ((scope.order || {})[g.id]) || []) if (typeof k === 'string' && k.startsWith('code:') && assigned(k) && !keys.includes(k)) keys.push(k);
    for (const k of Object.keys(scope.assignments || {})) if (k.startsWith('code:') && assigned(k) && !keys.includes(k)) keys.push(k);
    out.push({ name: g.name, sessions: keys.map(k => k.slice(5)) });
  }
  return out;
}

// --- what the plan should hold -------------------------------------------------------------------
let sourceGroups; // [{ name, transcripts }]
if (sourceFrom === 'none') {
  check(!(storeScopes && storeScopes[sourceKey]) && !prefScopes[sourceKey], 'neither the sidebar\'s own storage nor the settings file holds groups of the source account');
  sourceGroups = [];
} else if (sourceFrom.startsWith('list:') || importFile) {
  const list = JSON.parse(fs.readFileSync(importFile || sourceFrom.slice(5), 'utf8'));
  sourceGroups = list.groups.map(g => ({ name: g.name, transcripts: g.transcripts }));
} else {
  const scopes = sourceFrom === 'prefs' ? prefScopes : storeScopes;
  check(!!scopes && !!scopes[sourceKey], `the ${sourceFrom === 'prefs' ? "app's settings file" : "sidebar's own storage"} holds the source account's groups`);
  sourceGroups = groupsOf((scopes || {})[sourceKey]).map(g => {
    const transcripts = [];
    for (const id of g.sessions) { const e = sourceById.get(id); if (e && e.transcript && !transcripts.includes(e.transcript)) transcripts.push(e.transcript); }
    return { name: g.name, transcripts };
  });
}
const expectedGroups = [];
for (const g of sourceGroups) {
  const sessions = [];
  for (const t of g.transcripts) for (const e of destByTranscript.get(t) || []) if (e.usable) sessions.push(e.id);
  if (sessions.length) expectedGroups.push({ name: g.name, sessions });
}
// an import's pins are the file's pinned chats, or none planned when the file keeps no pins
const fileList = importFile ? JSON.parse(fs.readFileSync(importFile, 'utf8')) : null;
let expectedPinned = [];
if (fileList) {
  if (Array.isArray(fileList.pinned)) {
    for (const t of fileList.pinned) for (const e of destByTranscript.get(t) || []) if (e.usable && !expectedPinned.includes(e.id)) expectedPinned.push(e.id);
  } else expectedPinned = null;
} else {
  for (const id of pinList) {
    const s = sourceById.get(id);
    if (!s || !s.transcript) continue;
    for (const e of destByTranscript.get(s.transcript) || []) if (e.usable && !expectedPinned.includes(e.id)) expectedPinned.push(e.id);
  }
}
// an import reads the receiving account's groups as they are from the settings file
const destScope = fileList ? (prefScopes[destKey] || null) : ((storeScopes && storeScopes[destKey]) || prefScopes[destKey] || null);
const expectedBeforeGroups = groupsOf(destScope);
const expectedBeforePinned = pinList.filter(id => destById.has(id));

// --- the plan ------------------------------------------------------------------------------------
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
check(plan.v === 1 && /^\d{8}-\d{6}$/.test(plan.run || ''), `the plan is version 1 and names its run (${plan.run})`);
check(plan.aim === 'desired', `the plan aims at the source's groups and pins (aim ${JSON.stringify(plan.aim)})`);
check(plan.receiving && plan.receiving.accountUuid === destAccount && plan.receiving.organizationUuid === destOrg, 'the plan names the receiving account and org');
check(plan.source && plan.source.accountUuid === sourceAccount && plan.source.organizationUuid === sourceOrg, 'the plan names the source account and org');
const age = Date.now() - plan.madeAtMs;
check(Number.isInteger(plan.madeAtMs) && age >= 0 && age < 6 * 3600 * 1000 && plan.madeAt === new Date(plan.madeAtMs).toISOString().replace('Z', '0000Z'), `the plan is dated when it was made (${plan.madeAt})`);

if (fileList) {
  check(plan.source.importedFrom === path.resolve(importFile), `the plan names the file it was imported from (${plan.source.importedFrom})`);
  const savedMs = Date.parse(fileList.savedAt);
  check(Number.isInteger(plan.source.stateAtMs) && plan.source.stateAtMs === Math.min(savedMs, plan.madeAtMs), `the plan leaves chats created after the file was saved as they are (${fileList.savedAt})`);
}
const dg = (plan.desired && plan.desired.groups) || null;
const groupsAlone = sourceFrom === 'none' || (fileList && expectedGroups.length === 0 && sourceGroups.length > 0);
if (groupsAlone) check(plan.desired.groups === null && plan.before.groups === null, 'the plan leaves the groups alone: neither the groups to reach nor the groups as they were are planned');
else check(Array.isArray(dg), 'the plan holds the groups to reach');
if (Array.isArray(dg)) {
  check(sameSeq(dg.map(g => g.name), expectedGroups.map(g => g.name)), `the groups are the source's, in its order: ${expectedGroups.map(g => `"${g.name}" (${g.sessions.length})`).join(', ') || 'none'}`);
  let setsOk = true, orderOk = true;
  for (const g of expectedGroups) {
    const got = (dg.find(x => x.name === g.name) || { sessions: [] }).sessions;
    if (!sameSet(got, g.sessions)) { setsOk = false; console.log(`       "${g.name}": expected ${g.sessions.length} chats, the plan has ${got.length}; missing ${g.sessions.filter(x => !got.includes(x)).length}, extra ${got.filter(x => !g.sessions.includes(x)).length}`); }
    else if (!sameSeq(got, g.sessions)) orderOk = false;
  }
  check(setsOk, "each group holds exactly this account's entries for the chats the source filed in it");
  check(orderOk, 'and lists them in the source\'s order');
  const all = dg.flatMap(g => g.sessions);
  check(new Set(all).size === all.length, 'no chat is filed in two groups');
  check(all.every(id => destById.has(id) && destById.get(id).usable), 'every chat to file is an entry of the receiving account that is neither archived nor a routine\'s run');
}
const dp = (plan.desired && plan.desired.pinned) || null;
if (expectedPinned === null) {
  check(plan.desired.pinned === null && plan.before.pinned === null, 'the file keeps no pins, so the plan leaves the pins alone');
} else {
  check(Array.isArray(dp), 'the plan holds the pins to reach');
  if (Array.isArray(dp)) {
    check(sameSet(dp, expectedPinned), `the pins are this account's entries for the source's ${expectedPinned.length} pinned chat(s) that can be pinned here`);
    check(sameSeq(dp, expectedPinned), 'and are listed in the pin list\'s order');
  }
}
const bg = (plan.before && plan.before.groups) || null;
if (!groupsAlone) check(Array.isArray(bg), 'the plan holds the groups as they were');
if (Array.isArray(bg)) {
  check(sameSeq(bg.map(g => g.name), expectedBeforeGroups.map(g => g.name)) && expectedBeforeGroups.every((g, i) => sameSeq(bg[i].sessions, g.sessions)),
    `the groups as they were are the receiving account's own: ${expectedBeforeGroups.map(g => `"${g.name}" (${g.sessions.length})`).join(', ') || 'none'}`);
}
const bp = (plan.before && plan.before.pinned) || null;
if (expectedPinned !== null) check(Array.isArray(bp) && sameSeq(bp, expectedBeforePinned), `the pins as they were are the receiving account's own ${expectedBeforePinned.length}`);

console.log(fails === 0 ? 'PLAN CHECK CLEAN' : `PLAN CHECK FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
