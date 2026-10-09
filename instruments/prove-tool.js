// Proves a build of session-restore.ps1 on sandboxes built from this computer's own Claude data,
// with checkers that share no code with it. Each pass builds its sandboxes with new-sandbox.ps1,
// runs its own scratch copy of the tool folder under test, checks what the tool says and writes,
// and removes its sandboxes. The tool folder given is only read.
// Usage: node prove-tool.js --tool <tool folder> --receiving <key> --source <key>
//          [--data <the tool's data folder>] [--pass <name>[,<name>...]] [--keep]
//   <key>    "<accountUuid>/<orgUuid>", as the tool prints them; the folders under
//            claude-code-sessions give both. The receiving account gets the source's groups and pins.
//   --data   where the tool keeps its own files (default .session-restore in the user profile);
//            only its known-accounts.json is read, and copied into the sandboxes
//   --pass   the passes to run (default all):
//     static               the tool's .ps1 files parse in Windows PowerShell 5.1 and are ASCII;
//                          its shared reads (check-shared-textread.ps1, check-shared-read.js) and
//                          lib\Transcripts.ps1 (check-transcript-lib.js)
//     run                  a run under the receiving account, its groups and pins taken out of the
//                          settings file and one pin the source lacks put in (the sidebar's own
//                          storage keeps its groups, and a run takes the state before from there):
//                          a dry run first, then the run, its entries and plan checked, the calls
//                          forward (one left unmade and listed again) and back, each checked, the
//                          faults verify-plan.js and verify-sidebar.js must catch, -Undo
//     calls                check-sidebar-calls.js, and faults in the script it must catch
//     source-by-id         the config names the source by its id, and no file names its email
//     source-from-settings the sidebar's own storage absent: the groups come from the settings file
//     source-from-list     neither holds the source's groups: they come from the list saved under it
//     as-source            signed in as the source; the config's automatic setting
//     config               no account, an account no one has, a bad setting, steps refused
//     list                 the saved list and what the tool says of it; its failures; a fault in
//                          the script; signed in as the receiving account
//     export-import        export and import, their refusals, the faults the checkers must catch
//                          in an import's plan and in an export, an import under the other
//                          account and back (with a deleted group's section left behind as a
//                          fault), chats created after the file, a list without pins, -Undo
//     sections             sidebar-sim.js against the sections the app was seen to write
//     left-alone           a plan that leaves the groups alone: only pin calls, and its faults
//   --keep   keep the work folder (the scratch copies and every run's output) even when clean
// It needs Windows, Node, Windows PowerShell 5.1 and the Claude desktop app's data for both
// accounts; the source with at least one group holding a chat; for "calls", 215 chats of the
// receiving account the sidebar tools can change and one archived. Sandboxes are under
// session-restore-sandboxes in the temp folder; the work folder is session-restore-proof-<time>
// there, removed at the end unless something is wrong or --keep is given. Group names are matched
// as the console prints them: a name outside ASCII may not match.
// Verdict: PROOF CLEAN (exit 0), PROOF INCOMPLETE when something could not be tested on this
// data (exit 3), PROOF: n WRONG (exit 1).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const stage = require('./stage-sandbox.js');
const faults = require('./make-faults.js');
// Windows PowerShell 5.1 started with PowerShell 7's PSModulePath finds 7's copies of the modules
// both have before its own and loses commands such as Get-FileHash, which new-sandbox.ps1 needs;
// without the variable it builds its own path.
for (const k of Object.keys(process.env)) if (/^psmodulepath$/i.test(k)) delete process.env[k];

const here = __dirname;
const ALL = ['static', 'run', 'calls', 'source-by-id', 'source-from-settings', 'source-from-list', 'as-source', 'config', 'list', 'export-import', 'sections', 'left-alone'];
const opt = { pass: ALL.join(','), keep: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--keep') opt.keep = true;
  else if (['--tool', '--receiving', '--source', '--data', '--pass'].includes(a)) opt[a.slice(2)] = argv[++i];
  else { console.error('unknown argument ' + a); process.exit(2); }
}
const keyRe = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
if (!opt.tool || !keyRe.test(opt.receiving || '') || !keyRe.test(opt.source || '')) {
  console.error('usage: node prove-tool.js --tool <tool folder> --receiving <account/org> --source <account/org> [--data <dir>] [--pass <names>] [--keep]');
  process.exit(2);
}
const passes = opt.pass.split(',').map(s => s.trim()).filter(Boolean);
for (const p of passes) if (!ALL.includes(p)) { console.error('unknown pass ' + p + '; the passes are ' + ALL.join(', ')); process.exit(2); }
for (const n of ['session-restore.ps1', 'session-restore.config.json', 'lib']) if (!fs.existsSync(path.join(opt.tool, n))) { console.error(`the tool folder has no ${n}: ${opt.tool}`); process.exit(2); }
const RK = opt.receiving, SK = opt.source;
const [recvAcct] = RK.split('/'), [srcAcct] = SK.split('/');
const known = path.join(opt.data || path.join(os.homedir(), '.session-restore'), 'known-accounts.json');
const startedAt = new Date();
const work = path.join(os.tmpdir(), 'session-restore-proof-' + startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15));
const logs = path.join(work, 'logs');
fs.mkdirSync(logs, { recursive: true });

// ---------------------------------------------------------------- the verdicts
let wrong = 0, untested = 0;
const ok = (good, title, detail) => { console.log((good ? '  ok   ' : '  WRONG ') + title + (detail ? ` (${detail})` : '')); if (!good) wrong++; };
const skip = (title, why) => { console.log(`  --   ${title}: not tested, ${why}`); untested++; };
const show = lines => { for (const l of lines.filter(x => x.trim()).slice(-14)) console.log('       | ' + (l.length > 220 ? l.slice(0, 220) + ' ...' : l)); };
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function expect(lines, re, title) { const hit = lines.some(l => re.test(l)); ok(hit, title); if (!hit) show(lines); return hit; }
function expectNot(lines, re, title) { const hit = lines.filter(l => re.test(l)); ok(hit.length === 0, title); if (hit.length) show(hit); }
function expectLast(lines, re, title) { const last = lines.filter(l => l.trim()).pop() || ''; ok(re.test(last), title, re.test(last) ? null : 'its last line: ' + last); }
function mergeFaults(mode, args) { const r = faults.run(mode, args); wrong += r.wrong; untested += r.untested; }

// ---------------------------------------------------------------- running things
let logCount = 0;
function powershell(file, args, opts = {}) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8', cwd: opts.cwd || work, env: opts.env || process.env, maxBuffer: 256 * 1024 * 1024 });
}
function tool(b, dir, args, opts = {}) {
  const x = powershell(path.join(dir, 'session-restore.ps1'), [...args, '-UserProfile', b.profile], opts);
  const text = (x.stdout || '') + (x.stderr || '');
  logCount++;
  fs.writeFileSync(path.join(logs, `${String(logCount).padStart(3, '0')}-${b.name}-${(args.join(' ').replace(/[^A-Za-z]+/g, '') || 'run').slice(0, 30)}.log`), text);
  return text.split(/\r?\n/);
}
function node(args) {
  const x = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = (x.stdout || '') + (x.stderr || '');
  return { status: x.status, lines: out.split(/\r?\n/), last: out.trim().split(/\r?\n/).pop() || '' };
}
function checker(title, args, want = 0) {
  const x = node(args);
  ok(x.status === want, title, x.status === want ? x.last : `exit ${x.status}`);
  if (x.status !== want) show(x.lines);
  return x;
}
const instrument = n => path.join(here, n);

// ---------------------------------------------------------------- sandboxes and scratch copies
const built = new Set();
function newBox(name, account, withKnown = true) {
  const b = stage.box(name);
  if (fs.existsSync(b.sandbox)) removeBox(b);
  const x = powershell(instrument('new-sandbox.ps1'), ['-Name', name, '-SignedInAccount', account]);
  if (x.status !== 0 || !fs.existsSync(b.prefs)) throw new Error(`new-sandbox.ps1 could not build ${name}: ${((x.stdout || '') + (x.stderr || '')).trim().split(/\r?\n/).slice(-2).join(' | ')}`);
  built.add(name);
  fs.mkdirSync(b.data, { recursive: true });
  if (withKnown && fs.existsSync(known)) fs.copyFileSync(known, path.join(b.data, 'known-accounts.json'));
  return b;
}
function removeBox(b) {
  powershell(instrument('new-sandbox.ps1'), ['-Name', b.name, '-Remove']);
  if (fs.existsSync(b.sandbox)) throw new Error('new-sandbox.ps1 could not remove ' + b.sandbox);
  built.delete(b.name);
}
function compareBox(b, title) {
  const x = powershell(instrument('new-sandbox.ps1'), ['-Name', b.name, '-Compare']);
  const lines = ((x.stdout || '') + (x.stderr || '')).split(/\r?\n/);
  ok(lines.some(l => /; 0 changed, 0 gone, 0 added\.$/.test(l)), title, (lines.find(l => l.startsWith('Compared')) || '').trim());
}
function toolCopy(name) {
  const dir = path.join(work, 'tool-' + name);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  for (const n of ['session-restore.ps1', 'session-restore.config.json']) fs.copyFileSync(path.join(opt.tool, n), path.join(dir, n));
  for (const n of fs.readdirSync(path.join(opt.tool, 'lib'))) fs.copyFileSync(path.join(opt.tool, 'lib', n), path.join(dir, 'lib', n));
  return dir;
}
// the scratch copy's config names an account by its email when one is known, else by its id
function setConfig(dir, account, auto, byId = false) {
  const form = byId || !stage.emailOf(known, account) ? 'id' : 'email';
  stage.config(path.join(opt.tool, 'session-restore.config.json'), path.join(dir, 'session-restore.config.json'), account, form, auto, known);
}
const labelOf = account => stage.emailOf(known, account) || account;
const manifests = dir => fs.readdirSync(dir).filter(n => /^created-entries-\d{8}-\d{6}\.txt$/.test(n)).sort();
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const prefsOf = b => readJson(b.prefs).preferences.epitaxyPrefs;
const entryIds = (b, key) => fs.readdirSync(b.entries(key)).filter(n => /^local_.*\.json$/.test(n)).map(n => n.replace(/\.json$/, ''));

// the run's entries, when it created any, and its plan
function checkRun(b, dir, out, sourceKeyForEntries, planArgs) {
  const m = manifests(dir).pop();
  if (m) {
    const st = m.replace(/^created-entries-|\.txt$/g, '');
    const args = [instrument('verify-entries.js'), b.profile, path.join(dir, m), planArgs[1], sourceKeyForEntries, b.fingerprints];
    const backup = path.join(b.data, 'backups', st);
    if (fs.existsSync(backup)) args.push(backup);
    checker('verify-entries.js on the run', args);
  } else expect(out, /^Nothing to create/, 'the run created no entry, and says so');
  if (planArgs[0]) checker('verify-plan.js on the plan' + (planArgs[2] ? ` (${planArgs[2].join(' ')})` : ''), [instrument('verify-plan.js'), b.profile, b.plan, planArgs[0], planArgs[1], ...(planArgs[2] || [])]);
}
// the calls -Sidebar lists, made by the stand-in until the sidebar matches the plan; gives
// whether it then matches, and the calls first listed
function applyCalls(b, dir, key, back = false, skipOne = false) {
  const flag = back ? ['-Sidebar', '-Back'] : ['-Sidebar'];
  let out = tool(b, dir, flag);
  if (!expect(out, /^\d+ call\(s\) left for the app's sidebar tools/, `-Sidebar${back ? ' -Back' : ''} lists the calls`)) return { matched: false, calls: [] };
  const calls = readJson(b.calls).calls;
  const sim = n => { const x = node([instrument('sidebar-sim.js'), b.profile, key, b.calls, ...(n ? ['--skip', String(n)] : [])]); ok(x.status === 0, 'sidebar-sim.js makes them' + (n ? `, all but call ${n}` : ''), x.last); };
  if (skipOne) {
    sim(2);
    out = tool(b, dir, flag);
    expect(out, /^\d+ call\(s\) left for the app's sidebar tools/, 'with a call left unmade, -Sidebar lists what is left');
  }
  sim(0);
  out = tool(b, dir, flag);
  return { matched: expect(out, /^The sidebar matches the plan\. Nothing is left to do\.$/, `then -Sidebar${back ? ' -Back' : ''} says the sidebar matches the plan`), calls };
}
// the source's grouped and pinned chats, by transcript, written as a list to avoid
function sourceAvoid(b) {
  const ep = prefsOf(b);
  const scope = (ep['dframe-group-scopes'] || {})[SK] || { assignments: {} };
  const ids = new Set([...Object.keys(scope.assignments || {}).filter(k => k.startsWith('code:')).map(k => k.slice(5)), ...(ep['starred-local-code-sessions'] || [])]);
  const t = [];
  for (const id of ids) { const f = path.join(b.entries(SK), id + '.json'); try { const e = readJson(f); if (e.cliSessionId) t.push(e.cliSessionId); } catch { /* not the source's */ } }
  const file = path.join(b.sandbox, 'avoid.json');
  fs.writeFileSync(file, JSON.stringify({ groups: [{ name: 'avoid', transcripts: t }], pinned: [] }));
  return file;
}
// the receiving account's pins replaced by one the source does not have
function pinsReplaced(b) {
  const p = readJson(b.prefs), ep = p.preferences.epitaxyPrefs, mine = new Set(entryIds(b, RK));
  ep['starred-local-code-sessions'] = (ep['starred-local-code-sessions'] || []).filter(id => !mine.has(id));
  stage.write(b.prefs, p);
  const extra = stage.pick(b.prefs, RK, b.entries(RK), Date.now(), sourceAvoid(b));
  if (extra) stage.pin(b.prefs, extra);
  return extra;
}
// an account's groups and pins as the tool's -Sidebar and its saved list read them
function sidebarNow(b, key) {
  const ep = prefsOf(b), ids = new Set();
  for (const n of fs.readdirSync(b.entries(key)).filter(x => /^local_.*\.json$/.test(x))) { try { ids.add(readJson(path.join(b.entries(key), n)).sessionId || n.replace(/\.json$/, '')); } catch { /* unreadable entry */ } }
  const scope = (ep['dframe-group-scopes'] || {})[key];
  const groups = [], byId = new Map();
  if (scope) {
    for (const g of scope.groups || []) { if (typeof g.id !== 'string' || typeof g.name !== 'string' || byId.has(g.id)) continue; const item = { name: g.name, sessions: [] }; groups.push(item); byId.set(g.id, item); }
    const placed = new Set(), a = scope.assignments || {}, o = scope.order || {};
    for (const gid of Object.keys(o)) { if (!byId.has(gid) || !Array.isArray(o[gid])) continue; for (const k of o[gid]) if (typeof k === 'string' && k.startsWith('code:') && a[k] === gid && !placed.has(k)) { placed.add(k); byId.get(gid).sessions.push(k.slice(5)); } }
    for (const k of Object.keys(a)) if (byId.has(a[k]) && k.startsWith('code:') && !placed.has(k)) { placed.add(k); byId.get(a[k]).sessions.push(k.slice(5)); }
  }
  return { groups, pinned: new Set((ep['starred-local-code-sessions'] || []).filter(id => ids.has(id))).size };
}
const summary = now => `${now.groups.length ? now.groups.map(g => `"${g.name}" (${g.sessions.length})`).join(', ') : 'no groups with chats'}; ${now.pinned} pinned`;
// what a saved list or an export holds, in the tool's words; the counts are verify-list.js's to check
function contentRe(now) {
  const parts = now.groups.map(g => `"${esc(g.name)}" \\(\\d+ chats?\\)`);
  const text = parts.length === 0 ? 'no group holding a chat' : parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  return text + ', and (?:no pinned chat|\\d+ pinned chats?)';
}
function handPlan(b, receivingKey, sourceKey) {
  const [ra, ro] = receivingKey.split('/'), [sa, so] = sourceKey.split('/'), ms = Date.now() - 60000;
  fs.writeFileSync(b.plan, JSON.stringify({ v: 1, run: '20200101-000000', madeAtMs: ms, madeAt: new Date(ms).toISOString(),
    receiving: { accountUuid: ra, organizationUuid: ro }, source: { accountUuid: sa, organizationUuid: so, groupsReadFrom: 'a test' },
    aim: 'desired', desired: { groups: null, pinned: null }, before: { groups: null, pinned: null } }, null, 2));
}
const template = /^This is the account session-restore\.config\.json names in copyGroupsFromEmail: after a switch, a run under another account copies these groups and pins\.$/;
const savedFor = (label, key) => new RegExp(`^Saved for a switch: the groups and pins of ${esc(label)}: .+, in .+\\\\sidebar-list-${esc(key.split('/')[0])}\\.json\\. Read back, the file holds exactly these\\.$`);
const safeName = s => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');

// ---------------------------------------------------------------- the passes
const pass = {};

pass.static = () => {
  const dir = toolCopy('static');
  for (const f of ['session-restore.ps1', ...fs.readdirSync(path.join(dir, 'lib')).map(n => 'lib\\' + n)]) {
    const full = path.join(dir, f);
    const x = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:SR_FILE, [ref]$null, [ref]$e); $e.Count'], { encoding: 'utf8', env: { ...process.env, SR_FILE: full } });
    ok((x.stdout || '').trim() === '0', `${f} parses in Windows PowerShell 5.1`, `${(x.stdout || '').trim()} error(s)`);
    const bytes = fs.readFileSync(full);
    ok(!bytes.some(c => c > 0x7f), `${f} is pure ASCII`);
  }
  const t = powershell(instrument('check-shared-textread.ps1'), ['-Tool', dir]);
  const tl = ((t.stdout || '') + (t.stderr || '')).trim().split(/\r?\n/);
  ok(/CLEAN/.test(tl[tl.length - 1] || ''), 'check-shared-textread.ps1', tl[tl.length - 1]);
  checker('check-transcript-lib.js', [instrument('check-transcript-lib.js'), dir]);
  checker('check-shared-read.js', [instrument('check-shared-read.js'), dir]);
};

pass.run = () => {
  const dir = toolCopy('run');
  const b = newBox('srp-run', recvAcct);
  setConfig(dir, srcAcct, 0);
  const asBuilt = fs.readFileSync(b.prefs);
  stage.wipe(b.prefs, RK, b.entries(RK));
  const extra = pinsReplaced(b);
  if (!extra) skip('a pin the source does not have', 'no chat of the receiving account to pin');
  let out = tool(b, dir, ['-DryRun']);
  expect(out, /^DRY RUN - /, 'a dry run says what it would do');
  ok(!fs.existsSync(b.plan) && !manifests(dir).length && !fs.existsSync(path.join(b.data, 'backups')), 'and writes no plan, manifest or backup');
  out = tool(b, dir, []);
  const label = labelOf(srcAcct);
  expect(out, new RegExp(`^--- groups, pins and folders: as in ${esc(label)} ---$`), 'the run names the source account');
  expect(out, new RegExp(`^Groups in ${esc(label)} \\(read from the sidebar's own storage\\): .+`), "its groups are read from the sidebar's own storage");
  if (!expect(out, /^Sidebar plan saved: /, 'a plan is saved')) return removeBox(b);
  checkRun(b, dir, out, SK, [SK, RK]);
  mergeFaults('plan', [b.profile, b.plan, SK, RK]);
  const ref = path.join(b.sandbox, 'prefs-before-calls.json');
  fs.copyFileSync(b.prefs, ref);
  if (applyCalls(b, dir, RK, false, true).matched) {
    checker('verify-sidebar.js, aim desired', [instrument('verify-sidebar.js'), b.profile, b.plan, 'desired', ref]);
    mergeFaults('sidebar', [b.profile, b.plan, ref]);
    if (applyCalls(b, dir, RK, true).matched) checker('verify-sidebar.js, aim before', [instrument('verify-sidebar.js'), b.profile, b.plan, 'before', ref]);
  }
  fs.writeFileSync(b.prefs, asBuilt);
  out = tool(b, dir, ['-Undo']);
  expect(out, /^Org dir now has \d+ entries\.$/, '-Undo walks the run back');
  ok(readJson(b.plan).aim === 'before', 'and the plan now aims at the state before the run');
  compareBox(b, 'the sandbox is as it was built');
  removeBox(b);
};

pass.calls = () => {
  const dir = toolCopy('calls');
  const b = newBox('srp-calls', recvAcct);
  const x = node([instrument('check-sidebar-calls.js'), dir, b.profile, RK]);
  if (/needs 215 and 1/.test(x.lines.join('\n'))) skip('check-sidebar-calls.js and the faults in the script', 'the receiving account has fewer than 215 chats the tools can change, or no archived chat');
  else {
    ok(x.status === 0, 'check-sidebar-calls.js', x.status === 0 ? x.last : `exit ${x.status}`);
    if (x.status !== 0) show(x.lines);
    mergeFaults('script', [dir, b.profile, RK, work]);
  }
  removeBox(b);
};

pass['source-by-id'] = () => {
  const dir = toolCopy('by-id');
  const b = newBox('srp-by-id', recvAcct, false);
  const removed = stage.forgetAccount(b.profile, srcAcct);
  ok(true, `the sandbox knows no email for the source (${removed} account file(s) naming it removed, no known-accounts.json)`);
  setConfig(dir, srcAcct, 0, true);
  const asBuilt = fs.readFileSync(b.prefs);
  stage.wipe(b.prefs, RK, b.entries(RK));
  const out = tool(b, dir, []);
  expect(out, new RegExp(`^--- groups, pins and folders: as in ${esc(srcAcct)} ---$`), 'the source is named by its id');
  expect(out, new RegExp(`^Groups in ${esc(srcAcct)} \\(read from the sidebar's own storage\\): .+`), "its groups are read from the sidebar's own storage");
  if (expect(out, /^Sidebar plan saved: /, 'a plan is saved')) {
    checkRun(b, dir, out, SK, [SK, RK]);
    const ref = path.join(b.sandbox, 'prefs-before-calls.json');
    fs.copyFileSync(b.prefs, ref);
    if (applyCalls(b, dir, RK).matched) checker('verify-sidebar.js, aim desired', [instrument('verify-sidebar.js'), b.profile, b.plan, 'desired', ref]);
  }
  fs.writeFileSync(b.prefs, asBuilt);
  tool(b, dir, ['-Undo']);
  compareBox(b, '-Undo, then the sandbox is as it was built');
  removeBox(b);
};

pass['source-from-settings'] = () => {
  const dir = toolCopy('from-settings');
  const b = newBox('srp-from-settings', recvAcct);
  setConfig(dir, srcAcct, 0);
  const asBuilt = fs.readFileSync(b.prefs);
  stage.wipe(b.prefs, RK, b.entries(RK));
  const aside = path.join(b.sandbox, 'leveldb.aside');
  fs.renameSync(b.leveldb, aside);
  try {
    const out = tool(b, dir, []);
    expect(out, new RegExp(`^Groups in ${esc(labelOf(srcAcct))} \\(read from the app's settings file\\): .+`), "the groups are read from the app's settings file");
    if (expect(out, /^Sidebar plan saved: /, 'a plan is saved')) checkRun(b, dir, out, SK, [SK, RK, ['--source-from', 'prefs']]);
    tool(b, dir, ['-Undo']);
  } finally { fs.renameSync(aside, b.leveldb); fs.writeFileSync(b.prefs, asBuilt); }
  compareBox(b, '-Undo, storage and settings put back, then the sandbox is as it was built');
  removeBox(b);
};

pass['source-from-list'] = () => {
  const sdir = toolCopy('list-source');
  const s = newBox('srp-list-source', srcAcct);
  setConfig(sdir, 'none', 0);
  let out = tool(s, sdir, ['-Sidebar']);
  expect(out, new RegExp(`^Groups here now: ${esc(summary(sidebarNow(s, SK)))}\\.$`), "-Sidebar under the source shows its groups and pins");
  expect(out, /^No sidebar plan is saved/, 'and says no plan is saved');
  const list = path.join(s.data, `sidebar-list-${srcAcct}.json`);
  const saved = fs.existsSync(list);
  ok(saved, "and saves the list of the source's groups");
  if (!saved) return removeBox(s);
  const dir = toolCopy('from-list');
  const b = newBox('srp-from-list', recvAcct);
  fs.copyFileSync(list, path.join(b.data, path.basename(list)));
  removeBox(s);
  setConfig(dir, srcAcct, 0);
  const asBuilt = fs.readFileSync(b.prefs);
  stage.wipe(b.prefs, RK, b.entries(RK));
  stage.dropScope(b.prefs, SK);
  const aside = path.join(b.sandbox, 'leveldb.aside');
  fs.renameSync(b.leveldb, aside);
  try {
    out = tool(b, dir, []);
    expect(out, new RegExp(`^Groups in ${esc(labelOf(srcAcct))} \\(read from the list this script saved on \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\): .+`), 'the groups are read from the saved list, with the time it was saved');
    if (expect(out, /^Sidebar plan saved: /, 'a plan is saved')) checkRun(b, dir, out, SK, [SK, RK, ['--source-from', 'list:' + path.join(b.data, path.basename(list))]]);
    tool(b, dir, ['-Undo']);
  } finally { fs.renameSync(aside, b.leveldb); fs.writeFileSync(b.prefs, asBuilt); }
  compareBox(b, '-Undo, storage and settings put back, then the sandbox is as it was built');
  removeBox(b);
};

pass['as-source'] = () => {
  const dir = toolCopy('as-source');
  const b = newBox('srp-as-source', srcAcct);
  const label = labelOf(srcAcct);
  setConfig(dir, srcAcct, 0);
  let out = tool(b, dir, []);
  expect(out, new RegExp(`^Nothing planned\\. You are signed in as ${esc(label)}, the account the groups and pins come from\\.$`), 'signed in as the account the config names: nothing planned');
  ok(!fs.existsSync(b.plan), 'and no plan is written');
  ok(fs.existsSync(path.join(b.data, `sidebar-list-${srcAcct}.json`)), 'and the list of its own groups is saved');
  tool(b, dir, ['-Undo']);
  setConfig(dir, recvAcct, 1);
  const cfg = path.join(dir, 'session-restore.config.json');
  const cfgBefore = fs.readFileSync(cfg);
  out = tool(b, dir, []);
  expect(out, new RegExp(`^Config  : copyGroupsFromEmail now names ${esc(label)}, the account signed in for this run \\(autoUpdateCopyGroupsFromEmail is 1\\)\\.$`), 'the automatic setting names the account signed in, after the copy');
  const now = readJson(cfg), base = readJson(path.join(opt.tool, 'session-restore.config.json'));
  const keptOthers = Object.keys(base).filter(k => !['copyGroupsFromEmail', 'autoUpdateCopyGroupsFromEmail'].includes(k)).every(k => JSON.stringify(now[k]) === JSON.stringify(base[k]));
  ok(now.copyGroupsFromEmail === (stage.emailOf(known, srcAcct) || srcAcct) && now.autoUpdateCopyGroupsFromEmail === 1 && keptOthers && fs.readFileSync(cfg, 'utf8').endsWith('\n'), 'the config now names that account, and keeps its other settings and its last line end');
  if (fs.existsSync(b.plan)) checkRun(b, dir, out, RK, [RK, SK, ['--source-from', out.some(l => /^Groups: not planned\./.test(l)) ? 'none' : 'store']]);
  out = tool(b, dir, ['-DryRun']);
  expect(out, /^Nothing planned\. You are signed in as /, 'the next run under the same account plans nothing: the config names the account itself');
  out = tool(b, dir, ['-Undo']);
  expect(out, /^Put back every file run /, '-Undo puts the run\'s files back');
  ok(fs.readFileSync(cfg).equals(cfgBefore), 'and the config file is byte for byte as it was before the run');
  compareBox(b, 'the sandbox is as it was built');
  removeBox(b);
};

pass.config = () => {
  const dir = toolCopy('config');
  const b = newBox('srp-config', recvAcct);
  const cfg = path.join(dir, 'session-restore.config.json');
  const dataBefore = fs.readdirSync(b.data).sort().join(',');
  setConfig(dir, 'none', 0);
  let out = tool(b, dir, ['-DryRun']);
  expect(out, /^Groups, pins and folders: nothing planned \(session-restore\.config\.json names no account in copyGroupsFromEmail\)\.$/, 'no account named: nothing planned');
  fs.writeFileSync(cfg, '{"copyGroupsFromEmail":"nobody@example.com","autoUpdateCopyGroupsFromEmail":0}');
  out = tool(b, dir, ['-DryRun']);
  expect(out, /^Nothing planned\. copyGroupsFromEmail in session-restore\.config\.json names nobody@example\.com, which is neither/, 'an account no one has: nothing planned, and the reason given');
  fs.writeFileSync(cfg, '{"copyGroupsFromEmail":"nobody@example.com","autoUpdateCopyGroupsFromEmail":2}');
  out = tool(b, dir, ['-DryRun']);
  expect(out, /autoUpdateCopyGroupsFromEmail in session-restore\.config\.json must be 0 or 1/, 'an automatic setting other than 0 or 1 is refused');
  setConfig(dir, srcAcct, 0);
  out = tool(b, dir, ['-Back']);
  expect(out, /^-Back goes with -Sidebar/, '-Back without -Sidebar is refused');
  out = tool(b, dir, ['-Sidebar', '-DryRun']);
  expect(out, /^-Sidebar is a step of its own/, '-Sidebar with -DryRun is refused');
  ok(fs.readdirSync(b.data).sort().join(',') === dataBefore && !manifests(dir).length, 'and none of these wrote anything');
  removeBox(b);
};

pass.list = () => {
  const dir = toolCopy('list');
  const b = newBox('srp-list-save', srcAcct);
  const label = labelOf(srcAcct);
  setConfig(dir, srcAcct, 0);
  const listPath = path.join(b.data, `sidebar-list-${srcAcct}.json`);
  const hash = p => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
  handPlan(b, RK, SK);
  let out = tool(b, dir, ['-Sidebar']);
  const now = sidebarNow(b, SK);
  expect(out, new RegExp(`^Groups here now: ${esc(summary(now))}\\.$`), 'the groups and pins as they are now');
  expect(out, /^The saved sidebar plan \(run \d{8}-\d{6}\) was made for another account, not the one signed in\. Nothing to apply here\.$/, 'a plan made for the other account is not applied');
  expect(out, new RegExp(`^Saved for a switch: the groups and pins of ${esc(label)}: ${contentRe(now)}, in .+\\\\sidebar-list-${esc(srcAcct)}\\.json\\. Read back, the file holds exactly these\\.$`), 'it says what it saved and where');
  expectLast(out, template, 'and ends by saying this is the account the groups come from');
  checker('verify-list.js', [instrument('verify-list.js'), b.profile, SK]);
  mergeFaults('list', [b.profile, SK, listPath]);
  fs.unlinkSync(b.plan);
  out = tool(b, dir, ['-Sidebar']);
  expect(out, /^No sidebar plan is saved/, 'with no plan, it says so');
  expect(out, savedFor(label, SK), 'and saves the list all the same');
  expectLast(out, template, 'and ends with the account the groups come from');
  const prefsBytes = fs.readFileSync(b.prefs);
  let before = hash(listPath);
  fs.writeFileSync(b.prefs, '{');
  out = tool(b, dir, ['-Sidebar']);
  expect(out, /^Nothing listed: the app's settings file could not be read/, 'an unreadable settings file: nothing listed, and why');
  expect(out, new RegExp(`^NOT saved for a switch: the groups and pins of ${esc(label)} could not be saved, because the app's settings file could not be read .+\\. The list saved before, if any, is as it was\\.$`), 'NOT saved, and why');
  expectNot(out, /^Saved for a switch/, 'no line says it was saved');
  ok(hash(listPath) === before, 'the list saved before is byte for byte as it was');
  fs.writeFileSync(b.prefs, prefsBytes);
  fs.chmodSync(listPath, 0o444);
  out = tool(b, dir, ['-Sidebar']);
  expect(out, new RegExp(`^NOT saved for a switch: the groups and pins of ${esc(label)} could not be saved, because .+\\. The list saved before, if any, is as it was\\.$`), 'a list that cannot be replaced: NOT saved, and why');
  ok(hash(listPath) === before && !fs.existsSync(listPath + '.session-restore.tmp'), 'the old list is as it was, and no half-written list is left');
  fs.chmodSync(listPath, 0o666);
  stage.dropScope(b.prefs, SK);
  out = tool(b, dir, ['-Sidebar']);
  expect(out, /^Groups here now: no groups with chats; \d+ pinned\.$/, 'no group in the settings file: none shown');
  expect(out, new RegExp(`^Saved for a switch: the groups and pins of ${esc(label)}: no group holding a chat, and `), 'and the list now says it holds none');
  checker('verify-list.js', [instrument('verify-list.js'), b.profile, SK]);
  fs.writeFileSync(b.prefs, prefsBytes);
  out = tool(b, dir, ['-Sidebar']);
  expect(out, new RegExp(`^Saved for a switch: the groups and pins of ${esc(label)}: ${contentRe(now)}, in `), 'with the settings file put back, the groups are saved again');
  // a fault in a copy of the script: what is written differs from what was meant
  const faulty = toolCopy('list-fault');
  fs.copyFileSync(path.join(dir, 'session-restore.config.json'), path.join(faulty, 'session-restore.config.json'));
  const file = path.join(faulty, 'session-restore.ps1');
  const src = fs.readFileSync(file, 'utf8');
  const anchor = "    $item['transcripts'] = $transcripts.ToArray()\n    $groups.Add($item)\n    $meant.Add(";
  if (src.split(anchor).length - 1 !== 1) ok(false, 'a fault in the saved list: its anchor is not in the script exactly once; this case must be brought up to date with it');
  else {
    fs.writeFileSync(file, src.replace(anchor, () => "    $item['transcripts'] = @($transcripts.ToArray() | Select-Object -Skip 1)\n    $groups.Add($item)\n    $meant.Add("));
    before = hash(listPath);
    out = tool(b, faulty, ['-Sidebar']);
    if (now.groups.some(g => g.sessions.length)) {
      expect(out, new RegExp(`^NOT saved for a switch: the groups and pins of ${esc(label)} could not be saved, because the new list, read back, differs from what was written\\. The list saved before, if any, is as it was\\.$`), 'a fault in a copy of the script: the read-back catches it, NOT saved');
      ok(hash(listPath) === before, 'and the old list is as it was');
    } else skip('a fault in a copy of the script', 'no group holds a chat');
  }
  out = tool(b, dir, []);
  expect(out, new RegExp(`^Nothing planned\\. You are signed in as ${esc(label)}, the account the groups and pins come from\\.$`), 'a run under that account plans nothing');
  expect(out, savedFor(label, SK), 'and says what it saved');
  expect(out, template, 'and that this is the account the groups come from');
  checker('verify-list.js', [instrument('verify-list.js'), b.profile, SK]);
  checkRun(b, dir, out, 'none/none', [null, SK]);
  tool(b, dir, ['-Undo']);
  compareBox(b, '-Undo, then the sandbox is as it was built');
  removeBox(b);
  // signed in as the receiving account, with a plan for it: no template line
  const rdir = toolCopy('list-receiving');
  const r = newBox('srp-list-receiving', recvAcct);
  setConfig(rdir, srcAcct, 0);
  handPlan(r, RK, SK);
  out = tool(r, rdir, ['-Sidebar']);
  expect(out, savedFor(labelOf(recvAcct), RK), "signed in as the receiving account: it says what it saved of that account");
  expectNot(out, template, 'and does not call it the account the groups come from');
  expectLast(out, /^(Saved for a switch: |  \d+ chat\(s\) filed in a group or pinned here have no chat entry)/, 'what was saved comes last');
  checker('verify-list.js', [instrument('verify-list.js'), r.profile, RK]);
  out = tool(r, rdir, ['-Sidebar', '-Back']);
  expectLast(out, /^(Saved for a switch: |  \d+ chat\(s\) filed in a group or pinned here have no chat entry)/, '-Sidebar -Back also ends with what was saved');
  removeBox(r);
};

pass['export-import'] = () => {
  const dir = toolCopy('export');
  const s = newBox('srp-export', srcAcct);
  const label = labelOf(srcAcct);
  setConfig(dir, srcAcct, 0);
  const now = sidebarNow(s, SK);
  const exportLine = new RegExp(`^Exported: the groups and pins of ${esc(label)}: ${contentRe(now)}, to (.+\\\\exports\\\\groups-${esc(safeName(label))}-\\d{8}-\\d{6}\\.json)\\. Read back, the file holds exactly these\\.$`);
  let out = tool(s, dir, ['-Export']);
  const hit = out.map(l => exportLine.exec(l)).find(Boolean);
  ok(!!hit, 'an export with no file named goes to exports, named with the account and the time');
  if (!hit) { show(out); return removeBox(s); }
  const exp1 = hit[1];
  expect(out, /^  powershell -ExecutionPolicy Bypass -File ".+\\session-restore\.ps1" -Import ".+\.json"$/, 'and it says how to import it');
  checker('verify-list.js on the export', [instrument('verify-list.js'), s.profile, SK, '--file', exp1]);
  mergeFaults('list', [s.profile, SK, exp1]);
  const named = path.join(s.sandbox, 'named-export.json');
  out = tool(s, dir, ['-ExportTo', named]);
  expect(out, new RegExp(`^Exported: the groups and pins of ${esc(label)}: .+, to ${esc(named)}\\. Read back`), 'an export to a file named');
  const namedBytes = fs.readFileSync(named);
  out = tool(s, dir, ['-ExportTo', named]);
  expect(out, /^NOT exported: .+ already exists, and an export never replaces a file\.$/, 'an export to a file that exists is refused');
  ok(fs.readFileSync(named).equals(namedBytes), 'and that file is as it was');
  out = tool(s, dir, ['-ExportTo', path.join(s.sandbox, 'no-such-folder', 'x.json')]);
  expect(out, /^NOT exported: the folder .+no-such-folder does not exist\.$/, 'an export into a folder that does not exist is refused');
  tool(s, dir, ['-ExportTo', 'relative-export.json'], { cwd: s.sandbox });
  ok(fs.existsSync(path.join(s.sandbox, 'relative-export.json')), 'a relative path is taken from the folder the command runs in');
  const runsBefore = manifests(dir).length;
  out = tool(s, dir, ['-ExportTo', '']);
  expect(out, /^-ExportTo needs the file to write/, 'an empty -ExportTo is refused');
  const out2 = tool(s, dir, ['-Import', '']);
  expect(out2, /^-Import needs the file to import/, 'an empty -Import is refused');
  ok(manifests(dir).length === runsBefore && !out.concat(out2).some(l => /^Org dir/.test(l)), 'and neither falls through to a run');
  expect(tool(s, dir, ['-Export', '-DryRun']), /^-Export, -ExportTo and -Import are steps of their own/, '-Export with -DryRun is refused');
  expect(tool(s, dir, ['-Export', '-Import', exp1]), /^-Export, -ExportTo and -Import are steps of their own/, '-Export with -Import is refused');
  // the case it is for: the groups and pins gone from the app, brought back from an export
  const sBuilt = fs.readFileSync(s.prefs);
  stage.wipe(s.prefs, SK, s.entries(SK));
  out = tool(s, dir, ['-Sidebar']);
  expect(out, new RegExp(`^Saved for a switch: the groups and pins of ${esc(label)}: no group holding a chat, and no pinned chat, in `), 'with the groups and pins gone, the saved list follows the app and says so');
  out = tool(s, dir, ['-Import', exp1]);
  expect(out, new RegExp(`^Importing ${esc(exp1)}: the groups and pins of ${esc(label)}, saved \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d: ${contentRe(now)}\\.$`), 'the import says what the file holds');
  expect(out, /^Groups to reach here: /, 'the groups to reach');
  expect(out, /^Pins to reach here: \d+$/, 'the pins to reach');
  expect(out, /^Groups and pins: \d+ call\(s\) are left for the app's own sidebar tools/, 'calls are left for a session');
  checker('verify-plan.js, --source-from file', [instrument('verify-plan.js'), s.profile, s.plan, SK, SK, '--source-from', 'file:' + exp1]);
  mergeFaults('import', [s.profile, s.plan, SK, exp1]);
  const sref = path.join(s.sandbox, 'prefs-before-calls.json');
  fs.copyFileSync(s.prefs, sref);
  out = tool(s, dir, ['-Sidebar']);
  expect(out, new RegExp(`^Sidebar plan of run \\d{8}-\\d{6}, made .+: the groups and pins in .+, saved .+ under ${esc(label)}\\.$`), 'the listing names the file');
  if (applyCalls(s, dir, SK).matched) {
    checker('verify-sidebar.js, aim desired', [instrument('verify-sidebar.js'), s.profile, s.plan, 'desired', sref]);
    checker('verify-list.js: the saved list holds the groups and pins again', [instrument('verify-list.js'), s.profile, SK]);
    out = tool(s, dir, ['-Export']);
    const again = out.map(l => exportLine.exec(l)).find(Boolean);
    ok(!!again && stage.same(exp1, again[1]), 'a new export holds exactly the groups and pins of the first one');
  }
  fs.writeFileSync(s.prefs, sBuilt);
  // an export imported under the other account, and back
  const rdir = toolCopy('import');
  const r = newBox('srp-import', recvAcct);
  setConfig(rdir, srcAcct, 0);
  const rBuilt = fs.readFileSync(r.prefs);
  const file = path.join(r.sandbox, 'other-account-export.json');
  fs.copyFileSync(exp1, file);
  stage.wipe(r.prefs, RK, r.entries(RK));
  out = tool(r, rdir, ['-Import', file]);
  expect(out, new RegExp(`^Importing .+: the groups and pins of ${esc(label)}, saved `), 'the file of the other account is read');
  checker('verify-plan.js, --source-from file', [instrument('verify-plan.js'), r.profile, r.plan, SK, RK, '--source-from', 'file:' + file]);
  const rref = path.join(r.sandbox, 'prefs-before-calls.json');
  fs.copyFileSync(r.prefs, rref);
  if (applyCalls(r, rdir, RK).matched) {
    checker('verify-sidebar.js, aim desired', [instrument('verify-sidebar.js'), r.profile, r.plan, 'desired', rref]);
    const desired = path.join(r.sandbox, 'prefs-desired.json');
    fs.copyFileSync(r.prefs, desired);
    if (applyCalls(r, rdir, RK, true).matched) {
      checker('verify-sidebar.js, aim before', [instrument('verify-sidebar.js'), r.profile, r.plan, 'before', rref]);
      mergeFaults('sidebar-back', [r.profile, r.plan, rref, desired]);
    }
  }
  // chats created after the file was saved are left as they are
  tool(r, rdir, ['-Import', file]);
  applyCalls(r, rdir, RK);
  const list = readJson(file), savedMs = Date.parse(list.savedAt);
  const x = list.groups.length ? stage.pick(r.prefs, RK, r.entries(RK), savedMs, file) : null;
  if (!x) skip('a chat created after the file was saved', 'no group, or no chat outside the file');
  else {
    const xFile = path.join(r.entries(RK), x + '.json'), xBytes = fs.readFileSync(xFile);
    stage.newer(xFile, savedMs + 5000);
    stage.fileIn(r.prefs, RK, list.groups[0].name, x);
    stage.pin(r.prefs, x);
    tool(r, rdir, ['-Import', file]);
    out = tool(r, rdir, ['-Sidebar']);
    expect(out, /^1 grouped chat\(s\) were created after the plan was made and are left where they are\.$/, 'the chat created after the file was saved is named as left where it is');
    expect(out, /^The sidebar matches the plan/, 'and no call moves or unpins it');
    ok(stage.state(r.prefs, RK, x) === `${list.groups[0].name} pinned`, 'it is still filed and pinned');
    fs.writeFileSync(xFile, xBytes);
  }
  // what an import refuses, writing nothing
  const planBytes = fs.readFileSync(r.plan);
  expect(tool(r, rdir, ['-Import', path.join(r.sandbox, 'no-such.json')]), /^NOT imported: there is no file /, 'a file that is not there');
  expect(tool(r, rdir, ['-Import', r.plan]), /^NOT imported: .+ is not a list of groups and pins that this script saved or exported\.$/, 'a file that is not a list (the plan itself)');
  if (list.groups.length >= 2) {
    const dupe = path.join(r.sandbox, 'dupe.json');
    stage.dupe(file, dupe);
    expect(tool(r, rdir, ['-Import', dupe]), /^NOT imported: the file names the group ".+" twice/, 'a list naming one group twice');
  } else skip('a list naming one group twice', 'the file holds fewer than two groups');
  expect(tool(r, rdir, ['-Import', file, '-Sidebar']), /^-Export, -ExportTo and -Import are steps of their own/, '-Import with -Sidebar');
  ok(fs.readFileSync(r.plan).equals(planBytes), 'the plan is as it was after every refusal');
  // a list saved before lists kept pins
  const old = path.join(r.sandbox, 'list-without-pins.json');
  stage.noPins(file, old);
  out = tool(r, rdir, ['-Import', old]);
  expect(out, /^Pins: not planned\. The file was saved before lists kept pins/, 'a list without pins: its pins are not planned');
  checker('verify-plan.js, --source-from file', [instrument('verify-plan.js'), r.profile, r.plan, SK, RK, '--source-from', 'file:' + old]);
  // -Undo after an import
  out = tool(r, rdir, ['-Undo']);
  expect(out, /^Groups and pins: what a session already filed or pinned from this run's plan stays as it is in the app\./, "-Undo turns the import's plan around");
  ok(readJson(r.plan).aim === 'before', 'the plan now aims at the state before the import');
  ok(manifests(rdir).length === 0, 'and no run of the tool was undone with it');
  fs.writeFileSync(r.prefs, rBuilt);
  compareBox(r, 'the receiving sandbox is as it was built');
  compareBox(s, 'the source sandbox is as it was built');
  removeBox(r);
  removeBox(s);
};

pass.sections = () => {
  const b = newBox('srp-sections', recvAcct);
  const fixture = readJson(instrument('sidebar-sim-fixture.json'));
  const p = readJson(b.prefs), ep = p.preferences.epitaxyPrefs;
  if (ep['dframe-group-scopes']) delete ep['dframe-group-scopes'][RK];
  ep['dframe-code-sections'] = ep['dframe-code-sections'] || {};
  ep['dframe-code-sections'][RK] = JSON.parse(JSON.stringify(fixture.before));
  stage.write(b.prefs, p);
  const pinned = new Set(ep['starred-local-code-sessions'] || []);
  const ids = entryIds(b, RK).filter(id => { try { const e = readJson(path.join(b.entries(RK), id + '.json')); return e.isArchived !== true && !e.scheduledTaskId && !pinned.has(id); } catch { return false; } }).slice(0, 6);
  if (ids.length < 6) { skip('the stand-in against the sections the app wrote', 'fewer than six chats to file'); return removeBox(b); }
  const calls = path.join(b.sandbox, 'calls-fixture.json');
  fs.writeFileSync(calls, JSON.stringify({ calls: [
    { tool: 'create_group', arguments: { name: 'group 1' } }, { tool: 'move_sessions', arguments: { group: 'group 1', session_ids: ids.slice(0, 3) } },
    { tool: 'create_group', arguments: { name: 'group 2' } }, { tool: 'move_sessions', arguments: { group: 'group 2', session_ids: ids.slice(3) } }] }));
  const x = node([instrument('sidebar-sim.js'), b.profile, RK, calls]);
  ok(x.status === 0, 'sidebar-sim.js makes the calls', x.last);
  const got = JSON.parse(JSON.stringify(prefsOf(b)['dframe-code-sections'][RK]));
  for (const s of got.sections) if (s.kind === 'manual') { const w = fixture.after.sections.find(y => y.kind === 'manual' && y.name === s.name); if (w) s.id = w.id; }
  const same = JSON.stringify(got) === JSON.stringify(fixture.after);
  ok(same, 'sidebar-sim.js writes the sections byte for byte as the app wrote them, group ids aside');
  if (!same) { console.log('       | wanted ' + JSON.stringify(fixture.after)); console.log('       | got    ' + JSON.stringify(got)); }
  const damaged = JSON.parse(JSON.stringify(got)); delete damaged.sections.find(s => s.kind === 'sessions').groupBy;
  ok(JSON.stringify(damaged) !== JSON.stringify(fixture.after), 'control: without the groupBy the app set, the comparison fails');
  removeBox(b);
};

pass['left-alone'] = () => {
  const dir = toolCopy('left-alone');
  const b = newBox('srp-left-alone', recvAcct);
  setConfig(dir, srcAcct, 0);
  const asBuilt = fs.readFileSync(b.prefs);
  stage.emptyGroup(b.prefs, RK, 'an empty group');
  if (!pinsReplaced(b)) skip('a pin the source does not have', 'no chat of the receiving account to pin');
  const out = tool(b, dir, []);
  if (expect(out, /^Sidebar plan saved: /, 'a run saves a plan')) {
    stage.groupsLeftAlone(b.plan);
    const ref = path.join(b.sandbox, 'prefs-before-calls.json');
    fs.copyFileSync(b.prefs, ref);
    const applied = applyCalls(b, dir, RK);
    ok(applied.calls.length > 0 && applied.calls.every(c => c.tool === 'set_pinned'), 'the calls listed are pin calls only', applied.calls.map(c => c.tool).join(', '));
    if (applied.matched) {
      checker('verify-sidebar.js, aim desired', [instrument('verify-sidebar.js'), b.profile, b.plan, 'desired', ref]);
      mergeFaults('left-alone', [b.profile, b.plan, ref]);
    }
  }
  fs.writeFileSync(b.prefs, asBuilt);
  tool(b, dir, ['-Undo']);
  compareBox(b, '-Undo, then the sandbox is as it was built');
  removeBox(b);
};

// ---------------------------------------------------------------- the proof
console.log(`Proving ${path.resolve(opt.tool)}: receiving ${RK}, source ${SK}; work folder ${work}`);
const t0 = Date.now();
try {
  for (const name of passes) {
    const t = Date.now();
    console.log(`=== ${name}`);
    try { pass[name](); }
    catch (x) { ok(false, `the pass stopped: ${x.message}`); }
    finally { for (const n of [...built]) { try { removeBox(stage.box(n)); } catch (y) { ok(false, `a sandbox could not be removed: ${y.message}`); } } }
    console.log(`    (${Math.round((Date.now() - t) / 1000)} s)`);
  }
} finally {
  for (const n of [...built]) { try { removeBox(stage.box(n)); } catch { /* reported above */ } }
}
const verdict = wrong ? `PROOF: ${wrong} WRONG` : untested ? `PROOF INCOMPLETE: ${untested} not tested on this data` : 'PROOF CLEAN';
if (!wrong && !untested && !opt.keep) fs.rmSync(work, { recursive: true, force: true });
else console.log(`The work folder is kept: ${work}`);
console.log(`${verdict} (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(wrong ? 1 : untested ? 3 : 0);
