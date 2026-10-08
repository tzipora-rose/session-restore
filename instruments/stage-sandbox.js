// Stages states in a sandbox that new-sandbox.ps1 built, for prove-tool.js and for testing by
// hand. It writes only under the sandboxes' folder (session-restore-sandboxes in the temp
// folder), and refuses any other path. A key is "<accountUuid>/<orgUuid>".
//   wipe <prefs> <key> <entries dir>          the account's groups, its group sections and its pins
//                                             removed, as an account that has lost them
//   drop-scope <prefs> <key>                  the account's saved groups removed from the settings
//                                             file, nothing else
//   empty-group <prefs> <key> <name>          a group with no chat: its section before Ungrouped
//   pick <prefs> <key> <entries dir> <ms> [<list>]
//                                             prints an entry that is usable, in no group, unpinned,
//                                             created before ms, and whose transcript the list
//                                             does not name
//   newer <entry file> <ms>                   sets the entry's createdAt to ms
//   file-in <prefs> <key> <group> <entry id>  files the entry in the named group, at its end
//   pin <prefs> <entry id>                    pins the entry
//   state <prefs> <key> <entry id>            prints the entry's group name (or none) and whether
//                                             it is pinned
//   dupe <list> <out>                         writes the list with its first group's name given to
//                                             its second
//   no-pins <list> <out>                      writes the list without its pins, as a list saved
//                                             before lists kept pins
//   same <list a> <list b>                    exit 0 when both hold the same groups and pins
//   groups-left-alone <plan>                  the plan made to leave the groups alone
//   forget-account <profile> <account id>     removes the sandbox's Claude Code account files that
//                                             name the account, so its email is not known there
//   config <in> <out> <account id|none> <email|id> <0|1> [<known-accounts file>]
//                                             writes a scratch copy's config naming the account by
//                                             its email or its id (none: no account), with the
//                                             automatic setting; the other settings are copied
//                                             from <in>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(os.tmpdir(), 'session-restore-sandboxes');
const SECTIONS = 'dframe-code-sections', GROUPS = 'dframe-group-scopes', PINS = 'starred-local-code-sessions';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, o) => { guard(p); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };
function guard(p) {
  const rel = path.relative(ROOT, path.resolve(p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('refused: not a path in a sandbox: ' + p);
}
const entryIds = dir => fs.readdirSync(dir).filter(n => /^local_.*\.json$/.test(n)).map(n => n.replace(/\.json$/, ''));
const view = () => ({ sortBy: 'recency', ascending: false, show: { metadata: false, emptyGroups: false }, collapsed: false });
const renumber = list => list.map((s, i) => (s.order === i ? s : { ...s, order: i }));

// a sandbox's folders and files, by its name
function box(name) {
  const sandbox = path.join(ROOT, name), profile = path.join(sandbox, 'profile');
  const store = path.join(profile, 'AppData', 'Local', 'Packages', 'Claude_sandbox', 'LocalCache', 'Roaming', 'Claude');
  const data = path.join(profile, '.session-restore');
  return {
    name, sandbox, profile, store, data,
    prefs: path.join(store, 'claude_desktop_config.json'),
    leveldb: path.join(store, 'Local Storage', 'leveldb'),
    plan: path.join(data, 'sidebar-plan.json'),
    calls: path.join(data, 'sidebar-calls.json'),
    fingerprints: path.join(sandbox, 'fingerprints-at-build.json'),
    entries: key => path.join(store, 'claude-code-sessions', ...key.split('/')),
  };
}

function wipe(prefsPath, key, dir) {
  const p = read(prefsPath), ep = p.preferences.epitaxyPrefs;
  if (ep[GROUPS]) delete ep[GROUPS][key];
  const entry = (ep[SECTIONS] || {})[key];
  if (entry && Array.isArray(entry.sections)) entry.sections = renumber(entry.sections.filter(s => s.kind !== 'manual'));
  const mine = new Set(entryIds(dir));
  ep[PINS] = (ep[PINS] || []).filter(id => !mine.has(id));
  write(prefsPath, p);
}
function dropScope(prefsPath, key) {
  const p = read(prefsPath), ep = p.preferences.epitaxyPrefs;
  if (ep[GROUPS]) delete ep[GROUPS][key];
  write(prefsPath, p);
}
function emptyGroup(prefsPath, key, name) {
  const p = read(prefsPath), ep = p.preferences.epitaxyPrefs;
  const entry = (ep[SECTIONS] || {})[key];
  if (!entry || !Array.isArray(entry.sections)) throw new Error('the account has no sections to add a group section to');
  const at = entry.sections.findIndex(s => s.kind === 'sessions');
  const id = 'cg-stage-' + crypto.randomUUID();
  entry.sections.splice(at < 0 ? entry.sections.length : at, 0, { id, kind: 'manual', name, order: 0, members: [], ...view() });
  entry.sections = renumber(entry.sections);
  write(prefsPath, p);
  return id;
}
function pick(prefsPath, key, dir, ms, avoidList) {
  const ep = read(prefsPath).preferences.epitaxyPrefs;
  const scope = (ep[GROUPS] || {})[key] || { assignments: {} };
  const starred = new Set(ep[PINS] || []);
  const avoid = new Set();
  if (avoidList) { const l = read(avoidList); for (const g of l.groups) for (const t of g.transcripts) avoid.add(t); for (const t of l.pinned || []) avoid.add(t); }
  for (const id of entryIds(dir).sort()) {
    const e = read(path.join(dir, id + '.json'));
    if (e.isArchived === true || e.scheduledTaskId || !e.cliSessionId || avoid.has(e.cliSessionId)) continue;
    if ((scope.assignments || {})['code:' + id] || starred.has(id)) continue;
    if (typeof e.createdAt !== 'number' || e.createdAt >= Number(ms)) continue;
    return id;
  }
  return null;
}
function newer(file, ms) { const e = read(file); e.createdAt = Number(ms); guard(file); fs.writeFileSync(file, JSON.stringify(e)); }
function fileIn(prefsPath, key, group, id) {
  const p = read(prefsPath), scope = p.preferences.epitaxyPrefs[GROUPS][key];
  const g = scope.groups.find(x => x.name === group); if (!g) throw new Error('no group ' + group);
  scope.assignments['code:' + id] = g.id;
  scope.order = scope.order || {}; scope.order[g.id] = (scope.order[g.id] || []).concat('code:' + id);
  write(prefsPath, p);
}
function pin(prefsPath, id) { const p = read(prefsPath), ep = p.preferences.epitaxyPrefs; ep[PINS] = (ep[PINS] || []).concat(id); write(prefsPath, p); }
function state(prefsPath, key, id) {
  const ep = read(prefsPath).preferences.epitaxyPrefs;
  const scope = (ep[GROUPS] || {})[key] || { groups: [], assignments: {} };
  const g = scope.groups.find(x => x.id === scope.assignments['code:' + id]);
  return (g ? g.name : 'none') + ' ' + ((ep[PINS] || []).includes(id) ? 'pinned' : 'unpinned');
}
function dupe(list, out) { const l = read(list); if (l.groups.length < 2) throw new Error('needs two groups'); l.groups[1].name = l.groups[0].name; write(out, l); }
function noPins(list, out) { const l = read(list); delete l.pinned; write(out, l); }
function same(a, b) { const x = read(a), y = read(b); return JSON.stringify(x.groups) === JSON.stringify(y.groups) && JSON.stringify(x.pinned) === JSON.stringify(y.pinned) && x.accountUuid === y.accountUuid; }
function groupsLeftAlone(planPath) { const p = read(planPath); p.desired.groups = null; p.before.groups = null; delete p.appliedAt; write(planPath, p); }
function forgetAccount(profile, account) {
  let removed = 0;
  for (const dir of [profile, path.join(profile, '.claude', 'backups')]) {
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir).filter(n => n.startsWith('.claude.json'))) {
      const f = path.join(dir, n);
      let j; try { j = read(f); } catch { continue; }
      if (j.oauthAccount && j.oauthAccount.accountUuid === account) { guard(f); fs.unlinkSync(f); removed++; }
    }
  }
  return removed;
}
// the email of an account in a known-accounts file, or null
function emailOf(knownFile, account) {
  if (!knownFile || !fs.existsSync(knownFile)) return null;
  const hit = (read(knownFile).accounts || []).find(a => a.accountUuid === account);
  return hit ? hit.email : null;
}
function config(inPath, outPath, account, form, auto, knownFile) {
  if (path.resolve(inPath) === path.resolve(outPath)) throw new Error('refused: the config is written to a copy, never over the one it is made from');
  const base = read(inPath), result = {};
  if (account !== 'none') {
    const value = form === 'email' ? emailOf(knownFile, account) : account;
    if (!value) throw new Error('no known email for that account');
    result.copyGroupsFromEmail = value;
  }
  result.autoUpdateCopyGroupsFromEmail = parseInt(auto, 10);
  for (const k of Object.keys(base)) if (!(k in result) && k !== 'copyGroupsFromEmail') result[k] = base[k];
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
}

module.exports = { ROOT, box, guard, read, write, wipe, dropScope, emptyGroup, pick, newer, fileIn, pin, state, dupe, noPins, same, groupsLeftAlone, forgetAccount, emailOf, config };

if (require.main === module) {
  const [cmd, ...a] = process.argv.slice(2);
  const run = {
    wipe: () => { wipe(a[0], a[1], a[2]); return 'wiped'; },
    'drop-scope': () => { dropScope(a[0], a[1]); return 'dropped'; },
    'empty-group': () => emptyGroup(a[0], a[1], a[2]),
    pick: () => { const id = pick(a[0], a[1], a[2], a[3], a[4]); if (!id) process.exit(1); return id; },
    newer: () => { newer(a[0], a[1]); return 'createdAt set'; },
    'file-in': () => { fileIn(a[0], a[1], a[2], a[3]); return 'filed'; },
    pin: () => { pin(a[0], a[1]); return 'pinned'; },
    state: () => state(a[0], a[1], a[2]),
    dupe: () => { dupe(a[0], a[1]); return 'written'; },
    'no-pins': () => { noPins(a[0], a[1]); return 'written'; },
    same: () => { const ok = same(a[0], a[1]); if (!ok) { console.log('DIFFERENT'); process.exit(1); } return 'same groups and pins'; },
    'groups-left-alone': () => { groupsLeftAlone(a[0]); return 'the plan leaves the groups alone'; },
    'forget-account': () => `${forgetAccount(a[0], a[1])} account file(s) removed`,
    config: () => { config(a[0], a[1], a[2], a[3], a[4], a[5]); return 'config written'; },
  }[cmd];
  if (!run) { console.error('unknown command ' + cmd + '; see the header of this file'); process.exit(2); }
  console.log(run());
}
