// Shows that each checker fails on a fault, and on that fault alone, and that the script's own
// faults are caught: each case damages one thing (a copy of a plan, list or export; the sandbox's
// settings file or one chat entry, put back afterwards; a throwaway copy of the script) and names
// the checks that must then fail, or that the result must stay clean. A case this data cannot
// stage is reported as not tested, never as passed.
// Usage: node make-faults.js <mode> ...
//   plan        <profile> <plan> <source key> <receiving key>
//               faults in a plan a run saved, against verify-plan.js
//   sidebar     <profile> <plan> <settings file before the calls>
//               faults in the settings file in the state the plan aims at, against
//               verify-sidebar.js desired
//   sidebar-back <profile> <plan> <settings file before the calls> <settings file in the desired state>
//               a deleted group's section left behind, after -Sidebar -Back's calls
//   left-alone  <profile> <plan> <settings file before the calls>
//               faults when the plan leaves the groups alone, after its calls
//   import      <profile> <import plan> <key> <export file>
//               faults in a plan -Import saved from an export of the same account, against
//               verify-plan.js
//   list        <profile> <key> <list file>
//               faults in a saved list or an export, against verify-list.js, while the settings
//               file still holds the groups and pins the list was made from
//   script      <tool folder> <profile> <receiving key> <work folder>
//               faults in throwaway copies of session-restore.ps1 that check-sidebar-calls.js must
//               catch
//   desktop-lib <tool folder> <work folder>
//               faults in throwaway copies of lib\DesktopApp.ps1 that check-desktop-app.js must
//               catch
// The checkers are read from this file's folder. Exit 0: every case as it must be; 1: a case
// wrong; 3: no case wrong but some not tested.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const here = __dirname;
const S = 'dframe-code-sections', G = 'dframe-group-scopes', P = 'starred-local-code-sessions';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));

function makeReport() {
  const r = { wrong: 0, untested: 0, lines: [] };
  r.say = l => { r.lines.push(l); console.log(l); };
  r.ok = (good, title, detail) => { r.say((good ? '  ok   ' : '  WRONG ') + title + (detail ? ` (${detail})` : '')); if (!good) r.wrong++; };
  r.skip = (title, why) => { r.say(`  --   ${title}: not tested, ${why}`); r.untested++; };
  return r;
}
// runs a checker and returns its exit code and the text of its FAIL lines
function runChecker(args) {
  const x = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const out = (x.stdout || '') + (x.stderr || '');
  return { status: x.status, fails: out.split(/\r?\n/).filter(l => l.startsWith('  FAIL ')).map(l => l.slice(7)), last: out.trim().split(/\r?\n/).pop(), out };
}
// a fault must fail exactly the wanted checks (each wanted text found in a failing line of its
// own), and a "clean" case must fail none
function expectChecks(r, title, args, wanted) {
  const x = runChecker(args);
  const used = new Set();
  const matched = wanted.every(w => { const i = x.fails.findIndex((f, k) => !used.has(k) && f.includes(w)); if (i < 0) return false; used.add(i); return true; });
  const good = wanted.length === 0 ? x.status === 0 && x.fails.length === 0 : x.status === 1 && x.fails.length === wanted.length && matched;
  r.ok(good, title, good ? x.last : `wanted ${wanted.length ? JSON.stringify(wanted) : 'clean'}, got exit ${x.status} and ${JSON.stringify(x.fails)}`);
  return good;
}
// a fault proves something only beside an undamaged input that passes
function controlPasses(r, title, args) {
  if (expectChecks(r, title, args, [])) return true;
  r.skip('the faults that follow', 'their undamaged input does not pass');
  return false;
}
const keyOf = plan => plan.receiving.accountUuid + '/' + plan.receiving.organizationUuid;
const prefsOf = profile => path.join(profile, 'AppData', 'Local', 'Packages', 'Claude_sandbox', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
const entriesOf = (profile, key) => path.join(profile, 'AppData', 'Local', 'Packages', 'Claude_sandbox', 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions', ...key.split('/'));
const view = () => ({ sortBy: 'recency', ascending: false, show: { metadata: false, emptyGroups: false }, collapsed: false });
const renumber = list => list.map((s, i) => ({ ...s, order: i }));
// the chats of an account that the tools could change and the plan covers
function usableIds(profile, plan) {
  const dir = entriesOf(profile, keyOf(plan));
  return fs.readdirSync(dir).filter(n => /^local_.*\.json$/.test(n)).map(n => read(path.join(dir, n)))
    .filter(e => e.isArchived !== true && !e.scheduledTaskId && typeof e.createdAt === 'number' && e.createdAt <= plan.madeAtMs).map(e => e.sessionId);
}
// cases that change the settings file: each is put back as it was before the next
function settingsCases(r, prefsPath, cases, args) {
  const original = fs.readFileSync(prefsPath);
  try {
    for (const c of cases) {
      const p = JSON.parse(original.toString('utf8'));
      let why = null;
      try { why = c.damage(p); } catch (x) { why = 'staging failed: ' + x.message; }
      if (typeof why === 'string') { r.skip(c.title, why); continue; }
      fs.writeFileSync(prefsPath, JSON.stringify(p, null, 2));
      expectChecks(r, c.title, args, c.wanted);
      fs.writeFileSync(prefsPath, original);
    }
  } finally { fs.writeFileSync(prefsPath, original); }
}

const modes = {};

modes.plan = (r, [profile, planPath, sourceKey, receivingKey]) => {
  const base = read(planPath);
  const tmp = planPath + '.damaged.json';
  const args = file => [path.join(here, 'verify-plan.js'), profile, file, sourceKey, receivingKey];
  if (!controlPasses(r, 'control: the plan as the run saved it passes', args(planPath))) return;
  const g = base.desired.groups || [];
  const cases = [
    ['a chat dropped from the first group', () => g.length < 1 || g[0].sessions.length < 1 ? 'no group with a chat' : p => p.desired.groups[0].sessions.shift(), ['each group holds exactly']],
    ['a chat of the account that the source has not pinned added to the pins', () => g.length < 1 || g[0].sessions.length < 1 || !Array.isArray(base.desired.pinned) ? 'no chat to add' : p => p.desired.pinned.push(p.desired.groups[0].sessions[0]), ["the pins are this account's entries", "listed in the pin list's order"]],
    ['the second group renamed', () => g.length < 2 ? 'fewer than two groups' : p => { p.desired.groups[1].name += ' x'; }, ["the groups are the source's, in its order", 'each group holds exactly']],
    ['a pin dropped from the pins as they were', () => !Array.isArray(base.before.pinned) || base.before.pinned.length < 1 ? 'the account pinned nothing before' : p => p.before.pinned.pop(), ['the pins as they were']],
    ['another receiving account', () => p => { p.receiving.accountUuid = '11111111-1111-1111-1111-111111111111'; }, ['names the receiving account and org']],
    ['two chats of the first group swapped', () => g.length < 1 || g[0].sessions.length < 2 ? 'no group with two chats' : p => { const s = p.desired.groups[0].sessions; [s[0], s[1]] = [s[1], s[0]]; }, ["lists them in the source's order"]],
    ['a chat of the first group also filed in the second', () => g.length < 2 || g[0].sessions.length < 1 ? 'fewer than two groups' : p => p.desired.groups[1].sessions.push(p.desired.groups[0].sessions[0]), ['each group holds exactly', 'no chat is filed in two groups']],
    ['an aim other than the source\'s state', () => p => { p.aim = 'before'; }, ['the plan aims at']],
  ];
  try {
    for (const [title, stage, wanted] of cases) {
      const damage = stage();
      if (typeof damage === 'string') { r.skip(title, damage); continue; }
      const p = JSON.parse(JSON.stringify(base)); damage(p);
      fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
      expectChecks(r, title, args(tmp), wanted);
    }
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
};

modes.sidebar = (r, [profile, planPath, refPath]) => {
  const plan = read(planPath), key = keyOf(plan), prefsPath = prefsOf(profile);
  const args = [path.join(here, 'verify-sidebar.js'), profile, planPath, 'desired', refPath];
  if (!controlPasses(r, 'control: the settings file after the calls passes', args)) return;
  const mine = new Set(fs.readdirSync(entriesOf(profile, key)).map(f => f.replace(/\.json$/, '')));
  const inPlay = new Set(usableIds(profile, plan));
  const desired = (plan.desired.groups || []).map(g => ({ name: g.name, sessions: g.sessions.filter(id => inPlay.has(id)) })).filter(g => g.sessions.length);
  const spare = [...inPlay].find(id => !desired.some(g => g.sessions.includes(id)) && !(plan.desired.pinned || []).includes(id));
  const sectionsOf = p => (p.preferences.epitaxyPrefs[S] || {})[key];
  const manual = p => sectionsOf(p).sections.filter(s => s.kind === 'manual');
  const each = 'each group that holds a chat has one section', other = 'any other group section was there before the calls';
  const builtin = 'the built-in sections pinned, routines and sessions are there';
  const cases = [
    { title: 'a filed chat taken out of its group', damage: p => {
      const g = desired.find(x => x.sessions.length >= 2); if (!g) return 'no group holds two chats the plan covers';
      const s = p.preferences.epitaxyPrefs[G][key]; delete s.assignments['code:' + g.sessions[0]];
    }, wanted: ['each group holds exactly the chats'] },
    { title: 'another account\'s pin removed', damage: p => {
      const l = p.preferences.epitaxyPrefs[P] || []; const i = l.findIndex(id => !mine.has(id)); if (i < 0) return 'no other account has a pin';
      l.splice(i, 1);
    }, wanted: ["every other account's pins"] },
    { title: 'a setting the calls do not touch changed', damage: p => { p.preferences['session-restore-control'] = true; }, wanted: ['nothing else in the settings file differs'] },
    { title: 'a pin the plan asks for missing', damage: p => {
      const l = p.preferences.epitaxyPrefs[P] || []; const id = (plan.desired.pinned || []).find(x => inPlay.has(x) && l.includes(x)); if (!id) return 'the plan pins no chat';
      l.splice(l.indexOf(id), 1);
    }, wanted: ["the account's pinned chats are the plan's"] },
    { title: 'a group the plan lacks, with its section', damage: p => {
      if (!spare) return 'no chat outside the plan'; if (plan.desired.groups === null) return 'the plan leaves the groups alone';
      const s = p.preferences.epitaxyPrefs[G][key]; s.groups.push({ id: 'cg-control-extra', name: 'extra' }); s.assignments['code:' + spare] = 'cg-control-extra';
      const e = sectionsOf(p); if (e) { const at = e.sections.findIndex(x => x.kind === 'sessions'); e.sections.splice(at, 0, { id: 'cg-control-extra', kind: 'manual', name: 'extra', order: 0, members: [], ...view() }); e.sections = renumber(e.sections); }
    }, wanted: ["the account's groups with chats are the plan's"] },
    { title: 'a group\'s section missing', damage: p => { const m = manual(p); if (!m.length) return 'no group section'; const e = sectionsOf(p); e.sections = renumber(e.sections.filter(x => x !== m[m.length - 1])); }, wanted: [each] },
    { title: 'a group\'s section under another name', damage: p => { const m = manual(p); if (!m.length) return 'no group section'; m[0].name += ' (old name)'; }, wanted: [each] },
    { title: 'a group\'s section there twice', damage: p => { const m = manual(p); if (!m.length) return 'no group section'; const e = sectionsOf(p); const at = e.sections.findIndex(x => x.kind === 'sessions'); e.sections.splice(at, 0, { ...m[0] }); e.sections = renumber(e.sections); }, wanted: ['no section is there twice', each] },
    { title: 'a section for a group the account does not have', damage: p => { const e = sectionsOf(p); if (!e) return 'no sections'; const at = e.sections.findIndex(x => x.kind === 'sessions'); e.sections.splice(at, 0, { id: 'cg-control-stranger', kind: 'manual', name: 'stranger', order: 0, members: [], ...view() }); e.sections = renumber(e.sections); }, wanted: [other] },
    { title: 'Pinned sorted another way', damage: p => { const e = sectionsOf(p); if (!e) return 'no sections'; e.sections.find(x => x.kind === 'pinned').sortBy = 'alpha'; }, wanted: [builtin] },
    { title: 'Ungrouped changed apart from its groupBy', damage: p => { const e = sectionsOf(p); if (!e) return 'no sections'; const s = e.sections.find(x => x.kind === 'sessions'); s.ascending = !s.ascending; }, wanted: [builtin] },
    { title: 'the entry of sections changed apart from its sections', damage: p => { const e = sectionsOf(p); if (!e) return 'no sections'; e.migratedFrom = (e.migratedFrom || 0) + 1; }, wanted: ["the account's entry of sections is otherwise as before"] },
    { title: 'the account\'s entry of sections gone', damage: p => { if (!sectionsOf(p)) return 'no sections'; delete p.preferences.epitaxyPrefs[S][key]; }, wanted: ['the account has no sidebar sections saved'] },
    { title: 'another account\'s sections changed', damage: p => { const k = Object.keys(p.preferences.epitaxyPrefs[S] || {}).find(x => x !== key); if (!k) return 'no other account has sections'; const s = p.preferences.epitaxyPrefs[S][k].sections.find(x => x.kind === 'routines'); s.collapsed = !s.collapsed; }, wanted: ['nothing else in the settings file differs'] },
    { title: 'Ungrouped grouped another way, which the app may do itself: still clean', damage: p => { const e = sectionsOf(p); if (!e) return 'no sections'; e.sections.find(x => x.kind === 'sessions').groupBy = 'date'; }, wanted: [] },
    { title: 'a group\'s section collapsed, which the app changes on a move: still clean', damage: p => { const m = manual(p); if (!m.length) return 'no group section'; m[0].collapsed = !m[0].collapsed; }, wanted: [] },
    { title: 'the group sections in another order, which is the app\'s: still clean', damage: p => { const m = manual(p); if (m.length < 2) return 'fewer than two group sections'; const e = sectionsOf(p); const i = e.sections.indexOf(m[0]), j = e.sections.indexOf(m[1]); [e.sections[i], e.sections[j]] = [e.sections[j], e.sections[i]]; e.sections = renumber(e.sections); }, wanted: [] },
  ];
  settingsCases(r, prefsPath, cases, args);
};

modes['sidebar-back'] = (r, [profile, planPath, refPath, desiredPath]) => {
  const plan = read(planPath), key = keyOf(plan), prefsPath = prefsOf(profile);
  const args = [path.join(here, 'verify-sidebar.js'), profile, planPath, 'before', refPath];
  if (!controlPasses(r, 'control: the settings file after the calls back passes', args)) return;
  const left = ((read(desiredPath).preferences.epitaxyPrefs[S] || {})[key] || { sections: [] }).sections.find(s => s.kind === 'manual');
  settingsCases(r, prefsPath, [{ title: 'a deleted group\'s section left behind', damage: p => {
    if (!left) return 'the desired state has no group section';
    const before = new Set(((read(refPath).preferences.epitaxyPrefs[S] || {})[key] || { sections: [] }).sections.map(s => s.id));
    if (before.has(left.id)) return 'that group\'s section was there before the calls';
    const e = (p.preferences.epitaxyPrefs[S] || {})[key]; if (!e) return 'no sections';
    if (e.sections.some(s => s.id === left.id)) return 'the calls back kept that group';
    const at = e.sections.findIndex(x => x.kind === 'sessions'); e.sections.splice(at, 0, left); e.sections = renumber(e.sections);
  }, wanted: ['any other group section was there before the calls'] }], args);
};

modes['left-alone'] = (r, [profile, planPath, refPath]) => {
  const plan = read(planPath), key = keyOf(plan), prefsPath = prefsOf(profile);
  if (plan.desired.groups !== null) { r.ok(false, 'the plan leaves the groups alone', 'it plans groups'); return; }
  const args = [path.join(here, 'verify-sidebar.js'), profile, planPath, 'desired', refPath];
  if (!controlPasses(r, 'control: the settings file after the calls passes', args)) return;
  const inPlay = new Set(usableIds(profile, plan));
  const ref = read(refPath);
  const refScope = (ref.preferences.epitaxyPrefs[G] || {})[key] || { groups: [], assignments: {} };
  const filed = Object.keys(refScope.assignments || {}).filter(k => k.startsWith('code:') && inPlay.has(k.slice(5)));
  const loose = [...inPlay].find(id => !(refScope.assignments || {})['code:' + id]);
  const refSections = ((ref.preferences.epitaxyPrefs[S] || {})[key] || { sections: [] }).sections;
  const lonely = refSections.find(s => s.kind === 'manual' && !(refScope.groups || []).some(g => g.id === s.id));
  const lines = 'groups are not planned, and the groups holding the plan\'s chats are as they were';
  const sectionsLine = 'groups are not planned, and every group section there before the calls is still there';
  settingsCases(r, prefsPath, [
    { title: 'a chat the plan covers taken out of its group', damage: p => { if (!filed.length) return 'no chat the plan covers is in a group'; delete p.preferences.epitaxyPrefs[G][key].assignments[filed[0]]; }, wanted: [lines] },
    { title: 'a chat the plan covers filed in a group', damage: p => {
      const s = (p.preferences.epitaxyPrefs[G] || {})[key]; if (!s || !s.groups.length || !loose) return 'no group, or no chat outside the groups';
      s.assignments['code:' + loose] = s.groups[0].id; s.order = s.order || {}; s.order[s.groups[0].id] = (s.order[s.groups[0].id] || []).concat('code:' + loose);
    }, wanted: [lines] },
    { title: 'an empty group that was there before deleted', damage: p => {
      if (!lonely) return 'the account had no empty group before the calls';
      const e = p.preferences.epitaxyPrefs[S][key]; e.sections = renumber(e.sections.filter(s => s.id !== lonely.id));
    }, wanted: [sectionsLine] },
  ], args);
  // a chat created after the plan, filed in a group: the plan does not cover it
  const s = (read(prefsPath).preferences.epitaxyPrefs[G] || {})[key];
  if (!s || !s.groups.length || !loose) { r.skip('a chat created after the plan filed in a group: still clean', 'no group, or no chat outside the groups'); return; }
  const entryFile = path.join(entriesOf(profile, key), loose + '.json');
  const entryBytes = fs.readFileSync(entryFile), prefsBytes = fs.readFileSync(prefsPath);
  try {
    const e = JSON.parse(entryBytes.toString('utf8')); e.createdAt = plan.madeAtMs + 5000; fs.writeFileSync(entryFile, JSON.stringify(e));
    const p = JSON.parse(prefsBytes.toString('utf8')); const sc = p.preferences.epitaxyPrefs[G][key];
    sc.assignments['code:' + loose] = sc.groups[0].id; sc.order = sc.order || {}; sc.order[sc.groups[0].id] = (sc.order[sc.groups[0].id] || []).concat('code:' + loose);
    fs.writeFileSync(prefsPath, JSON.stringify(p, null, 2));
    expectChecks(r, 'a chat created after the plan filed in a group: still clean', args, []);
  } finally { fs.writeFileSync(entryFile, entryBytes); fs.writeFileSync(prefsPath, prefsBytes); }
};

modes.import = (r, [profile, planPath, key, exportFile]) => {
  const args = (plan, file) => [path.join(here, 'verify-plan.js'), profile, plan, key, key, '--source-from', 'file:' + file];
  if (!controlPasses(r, 'control: the import plan as made passes', args(planPath, exportFile))) return;
  const base = read(planPath);
  const bad = planPath + '.damaged.json';
  const cases = [
    ['a pin taken out of the pins to reach', p => { if (!Array.isArray(p.desired.pinned) || !p.desired.pinned.length) return 'the file pins nothing'; p.desired.pinned.pop(); }],
    ['the time the file was saved moved by a millisecond', p => { p.source.stateAtMs += 1; }],
    ['the pins to reach left out', p => { if (!Array.isArray(p.desired.pinned)) return 'the plan pins nothing'; p.desired.pinned = null; }],
    ['another file named as the source', p => { p.source.importedFrom += '.x'; }],
    ['a chat taken out of a group to reach', p => { if (!(p.desired.groups || []).length || !p.desired.groups[0].sessions.length) return 'no group to reach holds a chat'; p.desired.groups[0].sessions.pop(); }],
  ];
  try {
    for (const [title, damage] of cases) {
      const p = JSON.parse(JSON.stringify(base)); const why = damage(p);
      if (typeof why === 'string') { r.skip(title, why); continue; }
      fs.writeFileSync(bad, JSON.stringify(p, null, 2));
      const x = runChecker(args(bad, exportFile));
      r.ok(x.status === 1 && x.fails.length > 0, `${title}: must fail`, `exit ${x.status}, ${x.fails.length} check(s) failed`);
    }
    const noPins = exportFile + '.no-pins.json';
    const l = read(exportFile); delete l.pinned; fs.writeFileSync(noPins, JSON.stringify(l, null, 2));
    const x = runChecker(args(planPath, noPins)); fs.unlinkSync(noPins);
    if (Array.isArray(base.desired.pinned)) r.ok(x.status === 1 && x.fails.some(f => f.includes('the file keeps no pins')), 'the plan pins chats although the file keeps no pins: must fail', `exit ${x.status}`);
    else r.skip('the plan pins chats although the file keeps no pins', 'the plan pins nothing');
  } finally { if (fs.existsSync(bad)) fs.unlinkSync(bad); }
};

modes.list = (r, [profile, key, listFile]) => {
  const args = [path.join(here, 'verify-list.js'), profile, key, '--file', listFile];
  if (!controlPasses(r, 'control: the list as written passes', args)) return;
  const original = fs.readFileSync(listFile);
  const cases = [
    ['a transcript taken out of a group', l => { const g = l.groups.find(x => x.transcripts.length); if (!g) return 'no group holds a chat'; g.transcripts.pop(); }],
    ['the groups in another order', l => { if (l.groups.length < 2) return 'fewer than two groups'; l.groups.reverse(); }],
    ['a pin taken out', l => { if (!Array.isArray(l.pinned) || !l.pinned.length) return 'no pinned chat'; l.pinned.pop(); }],
  ];
  try {
    for (const [title, damage] of cases) {
      const l = JSON.parse(original.toString('utf8')); const why = damage(l);
      if (typeof why === 'string') { r.skip(title, why); continue; }
      fs.writeFileSync(listFile, JSON.stringify(l, null, 2));
      const x = runChecker(args);
      r.ok(x.status === 1 && x.fails.length > 0, `${title}: must fail`, `exit ${x.status}, ${x.fails.length} check(s) failed`);
    }
  } finally { fs.writeFileSync(listFile, original); }
};

modes.script = (r, [tool, profile, receivingKey, work]) => {
  const cases = [
    ['chats moved 50 at a time', '$i += 100) {\n        $chunk = $need.GetRange($i, [Math]::Min(100, $need.Count - $i)).ToArray()', '$i += 50) {\n        $chunk = $need.GetRange($i, [Math]::Min(50, $need.Count - $i)).ToArray()', '7. 205 chats'],
    ['a filed chat not pinned again', 'if (-not $Now.Pinned.Contains($id) -or $movedIn.Contains($id)) {', 'if (-not $Now.Pinned.Contains($id)) {', '6. pinned chats that are filed'],
    ['chats made after the plan not spared', 'if (& $isNewer $id) { $newer++; $staying[$g.Name] = $staying[$g.Name] + 1; continue }', '', '5. a chat made after the plan'],
    ['archived chats not spared', 'return (-not $e.Archived -and -not $e.Routine)', 'return $true', '3. an archived chat'],
  ];
  for (const [title, from, to, wants] of cases) {
    const copy = path.join(work, 'tool-fault');
    fs.rmSync(copy, { recursive: true, force: true });
    fs.mkdirSync(path.join(copy, 'lib'), { recursive: true });
    for (const n of ['session-restore.ps1', 'session-restore.config.json']) fs.copyFileSync(path.join(tool, n), path.join(copy, n));
    for (const n of fs.readdirSync(path.join(tool, 'lib'))) fs.copyFileSync(path.join(tool, 'lib', n), path.join(copy, 'lib', n));
    const file = path.join(copy, 'session-restore.ps1');
    const text = fs.readFileSync(file, 'utf8');
    const count = text.split(from).length - 1;
    if (count !== 1) { r.ok(false, title, `the text to change occurs ${count} time(s) in the script; this case must be brought up to date with it`); continue; }
    fs.writeFileSync(file, text.replace(from, () => to));
    const x = spawnSync(process.execPath, [path.join(here, 'check-sidebar-calls.js'), copy, profile, receivingKey], { encoding: 'utf8' });
    const failed = (x.stdout || '').split(/\r?\n/).filter(l => /^\s+FAIL /.test(l));
    r.ok(x.status === 1 && failed.some(l => l.includes(wants)), `${title}: check-sidebar-calls.js must catch it`, `${failed.length} case(s) failed`);
    fs.rmSync(copy, { recursive: true, force: true });
  }
};

modes['desktop-lib'] = (r, [tool, work]) => {
  const checkerArgs = dir => [path.join(here, 'check-desktop-app.js'), dir];
  const control = runChecker(checkerArgs(tool));
  if (control.status !== 0 && control.status !== 3) { r.ok(false, 'control: check-desktop-app.js passes on the undamaged library', `exit ${control.status}, ${JSON.stringify(control.fails)}`); return; }
  r.ok(true, 'control: check-desktop-app.js passes on the undamaged library', control.last);
  const untested = control.out.split(/\r?\n/).filter(l => l.startsWith('  --   ')).join('\n');
  const cases = [
    ["an unpackaged install's folder preferred to the packaged app's",
      "  $roaming = Join-Path $UserProfile 'AppData\\Roaming\\Claude'\n",
      "  $roaming = Join-Path $UserProfile 'AppData\\Roaming\\Claude'\n  if (Test-Path -LiteralPath (Join-Path $roaming 'claude-code-sessions') -PathType Container) { $result.Root = $roaming; return $result }\n",
      ["Find-AppData, both, each with Code sessions", "Find-AppData, the packaged app's data without Code sessions, an unpackaged install's with"]],
    ['a folder an unpackaged install left used while the packaged app has its own',
      '  if ($packaged.Count -gt 0) {\n', '  if ($false) {\n',
      ["Find-AppData, the packaged app's data without Code sessions, an unpackaged install's with", "Find-AppData, the packaged app's data without Code sessions: none"]],
    ["another Windows session's processes counted",
      '    if ($process.SessionId -ne $session) { continue }\n', '',
      ['no process of another Windows session is counted', 'every process found runs in this Windows session'], 'no process of another Windows session counted'],
    ['the processes found wrapped in a second array',
      '  $running = Get-AppProcesses $Roots\n', '  $running = @(Get-AppProcesses $Roots)\n',
      ['and nothing counts as running', 'no folders given', 'a folder no program runs from', 'a storage folder whose LOCK another program holds', 'the LOCK let go']],
    ['-NoExit not looked for',
      "  return -not ($CommandLine -match '(?i)(^|\\s)\"?[-/]noe(x(i(t)?)?)?\"?(\\s|$)')\n", '  return $true\n',
      ['Test-LaunchedForScript, -NoExit:', 'Test-LaunchedForScript, -noexit:', 'Test-LaunchedForScript, -noe:', 'Test-LaunchedForScript, -noex:', 'Test-LaunchedForScript, -noexi:', 'Test-LaunchedForScript, "-NoExit" in quotes', 'Test-LaunchedForScript, /NoExit']],
    ['a command line that names no script taken as one',
      '  if ($CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }\n', '',
      ['Test-LaunchedForScript, a PowerShell window opened from the Start menu', 'Test-LaunchedForScript, another script']],
  ];
  for (const [title, from, to, wanted, needs] of cases) {
    if (needs && untested.includes(needs)) { r.skip(title, 'its check is not tested on this computer'); continue; }
    const copy = path.join(work, 'tool-desktop-fault');
    fs.rmSync(copy, { recursive: true, force: true });
    fs.mkdirSync(path.join(copy, 'lib'), { recursive: true });
    for (const n of fs.readdirSync(path.join(tool, 'lib'))) fs.copyFileSync(path.join(tool, 'lib', n), path.join(copy, 'lib', n));
    const file = path.join(copy, 'lib', 'DesktopApp.ps1');
    const text = fs.readFileSync(file, 'utf8');
    const count = text.split(from).length - 1;
    if (count !== 1) { r.ok(false, title, `the text to change occurs ${count} time(s) in lib\\DesktopApp.ps1; this case must be brought up to date with it`); continue; }
    fs.writeFileSync(file, text.replace(from, () => to));
    expectChecks(r, `${title}: check-desktop-app.js must catch it`, checkerArgs(copy), wanted);
    fs.rmSync(copy, { recursive: true, force: true });
  }
};

function run(mode, args) {
  const r = makeReport();
  if (!modes[mode]) throw new Error('unknown mode ' + mode + '; see the header of this file');
  modes[mode](r, args);
  r.verdict = r.wrong ? `FAULTS: ${r.wrong} WRONG` : r.untested ? `FAULTS CAUGHT, ${r.untested} NOT TESTED` : 'EVERY FAULT CAUGHT BY ITS CHECK ALONE';
  return r;
}
module.exports = { run };

if (require.main === module) {
  // Windows PowerShell 5.1 started with PowerShell 7's PSModulePath finds 7's copies of the modules
  // both have before its own and loses commands such as Get-FileHash; without the variable it
  // builds its own path
  for (const k of Object.keys(process.env)) if (/^psmodulepath$/i.test(k)) delete process.env[k];
  const [mode, ...args] = process.argv.slice(2);
  if (!mode) { console.error('usage: node make-faults.js <mode> ... (see the header of this file)'); process.exit(2); }
  const r = run(mode, args);
  console.log(r.verdict);
  process.exit(r.wrong ? 1 : r.untested ? 3 : 0);
}
