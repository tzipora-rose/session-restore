// Checks, after the calls of session-restore.ps1 -Sidebar were made, that the receiving
// account's groups and pins in the app's settings file are what the plan aims at, that its
// sidebar sections are in step with its groups, and that nothing else in that file moved. Shares
// no code with the script.
// Usage: node verify-sidebar.js <sandbox profile dir> <plan file> <desired|before> <settings file as it was before any call>
// In a sandbox the calls are made by sidebar-sim.js; on the real machine by a Claude session.
// The app keeps one section of kind "manual" per group in epitaxyPrefs["dframe-code-sections"],
// and changes that key itself when the calls create, fill or delete groups (read in its web
// interface, seen 2026-10-08), so the receiving account's entry of it is checked on its own:
// each group that holds a chat has one such section under its id and name; any other was there
// before the calls, unchanged, for a group that held no chat then; and the built-in sections
// pinned, routines and sessions are there, as before apart from their order and groupBy.
const fs = require('fs');
const path = require('path');
const [profile, planPath, aim, referencePath] = process.argv.slice(2);
if (!referencePath || !['desired', 'before'].includes(aim)) { console.error('usage: node verify-sidebar.js <profile> <plan file> <desired|before> <settings file before the calls>'); process.exit(2); }
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x));
// a value as JSON with every object's keys sorted, so two values compare by content alone
const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x);
const without = (o, ...names) => { const c = { ...o }; for (const n of names) delete c[n]; return c; };

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

// the account's sidebar sections, in step with its groups; "saved" groups are those the
// settings file lists, which are the groups holding a chat
const SECTIONS = 'dframe-code-sections';
const secNow = (ep[SECTIONS] || {})[key], secRef = (rep[SECTIONS] || {})[key];
const savedNow = scope.groups;
const savedRef = new Set((((rep['dframe-group-scopes'] || {})[key]) || { groups: [] }).groups.map(g => g.id));
if (secNow === undefined || !Array.isArray(secNow.sections)) {
  check(secNow === undefined && secRef === undefined && savedNow.length === 0, 'the account has no sidebar sections saved' + (secNow !== undefined ? ', and its entry holds no list of them' : '') + (secRef !== undefined ? ', though it had before the calls' : '') + (savedNow.length ? `, though ${savedNow.length} of its groups hold chats` : ''));
} else {
  const S = secNow.sections, refS = secRef && Array.isArray(secRef.sections) ? secRef.sections : [];
  check(new Set(S.map(s => s.id)).size === S.length, 'no section is there twice');
  const wrong = [];
  for (const g of savedNow) {
    const h = S.filter(s => s.kind === 'manual' && s.id === g.id);
    if (h.length !== 1) wrong.push(`"${g.name}" has ${h.length} section(s)`);
    else if (h[0].name !== g.name) wrong.push(`"${g.name}"'s section is named ${JSON.stringify(h[0].name)}`);
  }
  check(wrong.length === 0, `each group that holds a chat has one section under its id and name: ${savedNow.map(g => `"${g.name}"`).join(', ') || 'none'}`);
  if (wrong.length) console.log('       ' + wrong.join('; '));
  const others = S.filter(s => s.kind === 'manual' && !savedNow.some(g => g.id === s.id));
  const odd = others.filter(s => { const r = refS.find(x => x.kind === 'manual' && x.id === s.id); return !r || savedRef.has(s.id) || canon(without(r, 'order')) !== canon(without(s, 'order')); });
  check(odd.length === 0, `any other group section was there before the calls, unchanged, for a group that held no chat then (${others.length})`);
  if (odd.length) console.log('       ' + odd.map(s => `${JSON.stringify(s.name)} (${s.id})`).join(', '));
  const kinds = ['pinned', 'routines', 'sessions'], wrongB = [];
  for (const k of kinds) {
    const h = S.filter(s => s.kind === k);
    if (h.length !== 1 || h[0].id !== k) { wrongB.push(`${h.length} section(s) of kind ${k}${h.length === 1 ? ` with id ${JSON.stringify(h[0].id)}` : ''}`); continue; }
    const r = refS.find(s => s.kind === k);
    if (r && canon(without(r, 'order', 'groupBy')) !== canon(without(h[0], 'order', 'groupBy'))) wrongB.push(`${k} differs from before`);
  }
  const strangers = S.filter(s => !kinds.includes(s.kind) && s.kind !== 'manual');
  if (strangers.length) wrongB.push(`${strangers.length} section(s) of another kind`);
  check(wrongB.length === 0, 'the built-in sections pinned, routines and sessions are there' + (secRef ? ', as before apart from order and groupBy' : ''));
  if (wrongB.length) console.log('       ' + wrongB.join('; '));
  if (secRef) check(canon(without(secNow, 'sections')) === canon(without(secRef, 'sections')), 'the account\'s entry of sections is otherwise as before');
}

// nothing else in the settings file moved
const strip = p => {
  const c = JSON.parse(JSON.stringify(p)), e = c.preferences.epitaxyPrefs;
  for (const k of ['dframe-group-scopes', SECTIONS]) if (e[k]) { delete e[k][key]; if (Object.keys(e[k]).length === 0) delete e[k]; }
  delete e['starred-local-code-sessions'];
  return JSON.stringify(c);
};
check(strip(now) === strip(ref), 'nothing else in the settings file differs from before the calls');
console.log(fails === 0 ? 'SIDEBAR CHECK CLEAN' : `SIDEBAR CHECK FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
