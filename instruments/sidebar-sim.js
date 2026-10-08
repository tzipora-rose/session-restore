// Stands in for the Claude app's sidebar tools in a sandbox, which has no running app: it makes
// the calls session-restore.ps1 -Sidebar listed, in the sandbox's copy of the app's settings
// file, the way the app was seen to make them on 2026-10-08 (desktop app 2.26454.2.0):
//   create_group   a new group goes after the existing ones; an empty group is not in the file
//   move_sessions  the chat goes to the end of its new group; filing a pinned chat in a group
//                  unpins it; group null takes it out of its group and keeps a pin
//   set_pinned     the pin list gains or loses the entry id
//   delete_group   the group goes; chats still in it become ungrouped
// Like the tools, it refuses an archived chat, a routine's run and a chat with no entry. Like the
// session the calls are meant for, it skips create_group when a group of that name exists.
// Usage: node sidebar-sim.js <sandbox profile dir> <receiving key> <calls file> [--skip <n>]
//   --skip <n>   leave call number n unmade (to see the next listing ask for it again)
// It writes only into the sandbox: the settings file, and sim-empty-groups.json beside the
// profile folder for groups that hold no chat yet.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
const si = args.indexOf('--skip');
const skip = si === -1 ? null : parseInt(args.splice(si, 2)[1], 10);
const [profile, key, callsPath] = args;
if (!callsPath) { console.error('usage: node sidebar-sim.js <profile> <receiving key> <calls file> [--skip <n>]'); process.exit(2); }

const pk = path.join(profile, 'AppData', 'Local', 'Packages');
const hits = fs.readdirSync(pk).filter(n => n.startsWith('Claude_') && fs.existsSync(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')));
if (hits.length !== 1) throw new Error('expected exactly one Claude_* store under ' + pk);
if (hits[0] !== 'Claude_sandbox') throw new Error('this is not a sandbox store (' + hits[0] + '); refused');
const store = path.join(pk, hits[0], 'LocalCache', 'Roaming', 'Claude');
const prefsPath = path.join(store, 'claude_desktop_config.json');
const emptyPath = path.join(path.dirname(profile), 'sim-empty-groups.json');
const [account, org] = key.split('/');
const entryOf = id => { try { return JSON.parse(fs.readFileSync(path.join(store, 'claude-code-sessions', account, org, id + '.json'), 'utf8')); } catch { return null; } };

const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
const ep = prefs.preferences.epitaxyPrefs;
if (!ep['dframe-group-scopes']) ep['dframe-group-scopes'] = {};
const scope = ep['dframe-group-scopes'][key] || { groups: [], assignments: {}, order: {} };
let empty = fs.existsSync(emptyPath) ? JSON.parse(fs.readFileSync(emptyPath, 'utf8')) : [];
for (const g of empty) if (!scope.groups.some(x => x.id === g.id)) scope.groups.push(g);
if (!Array.isArray(ep['starred-local-code-sessions'])) ep['starred-local-code-sessions'] = [];
const pins = ep['starred-local-code-sessions'];

const byName = name => { const g = scope.groups.filter(x => x.name === name); if (g.length !== 1) throw new Error(`${g.length} groups are named ${JSON.stringify(name)}`); return g[0]; };
const leave = id => {
  const k = 'code:' + id, old = scope.assignments[k];
  if (old && scope.order[old]) scope.order[old] = scope.order[old].filter(x => x !== k);
  delete scope.assignments[k];
};
const usable = id => { const e = entryOf(id); if (!e) throw new Error(`Session ${id} not found.`); if (e.isArchived === true) throw new Error(`Session ${id} is archived.`); if (e.scheduledTaskId) throw new Error(`Session ${id} is a routine run.`); };

const file = JSON.parse(fs.readFileSync(callsPath, 'utf8'));
let n = 0, made = 0;
for (const call of file.calls) {
  n++;
  if (skip === n) { console.log(`${n}. ${call.tool}: left unmade on purpose`); continue; }
  const a = call.arguments;
  if (call.tool === 'create_group') {
    if (scope.groups.some(x => x.name === a.name)) { console.log(`${n}. create_group ${JSON.stringify(a.name)}: skipped, a group of that name exists`); continue; }
    scope.groups.push({ id: 'cg-sim-' + crypto.randomUUID(), name: a.name });
  } else if (call.tool === 'move_sessions') {
    const gid = a.group === null ? null : byName(a.group).id;
    for (const id of a.session_ids) {
      usable(id);
      leave(id);
      if (gid !== null) {
        scope.assignments['code:' + id] = gid;
        (scope.order[gid] = scope.order[gid] || []).push('code:' + id);
        const p = pins.indexOf(id); if (p !== -1) pins.splice(p, 1);
      }
    }
  } else if (call.tool === 'delete_group') {
    const g = byName(a.group);
    for (const k of Object.keys(scope.assignments)) if (scope.assignments[k] === g.id) delete scope.assignments[k];
    delete scope.order[g.id];
    scope.groups = scope.groups.filter(x => x.id !== g.id);
  } else if (call.tool === 'set_pinned') {
    usable(a.session_id);
    const p = pins.indexOf(a.session_id);
    if (a.pinned && p === -1) pins.push(a.session_id);
    if (!a.pinned && p !== -1) pins.splice(p, 1);
  } else throw new Error('unknown tool ' + call.tool);
  made++;
}
// the app's saved form leaves a group with no chats out of the settings file
const used = new Set(Object.values(scope.assignments));
empty = scope.groups.filter(g => !used.has(g.id));
const saved = { groups: scope.groups.filter(g => used.has(g.id)), assignments: scope.assignments, order: {} };
for (const g of saved.groups) if ((scope.order[g.id] || []).length) saved.order[g.id] = scope.order[g.id];
if (saved.groups.length) ep['dframe-group-scopes'][key] = saved; else delete ep['dframe-group-scopes'][key];
fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
fs.writeFileSync(emptyPath, JSON.stringify(empty));
console.log(`made ${made} of ${file.calls.length} call(s); groups with chats now: ${saved.groups.map(g => `"${g.name}" (${Object.values(saved.assignments).filter(v => v === g.id).length})`).join(', ') || 'none'}; ${empty.length} empty; pin list ${pins.length}`);
