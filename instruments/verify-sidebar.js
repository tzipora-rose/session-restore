// Checks, after the calls of session-restore.ps1 -Sidebar were made, that the receiving
// account's groups and pins in the app's settings file are what the plan aims at, and that
// nothing else in that file moved. Shares no code with the script.
// Usage: node verify-sidebar.js <sandbox profile dir> <plan file> <desired|before> <settings file as it was before any call>
// In a sandbox the calls are made by sidebar-sim.js; on the real machine by a Claude session.
const fs = require('fs');
const path = require('path');
const [profile, planPath, aim, referencePath] = process.argv.slice(2);
if (!referencePath || !['desired', 'before'].includes(aim)) { console.error('usage: node verify-sidebar.js <profile> <plan file> <desired|before> <settings file before the calls>'); process.exit(2); }
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x));

const pk = path.join(profile, 'AppData', 'Local', 'Packages');
const hits = fs.readdirSync(pk).filter(n => n.startsWith('Claude_') && fs.existsSync(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')));
if (hits.length !== 1) throw new Error('expected exactly one Claude_* store under ' + pk);
const store = path.join(pk, hits[0], 'LocalCache', 'Roaming', 'Claude');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const key = plan.receiving.accountUuid + '/' + plan.receiving.organizationUuid;
const dir = path.join(store, 'claude-code-sessions', plan.receiving.accountUuid, plan.receiving.organizationUuid);
const mine = new Map();
for (const f of fs.readdirSync(dir).filter(n => /^local_.*\.json$/.test(n))) {
  let e; try { e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  mine.set(e.sessionId || f.replace(/\.json$/, ''), { changeable: e.isArchived !== true && !e.scheduledTaskId, newer: typeof e.createdAt === 'number' && e.createdAt > plan.madeAtMs });
}
const now = JSON.parse(fs.readFileSync(path.join(store, 'claude_desktop_config.json'), 'utf8'));
const ref = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
const ep = now.preferences.epitaxyPrefs, rep = ref.preferences.epitaxyPrefs;
const scope = (ep['dframe-group-scopes'] || {})[key] || { groups: [], assignments: {} };
const target = plan[aim];
// chats the tools cannot change, and chats made after the plan, are outside what the plan asks
const inPlay = id => mine.has(id) && mine.get(id).changeable && !mine.get(id).newer;

if (target.groups !== null) {
  const want = target.groups.map(g => ({ name: g.name, sessions: g.sessions.filter(inPlay) })).filter(g => g.sessions.length);
  const have = scope.groups.map(g => ({ name: g.name, sessions: Object.keys(scope.assignments).filter(k => scope.assignments[k] === g.id && k.startsWith('code:')).map(k => k.slice(5)).filter(inPlay) })).filter(g => g.sessions.length);
  check(sameSet(have.map(g => g.name), want.map(g => g.name)), `the account's groups with chats are the plan's: ${want.map(g => `"${g.name}" (${g.sessions.length})`).join(', ') || 'none'}`);
  let ok = true;
  for (const g of want) { const h = have.find(x => x.name === g.name); if (!h || !sameSet(h.sessions, g.sessions)) { ok = false; console.log(`       "${g.name}": the plan has ${g.sessions.length}, the settings file ${h ? h.sessions.length : 0}`); } }
  check(ok, 'each group holds exactly the chats the plan files in it');
} else console.log('  --   groups are not planned');
const pins = (ep['starred-local-code-sessions'] || []), refPins = (rep['starred-local-code-sessions'] || []);
if (target.pinned !== null) {
  check(sameSet(pins.filter(inPlay), target.pinned.filter(inPlay)), `the account's pinned chats are the plan's ${target.pinned.filter(inPlay).length}`);
} else console.log('  --   pins are not planned');
check(JSON.stringify(pins.filter(id => !mine.has(id))) === JSON.stringify(refPins.filter(id => !mine.has(id))), 'every other account\'s pins are as they were, in the same order');

// nothing else in the settings file moved
const strip = p => { const c = JSON.parse(JSON.stringify(p)); const e = c.preferences.epitaxyPrefs; if (e['dframe-group-scopes']) delete e['dframe-group-scopes'][key]; if (e['dframe-group-scopes'] && Object.keys(e['dframe-group-scopes']).length === 0) delete e['dframe-group-scopes']; delete e['starred-local-code-sessions']; return JSON.stringify(c); };
check(strip(now) === strip(ref), 'nothing else in the settings file differs from before the calls');
console.log(fails === 0 ? 'SIDEBAR CHECK CLEAN' : `SIDEBAR CHECK FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
