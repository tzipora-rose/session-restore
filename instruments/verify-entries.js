// Independent check of a sandbox run's chat entries (shares no code with the PowerShell script).
// Usage: node verify-entries.js <sandbox profile dir> <run manifest> <receiving key> <source key> <sandbox fingerprints> [<backup run dir>]
//   run manifest     the created-entries-<stamp>.txt the run wrote beside the script under test
//   keys             "<accountUuid>/<orgUuid>", as the script prints them; pass none/none as the
//                    source key for a run that copied no groups, pins or folders (no account was
//                    configured, or the configured one was the receiving one or could not be found)
//   fingerprints     fingerprints-at-build.json in the sandbox folder (new-sandbox.ps1 writes it)
//   backup run dir   <profile>\.session-restore\backups\<stamp>, when the run wrote one
// It checks: each chat the receiving account lacked got exactly one entry, and no transcript that
// an entry keeps as another part of its chat got one; each new entry's dates and folder follow the
// rules below; each new entry is what its twin is (title, model, effort, archived state, earlier
// transcripts) and holds nothing else; each existing entry whose twin in the source account names
// another folder was moved there unless a rule forbids it; and no other entry file changed.
// The rules: a new entry takes its dates and folder from the same chat's entry in another account
// (the source account's first, else the most recently active), using the folder only when it
// exists and holds the transcript; otherwise its folder is the one the transcript is stored for
// (learned from the folders existing entries name), else the transcript's recorded folder if it
// exists, else the drive root; and its dates are the transcript file's creation (the earliest
// copy's) and its last timestamped record's time (else the file's write time). From that twin it
// also takes its title and titleSource, model, effort, isArchived, and priorCliSessionIds,
// preClearCliSessionId, rewindEdges and transcriptModelStates; with no twin, the model is the last
// one its transcript logs (else claude-opus-4-8), the effort "high" and the titleSource "auto".
// Every new entry is in the default permission mode.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [profile, manifestPath, destKey, sourceKey, fingerprintsPath, backupDir] = process.argv.slice(2);
if (!fingerprintsPath) { console.error('usage: node verify-entries.js <profile> <run manifest> <receiving key> <source key> <fingerprints> [<backup run dir>]'); process.exit(2); }
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isInt = v => typeof v === 'number' && Number.isInteger(v);
const text = v => (typeof v === 'string' && v) ? v : null;

function storeRoot(p) {
  const pk = path.join(p, 'AppData', 'Local', 'Packages');
  const hits = fs.readdirSync(pk).filter(n => n.startsWith('Claude_') && fs.existsSync(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')));
  if (hits.length !== 1) throw new Error('expected exactly one Claude_* store under ' + pk);
  return path.join(pk, hits[0], 'LocalCache', 'Roaming', 'Claude');
}
// the desktop app's own function (desktop app 2.9939.4.0)
function appFolderName(n) {
  const r = n.replace(/[^a-zA-Z0-9]/g, '-');
  if (r.length <= 200) return r;
  let i = 0;
  for (let e = 0; e < n.length; e++) i = (i << 5) - i + n.charCodeAt(e) | 0;
  return `${r.slice(0, 200)}-${Math.abs(i).toString(36)}`;
}
// the transcripts of an entry's chat, as the desktop app counts them (2.19675.0.0): the one it
// resumes (cliSessionId, else unarchivedCliSessionId: the start path's resume fallback), and the
// others it keeps (localLineageIds: preClearCliSessionId and priorCliSessionIds; and the second of
// localLiveHandles, unarchivedCliSessionId, when the chat resumes another transcript)
function transcriptsOf(e) {
  const cli = text(e.cliSessionId), un = text(e.unarchivedCliSessionId);
  const others = [];
  if (cli && un && un !== cli) others.push(un);
  if (text(e.preClearCliSessionId)) others.push(e.preClearCliSessionId);
  for (const p of Array.isArray(e.priorCliSessionIds) ? e.priorCliSessionIds : []) if (text(p)) others.push(p);
  return { current: cli || un, others };
}
function lastRecordMs(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let k = lines.length - 1; k >= 0; k--) {
    const s = lines[k].trim();
    if (!s.startsWith('{')) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o && typeof o.timestamp === 'string' && o.timestamp) { const t = Date.parse(o.timestamp); if (!isNaN(t)) return t; }
  }
  return null;
}
function recordedCwd(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 250);
  for (const line of lines) {
    if (line.length < 2) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && o.cwd) return String(o.cwd);
  }
  return null;
}
function lastLoggedModel(file) {
  const all = fs.readFileSync(file, 'utf8').match(/"model":"(claude-[a-z0-9.-]+)"/g);
  return all ? all[all.length - 1].slice(9, -1) : 'claude-opus-4-8';
}
function ahead(t, o) {
  const a = fs.readFileSync(t), b = fs.readFileSync(o);
  const n = Math.min(a.length, b.length);
  if (!a.subarray(0, n).equals(b.subarray(0, n))) return true;
  if (b.length <= a.length) return false;
  for (const line of b.subarray(a.length).toString('utf8').split('\n')) {
    const s = line.trim(); if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { return true; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) return true;
    if (typeof r.timestamp === 'string' && r.timestamp) return true;
  }
  return false;
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase();

// --- inputs ------------------------------------------------------------------------------------
const store = storeRoot(profile);
const sessions = path.join(store, 'claude-code-sessions');
const [destAccount, destOrg] = destKey.split('/');
const [sourceAccount, sourceOrg] = sourceKey.split('/');
const created = new Set(fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean).map(p => path.resolve(p).toLowerCase()));
const backup = backupDir ? JSON.parse(fs.readFileSync(path.join(backupDir, 'backup.json'), 'utf8')) : { entries: [] };
const backedUp = new Map(backup.entries.map(b => [path.resolve(b.path).toLowerCase(), path.join(backupDir, 'entries', b.copy)]));
const entries = [];
for (const acct of fs.readdirSync(sessions)) {
  if (!isDir(path.join(sessions, acct))) continue;
  for (const org of fs.readdirSync(path.join(sessions, acct))) {
    const dir = path.join(sessions, acct, org);
    if (!isDir(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^local_.*\.json$/.test(f)) continue;
      const file = path.join(dir, f);
      let e; try { e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { e = null; }
      const key = path.resolve(file).toLowerCase();
      const was = backedUp.has(key) ? JSON.parse(fs.readFileSync(backedUp.get(key), 'utf8')) : e;
      entries.push({ acct, org, file, e, was, created: created.has(key) });
    }
  }
}
const projects = path.join(profile, '.claude', 'projects');
const copies = new Map();
for (const d of fs.readdirSync(projects)) {
  if (!isDir(path.join(projects, d))) continue;
  for (const f of fs.readdirSync(path.join(projects, d))) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    if (!copies.has(id)) copies.set(id, []);
    const full = path.join(projects, d, f);
    const st = fs.statSync(full);
    copies.get(id).push({ file: full, folder: d, size: st.size, birth: Math.floor(st.birthtimeMs), mtime: Math.floor(st.mtimeMs) });
  }
}
// every entry the run did not create, as it was before the run (its backup, when it has one)
const before = entries.filter(x => !x.created).map(x => ({ ...x, e: x.was }));
const dest = entries.filter(x => x.acct === destAccount && x.org === destOrg);
const driveRoot = path.parse(profile).root;

// the folder each project folder is stored for, learned from the folders existing entries name
const counts = new Map();
for (const x of before) if (x.e && typeof x.e.cwd === 'string' && x.e.cwd) counts.set(x.e.cwd, (counts.get(x.e.cwd) || 0) + 1);
const folderOf = new Map();
for (const cwd of [...counts.keys()].sort()) {
  if (!isDir(cwd)) continue;
  const name = appFolderName(cwd).toLowerCase();
  if (!folderOf.has(name) || counts.get(cwd) > counts.get(folderOf.get(name))) folderOf.set(name, cwd);
}
// the same chat's entry in another account that a new entry is modelled on
function twinOf(id) {
  const others = before.filter(y => y.e && transcriptsOf(y.e).current === id && y.acct !== destAccount);
  let pool = others.filter(y => y.acct === sourceAccount);
  if (!pool.length) pool = others;
  pool.sort((p, q) => (isInt(q.e.lastActivityAt) ? q.e.lastActivityAt : 0) - (isInt(p.e.lastActivityAt) ? p.e.lastActivityAt : 0));
  return pool[0] || null;
}

console.log('--- 1. each chat the receiving account lacked got exactly one entry');
const destBefore = new Set(dest.filter(x => !x.created && x.e).map(x => transcriptsOf(x.e).current).filter(Boolean));
const otherParts = new Set(before.filter(x => x.e).flatMap(x => transcriptsOf(x.e).others));
const unlisted = [...copies.keys()].filter(id => !destBefore.has(id));
const lacked = unlisted.filter(id => !otherParts.has(id)).sort();
const madeFor = dest.filter(x => x.created).map(x => x.e && x.e.cliSessionId).sort();
check(created.size === madeFor.length, `the manifest lists ${created.size} files and ${madeFor.length} of them are in the receiving org folder`);
check(JSON.stringify(lacked) === JSON.stringify(madeFor), `${lacked.length} chats lacked an entry; ${madeFor.length} entries were made, one for each`);
const partsMade = madeFor.filter(id => otherParts.has(id));
check(partsMade.length === 0, `${unlisted.length - lacked.length} unlisted transcripts are other parts of listed chats; ${partsMade.length} of them got an entry of their own`);
const perChat = new Map();
for (const x of dest) if (x.e && transcriptsOf(x.e).current) perChat.set(transcriptsOf(x.e).current, (perChat.get(transcriptsOf(x.e).current) || 0) + 1);
const doubled = [...perChat.entries()].filter(([, n]) => n > 1);
check(doubled.length === 0, `no chat has two entries in the receiving org (${doubled.length} do)`);

console.log('--- 2. each new entry\'s dates and folder follow the rules');
const tally = { twinDates: 0, recordDates: 0, fileDates: 0, twinFolder: 0, stored: 0, record: 0, root: 0 };
let wrongDates = 0, wrongFolder = 0, missingFolder = 0;
const usedCopy = new Map();
for (const x of dest.filter(y => y.created)) {
  const id = x.e.cliSessionId, cs = copies.get(id);
  const twin = twinOf(id);
  let cwd = null, origin = null, chosen = null;
  if (twin && typeof twin.e.cwd === 'string' && twin.e.cwd && isDir(twin.e.cwd)) {
    const inTwin = cs.filter(c => c.folder.toLowerCase() === appFolderName(twin.e.cwd).toLowerCase());
    if (inTwin.length) { chosen = inTwin[0]; cwd = twin.e.cwd; origin = (typeof twin.e.originCwd === 'string' && twin.e.originCwd && isDir(twin.e.originCwd)) ? twin.e.originCwd : twin.e.cwd; tally.twinFolder++; }
  }
  if (!chosen) chosen = cs.length === 1 ? cs[0] : [...cs].sort((p, q) => (folderOf.has(q.folder.toLowerCase()) - folderOf.has(p.folder.toLowerCase())) || (q.size - p.size) || (p.folder < q.folder ? -1 : 1))[0];
  usedCopy.set(id, chosen);
  if (!cwd) {
    const rc = recordedCwd(chosen.file);
    if (folderOf.has(chosen.folder.toLowerCase())) { cwd = folderOf.get(chosen.folder.toLowerCase()); tally.stored++; }
    else if (rc && isDir(rc)) { cwd = rc; tally.record++; }
    else { cwd = driveRoot; tally.root++; }
    origin = cwd;
  }
  let want;
  if (twin && isInt(twin.e.createdAt) && isInt(twin.e.lastActivityAt)) {
    want = { createdAt: twin.e.createdAt, lastActivityAt: twin.e.lastActivityAt, lastFocusedAt: isInt(twin.e.lastFocusedAt) ? twin.e.lastFocusedAt : twin.e.lastActivityAt };
    tally.twinDates++;
  } else {
    const last = lastRecordMs(chosen.file);
    const act = last === null ? chosen.mtime : last;
    want = { createdAt: Math.min(...cs.map(c => c.birth)), lastActivityAt: act, lastFocusedAt: act };
    if (last === null) tally.fileDates++; else tally.recordDates++;
  }
  if (x.e.createdAt !== want.createdAt || x.e.lastActivityAt !== want.lastActivityAt || x.e.lastFocusedAt !== want.lastFocusedAt) {
    wrongDates++; console.log('       dates of "' + x.e.title + '": ' + JSON.stringify([x.e.createdAt, x.e.lastActivityAt, x.e.lastFocusedAt]) + ' expected ' + JSON.stringify(want));
  }
  if (x.e.cwd !== cwd || x.e.originCwd !== origin) { wrongFolder++; console.log('       folder of "' + x.e.title + '": ' + x.e.cwd + ' / ' + x.e.originCwd + ' expected ' + cwd + ' / ' + origin); }
  if (!isDir(x.e.cwd)) missingFolder++;
}
check(wrongDates === 0, `dates: ${tally.twinDates} from the twin, ${tally.recordDates} from the last record, ${tally.fileDates} from the file (${wrongDates} wrong)`);
check(wrongFolder === 0, `folders: ${tally.twinFolder} from the twin, ${tally.stored} where the transcript is stored, ${tally.record} from the records, ${tally.root} the drive root (${wrongFolder} wrong)`);
check(missingFolder === 0, `every new entry names a folder that exists (${missingFolder} do not)`);

console.log('--- 3. each new entry is what its twin is, and holds nothing else');
const lineageKeys = ['priorCliSessionIds', 'preClearCliSessionId', 'rewindEdges', 'transcriptModelStates'];
const baseKeys = ['sessionId', 'cliSessionId', 'cwd', 'originCwd', 'lastFocusedAt', 'createdAt', 'lastActivityAt', 'model', 'effort', 'sessionSettings', 'isArchived', 'title', 'titleSource', 'permissionMode', 'remoteMcpServersConfig', 'alwaysAllowedReasons', 'sessionPermissionUpdates', 'classifierSummaryEnabled', 'spawnSeed'];
const t3 = { twins: 0, archived: 0, lineage: 0, titles: 0, models: 0, efforts: 0 };
let wrongArchived = 0, wrongLineage = 0, wrongTitle = 0, wrongModel = 0, wrongEffort = 0, wrongMode = 0, wrongKeys = 0, wrongIds = 0;
const say = (x, what, got, want) => console.log('       ' + what + ' of ' + path.basename(x.file) + ': ' + JSON.stringify(got) + ' expected ' + JSON.stringify(want));
for (const x of dest.filter(y => y.created)) {
  const id = x.e.cliSessionId;
  const twin = twinOf(id);
  const te = twin ? twin.e : {};
  if (twin) t3.twins++;
  const wantArchived = te.isArchived === true;
  if (x.e.isArchived !== wantArchived) { wrongArchived++; say(x, 'isArchived', x.e.isArchived, wantArchived); }
  if (wantArchived) t3.archived++;
  let carries = false;
  for (const k of lineageKeys) {
    const has = Object.prototype.hasOwnProperty.call(te, k);
    if (has) carries = true;
    if (Object.prototype.hasOwnProperty.call(x.e, k) !== has || JSON.stringify(x.e[k]) !== JSON.stringify(te[k])) { wrongLineage++; say(x, k, x.e[k], te[k]); }
  }
  if (carries) t3.lineage++;
  if (text(te.title)) {
    t3.titles++;
    const wantSource = text(te.titleSource) || 'auto';
    if (x.e.title !== te.title || x.e.titleSource !== wantSource) { wrongTitle++; say(x, 'title and titleSource', [x.e.title, x.e.titleSource], [te.title, wantSource]); }
  } else if (x.e.titleSource !== 'auto' || !text(x.e.title)) { wrongTitle++; say(x, 'title and titleSource', [x.e.title, x.e.titleSource], ['(a title)', 'auto']); }
  const wantModel = text(te.model) || lastLoggedModel(usedCopy.get(id).file);
  if (text(te.model)) t3.models++;
  if (x.e.model !== wantModel) { wrongModel++; say(x, 'model', x.e.model, wantModel); }
  const wantEffort = text(te.effort) || 'high';
  if (text(te.effort)) t3.efforts++;
  if (x.e.effort !== wantEffort) { wrongEffort++; say(x, 'effort', x.e.effort, wantEffort); }
  if (x.e.permissionMode !== 'default') { wrongMode++; say(x, 'permissionMode', x.e.permissionMode, 'default'); }
  const wantKeys = [...baseKeys, ...lineageKeys.filter(k => Object.prototype.hasOwnProperty.call(te, k))].sort();
  if (JSON.stringify(Object.keys(x.e).sort()) !== JSON.stringify(wantKeys)) { wrongKeys++; say(x, 'fields', Object.keys(x.e).sort(), wantKeys); }
  if (x.e.sessionId !== path.basename(x.file, '.json')) { wrongIds++; say(x, 'sessionId', x.e.sessionId, path.basename(x.file, '.json')); }
}
const madeCount = dest.filter(y => y.created).length;
check(wrongArchived === 0, `archived state: ${t3.archived} of ${madeCount} new entries are archived, as their twins are (${wrongArchived} wrong)`);
check(wrongLineage === 0, `earlier transcripts: ${t3.lineage} new entries carry their twin's ${lineageKeys.join(', ')} (${wrongLineage} field(s) wrong)`);
check(wrongTitle === 0, `titles: ${t3.titles} from the twin, ${madeCount - t3.titles} from the transcript (${wrongTitle} wrong)`);
check(wrongModel === 0, `models: ${t3.models} from the twin, ${madeCount - t3.models} the last one the transcript logs (${wrongModel} wrong)`);
check(wrongEffort === 0, `effort: ${t3.efforts} from the twin, ${madeCount - t3.efforts} the nominal "high" (${wrongEffort} wrong)`);
check(wrongMode === 0, `every new entry is in the default permission mode (${wrongMode} are not)`);
check(wrongKeys === 0 && wrongIds === 0, `every new entry holds exactly the fields the script writes, and is named for its own id (${wrongKeys + wrongIds} do not)`);

console.log('--- 4. existing entries: moved to their twin\'s folder unless a rule forbids it');
let moved = 0, kept = 0, wrongMove = 0, stray = 0;
for (const x of dest.filter(y => !y.created)) {
  const key = path.resolve(x.file).toLowerCase();
  const was = x.was;
  const twins = before.filter(y => y.acct === sourceAccount && y.org === sourceOrg && y.e && y.e.cliSessionId === was.cliSessionId);
  let wantCwd = was.cwd, wantOrigin = was.originCwd;
  if (twins.length) {
    const places = twins.map(t => ({ cwd: t.e.cwd, origin: (typeof t.e.originCwd === 'string' && t.e.originCwd) ? t.e.originCwd : t.e.cwd }));
    const agree = places.every(p => p.cwd === places[0].cwd && p.origin === places[0].origin);
    const differs = !(was.cwd === places[0].cwd && was.originCwd === places[0].origin);
    if (differs && agree && !was.worktreePath && typeof places[0].cwd === 'string' && places[0].cwd && isDir(places[0].cwd)) {
      const target = path.join(projects, appFolderName(places[0].cwd), was.cliSessionId + '.jsonl');
      if (fs.existsSync(target) && !(copies.get(was.cliSessionId) || []).some(c => c.folder.toLowerCase() !== appFolderName(places[0].cwd).toLowerCase() && ahead(target, c.file))) {
        wantCwd = places[0].cwd; wantOrigin = places[0].origin;
      }
    }
  }
  const now = x.e;
  if (now.cwd !== wantCwd || now.originCwd !== wantOrigin) { wrongMove++; console.log('       "' + was.title + '": ' + now.cwd + ' expected ' + wantCwd); }
  if (was.cwd !== now.cwd) moved++; else kept++;
  if (backedUp.has(key)) {
    const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
    const diff = [...keys].filter(k => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
    if (diff.some(k => !['isStarred', 'cwd', 'originCwd'].includes(k))) { stray++; console.log('       ' + path.basename(x.file) + ' also differs in ' + JSON.stringify(diff)); }
  }
}
check(wrongMove === 0, `${moved} existing entries moved, ${kept} left where they were (${wrongMove} not where the rules put them)`);
check(stray === 0, `each backed-up entry differs from its backup only in isStarred, cwd and originCwd (${stray} differ elsewhere)`);

console.log('--- 5. every entry file the run did not create or back up is as the sandbox was built');
const built = JSON.parse(fs.readFileSync(fingerprintsPath, 'utf8'));
let same = 0, changed = 0;
for (const x of entries.filter(y => !y.created)) {
  const rel = path.relative(store, x.file);
  if (backedUp.has(path.resolve(x.file).toLowerCase())) continue;
  if (built[rel] === sha(x.file)) same++; else { changed++; console.log('       changed without a backup: ' + rel); }
}
check(changed === 0 && same > 0, `${same} entry files unchanged since the build (${changed} changed without a backup)`);

console.log(fails ? `\nCHECK FAILED -- ${fails} problem(s)` : '\nCHECK CLEAN');
process.exit(fails ? 1 : 0);
