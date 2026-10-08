// Checks the calls session-restore.ps1 -Sidebar lists, case by case, in a sandbox: each case
// writes a plan and a state of the receiving account's groups and pins into the sandbox, runs
// the script with -Sidebar, and compares the calls it lists with the calls written out here by
// hand. The expectations are this file's own; it runs none of the script's code but the script.
// Usage: node check-sidebar-calls.js <tool folder under test> <sandbox profile dir> <receiving key>
// It needs a sandbox whose receiving account has at least 215 chats that are neither archived
// nor a routine's run, and one archived chat. It puts the sandbox's settings file and plan back
// as they were when it ends.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const [tool, profile, key] = process.argv.slice(2);
if (!key) { console.error('usage: node check-sidebar-calls.js <tool folder> <sandbox profile dir> <receiving key>'); process.exit(2); }
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };

const pk = path.join(profile, 'AppData', 'Local', 'Packages');
const hits = fs.readdirSync(pk).filter(n => n.startsWith('Claude_') && fs.existsSync(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')));
if (hits.length !== 1 || hits[0] !== 'Claude_sandbox') throw new Error('this is not a sandbox profile; refused');
const store = path.join(pk, hits[0], 'LocalCache', 'Roaming', 'Claude');
const prefsPath = path.join(store, 'claude_desktop_config.json');
const data = path.join(profile, '.session-restore');
const planPath = path.join(data, 'sidebar-plan.json'), callsPath = path.join(data, 'sidebar-calls.json');
const [account, org] = key.split('/');
const dir = path.join(store, 'claude-code-sessions', account, org);
const all = fs.readdirSync(dir).filter(n => /^local_.*\.json$/.test(n)).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .filter(e => typeof e.createdAt === 'number').sort((a, b) => a.createdAt - b.createdAt);
const usable = all.filter(e => e.isArchived !== true && !e.scheduledTaskId);
const archived = all.find(e => e.isArchived === true);
if (usable.length < 215 || !archived) throw new Error(`the sandbox has ${usable.length} usable chats and ${archived ? 1 : 0} archived; it needs 215 and 1`);
const old = usable.slice(0, 212).map(e => e.sessionId);   // the oldest chats
const newest = usable[usable.length - 1];                    // made after every plan below
const madeAtMs = newest.createdAt - 1000;
const A = archived.sessionId, N = newest.sessionId;
const [a, b, c, d, e, f, g] = old;

const prefsBefore = fs.readFileSync(prefsPath);
const planBefore = fs.existsSync(planPath) ? fs.readFileSync(planPath) : null;
const basePrefs = JSON.parse(prefsBefore.toString('utf8'));
const otherPins = (basePrefs.preferences.epitaxyPrefs['starred-local-code-sessions'] || []).filter(id => !all.some(x => x.sessionId === id));

// the receiving account's sidebar "now": groups as [name, [ids]], and its pinned ids
function setNow(groups, pinned) {
  const prefs = JSON.parse(JSON.stringify(basePrefs));
  const ep = prefs.preferences.epitaxyPrefs;
  const scope = { groups: [], assignments: {}, order: {} };
  groups.forEach(([name, ids], i) => {
    const id = 'cg-case-' + i;
    scope.groups.push({ id, name });
    scope.order[id] = ids.map(x => 'code:' + x);
    for (const x of ids) scope.assignments['code:' + x] = id;
  });
  ep['dframe-group-scopes'] = ep['dframe-group-scopes'] || {};
  if (groups.length) ep['dframe-group-scopes'][key] = scope; else delete ep['dframe-group-scopes'][key];
  ep['starred-local-code-sessions'] = [...otherPins, ...pinned];
  fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}
function setPlan(desired, extra = {}) {
  const plan = { v: 1, run: '20260101-000000', madeAtMs, madeAt: new Date(madeAtMs).toISOString(), receiving: { accountUuid: account, organizationUuid: org },
    source: { accountUuid: '00000000-0000-0000-0000-000000000000', organizationUuid: 'x', groupsReadFrom: 'a test' }, aim: 'desired', desired,
    before: { groups: [], pinned: [] }, ...extra };
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
}
function run(extraArgs = []) {
  if (fs.existsSync(callsPath)) fs.unlinkSync(callsPath);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tool, 'session-restore.ps1'), '-Sidebar', ...extraArgs, '-UserProfile', profile], { encoding: 'utf8' });
  const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, 'utf8')).calls : null;
  return { out: r.stdout + r.stderr, calls };
}
const G = (name, sessions) => ({ name, sessions });
const create = name => ({ tool: 'create_group', arguments: { name } });
const move = (group, session_ids) => ({ tool: 'move_sessions', arguments: { group, session_ids } });
const del = group => ({ tool: 'delete_group', arguments: { group } });
const pin = (session_id, pinned) => ({ tool: 'set_pinned', arguments: { session_id, pinned } });
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);
function expectCalls(title, want, r) {
  const ok = same(r.calls, want);
  check(ok, title);
  if (!ok) { console.log('       wanted ' + JSON.stringify(want).slice(0, 600)); console.log('       listed ' + JSON.stringify(r.calls).slice(0, 600)); console.log(r.out.split('\n').slice(0, 12).map(l => '       | ' + l.slice(0, 160)).join('\n')); }
}

try {
  // 1. nothing there yet: each group is created, then filled, in the plan's order; then the pins
  setNow([], []);
  setPlan({ groups: [G('one', [a, b]), G('two', [c])], pinned: [d] });
  expectCalls('1. an empty sidebar: create and fill each group in order, then pin', [create('one'), move('one', [a, b]), create('two'), move('two', [c]), pin(d, true)], run());

  // 2. a group that exists is not created again; only the chats not yet in it are moved
  setNow([['one', [a]], ['two', [b]]], [d]);
  setPlan({ groups: [G('one', [a, b]), G('two', [c])], pinned: [d] });
  expectCalls('2. existing groups: only the chats out of place are moved, none created, no pin call', [move('one', [b]), move('two', [c])], run());

  // 3. an archived chat is neither filed nor pinned, though the plan names it
  setNow([], []);
  setPlan({ groups: [G('one', [A, a])], pinned: [A, b] });
  expectCalls('3. an archived chat in the plan gets no call', [create('one'), move('one', [a]), pin(b, true)], run());

  // 4. a group the plan lacks: its chats leave it, then it is deleted; a chat the plan does not pin is unpinned
  setNow([['one', [a]], ['old', [e, f]]], [g]);
  setPlan({ groups: [G('one', [a])], pinned: [] });
  expectCalls('4. a group the plan lacks is emptied and deleted, and a pin it lacks is removed', [move(null, [e, f]), del('old'), pin(g, false)], run());

  // 5. a chat made after the plan is left where it is, pinned or filed, and keeps its group alive
  setNow([['one', [a]], ['later', [N, e]]], [N]);
  setPlan({ groups: [G('one', [a])], pinned: [] });
  let r = run();
  expectCalls('5. a chat made after the plan stays filed and pinned; its group is kept, only the older chat leaves', [move(null, [e])], r);
  check(/created after the plan was made/.test(r.out) && /"later" is not in the plan/.test(r.out), '   and the listing says so');

  // 6. filing a pinned chat unpins it, so a chat the plan both files and pins is pinned after its move;
  //    a pinned chat the plan files without pinning needs no unpin call
  setNow([], [a, b]);
  setPlan({ groups: [G('one', [a, b])], pinned: [a] });
  expectCalls('6. pinned chats that are filed: pinned again after the move when the plan pins them, else no call', [create('one'), move('one', [a, b]), pin(a, true)], run());

  // 7. more than 100 chats for one group go in calls of at most 100
  setNow([], []);
  setPlan({ groups: [G('big', old.slice(0, 205))], pinned: [] });
  expectCalls('7. 205 chats are moved in calls of 100, 100 and 5', [create('big'), move('big', old.slice(0, 100)), move('big', old.slice(100, 200)), move('big', old.slice(200, 205))], run());

  // 8. a part of the plan that is null is left alone
  setNow([['mine', [a]]], [b]);
  setPlan({ groups: null, pinned: [c] });
  expectCalls('8. groups not planned: no group call, the pins still follow the plan', [pin(c, true), pin(b, false)], run());
  setPlan({ groups: [G('one', [c])], pinned: null });
  expectCalls('   pins not planned: no pin call, the groups still follow the plan', [create('one'), move('one', [c]), move(null, [a]), del('mine')], run());

  // 9. two groups of one name cannot be told apart by name: nothing is listed
  setNow([['twin', [a]], ['twin', [b]]], []);
  setPlan({ groups: [G('one', [a])], pinned: [] });
  r = run();
  check(r.calls === null && /two of this account's groups are named "twin"/.test(r.out), '9. two groups of one name: nothing listed, and the reason given');

  // 10. matching: nothing listed, the plan marked applied; -Back aims at the state before
  setNow([['one', [a]]], [b]);
  setPlan({ groups: [G('one', [a])], pinned: [b] }, { before: { groups: [G('was', [c])], pinned: [] } });
  r = run();
  check(same(r.calls, []) && /The sidebar matches the plan/.test(r.out) && typeof JSON.parse(fs.readFileSync(planPath, 'utf8')).appliedAt === 'string', '10. a sidebar that matches: no call, and the plan is marked applied');
  expectCalls('    -Back lists the calls to the state before the run', [create('was'), move('was', [c]), move(null, [a]), del('one'), pin(b, false)], run(['-Back']));
  setNow([['one', [a]]], []);
  r = run();
  expectCalls('    a change after the plan was applied is still listed', [pin(b, true)], r);
  check(/This plan was applied in full on/.test(r.out), '    with the notice that the plan had been applied');

  // 11. a plan made for another account, and no plan
  setPlan({ groups: [G('one', [a])], pinned: [] }, { receiving: { accountUuid: '11111111-1111-1111-1111-111111111111', organizationUuid: org } });
  r = run();
  check(r.calls === null && /was made for another account/.test(r.out), '11. a plan for another account: nothing listed');
  fs.unlinkSync(planPath);
  r = run();
  check(r.calls === null && /No sidebar plan is saved/.test(r.out), '    no plan: nothing listed');
} finally {
  fs.writeFileSync(prefsPath, prefsBefore);
  if (planBefore) fs.writeFileSync(planPath, planBefore); else if (fs.existsSync(planPath)) fs.unlinkSync(planPath);
  if (fs.existsSync(callsPath)) fs.unlinkSync(callsPath);
}
console.log(fails === 0 ? 'SIDEBAR CALLS CHECK CLEAN' : `SIDEBAR CALLS CHECK FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
