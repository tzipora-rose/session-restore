// Read-only. Reads the sidebar's saved state (dframe-store) from a COPY of the app's browser
// storage, through read-localstorage.js beside it, and prints its structure: top-level keys, and
// per account scope the groups (names and sizes), the code-sidebar sections (kind, name, member
// count, view settings) and the pin order's length. Prints no chat ids or titles.
// Usage: node summarize-sidebar.js <copy of the Local Storage\leveldb folder>
const { execFileSync } = require('child_process');
const path = require('path');
const [dir] = process.argv.slice(2);
const out = execFileSync(process.execPath, [path.join(__dirname, 'read-localstorage.js'), dir, 'https://claude.ai', 'dframe-store'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lines = out.split('\n');
const head = lines.findIndex(l => l.startsWith('=== dframe-store:'));
if (head < 0) { console.log('dframe-store NOT FOUND'); process.exit(1); }
console.log(lines[head]);
const store = JSON.parse(lines[head + 1]);
const st = store.state;
console.log('version: ' + store.version);
console.log('state keys: ' + Object.keys(st).join(', '));
console.log('lastSidebarScopeKey: ' + st.lastSidebarScopeKey);
console.log('pinnedOrder: ' + (st.pinnedOrder || []).length + ' entries (' + (st.pinnedOrder || []).filter(x => String(x).startsWith('code:local_')).length + ' local code chats)');
const short = k => k.split('/').map(p => p.slice(0, 8)).join('/');
const scopes = new Set([...Object.keys(st.customGroupsByScope || {}), ...Object.keys(st.codeSidebarByScope || {})]);
for (const s of scopes) {
  console.log('\n--- scope ' + short(s));
  const g = (st.customGroupsByScope || {})[s];
  if (g) {
    const assigned = Object.entries(g.assignments || {});
    console.log('  groups: ' + (g.groups || []).map(x => JSON.stringify(x.name) + ' (id ' + String(x.id).slice(0, 8) + ', ' + assigned.filter(([, v]) => v === x.id).length + ' assigned, ' + ((g.order || {})[x.id] || []).length + ' in order)').join('; '));
    console.log('  assignments: ' + assigned.length + ' (' + assigned.filter(([k]) => k.startsWith('code:local_')).length + ' local code chats)');
  } else console.log('  groups: (no customGroupsByScope entry)');
  const c = (st.codeSidebarByScope || {})[s];
  if (c) {
    console.log('  code sidebar: keys ' + Object.keys(c).join(', ') + '; prefsSeeded ' + c.prefsSeeded + '; migratedFrom ' + c.migratedFrom);
    for (const sec of c.sections || []) {
      const v = { order: sec.order, collapsed: sec.collapsed, ascending: sec.ascending, sortBy: sec.sortBy, groupBy: sec.groupBy, show: sec.show };
      console.log('    section ' + sec.kind + (sec.name ? ' ' + JSON.stringify(sec.name) : '') + ' id ' + String(sec.id).slice(0, 12) + (sec.members ? ', ' + sec.members.length + ' members' : '') + ' ' + JSON.stringify(v));
    }
  } else console.log('  code sidebar: (no codeSidebarByScope entry)');
}
