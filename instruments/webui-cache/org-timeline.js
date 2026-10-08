// Read-only. From the desktop app's main logs, in order: when the organization behind its sign-in
// token changes (the "[oauth-v2] lookup orgId=" lines), when the app starts, and which organization
// was last seen when each local Code session was started ("Starting local session"). The folder a
// session's entry file sits in does not say which account ran it when a tool gives one chat an entry
// under several accounts; this does. Files are read with fs.readFileSync, which shares them for writing.
// Usage: node org-timeline.js [--name <organization id>=<label> ...] <log> [<log> ...]   (oldest first)
const fs = require('fs');
const args = process.argv.slice(2);
const names = {};
for (let i = args.indexOf('--name'); i >= 0; i = args.indexOf('--name')) {
  const [id, label] = String(args[i + 1]).split('=');
  names[id] = label;
  args.splice(i, 2);
}
let cur = null, starts = 0, changes = 0;
for (const f of args) {
  for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const ts = l.slice(0, 19);
    let m = l.match(/\[oauth-v2\] lookup orgId=([0-9a-f-]{36})/);
    if (m) { if (m[1] !== cur) { changes++; console.log(`${ts}  token org -> ${names[m[1]] ?? m[1]}`); cur = m[1]; } continue; }
    if (/\[info\] Starting app \{/.test(l)) { console.log(`${ts}  app start`); continue; }
    m = l.match(/Starting local session (local_[0-9a-f-]{36})/);
    if (m) { starts++; console.log(`${ts}  session ${m[1].slice(0, 14)} started; last token org seen: ${names[cur] ?? cur}`); }
  }
}
console.log(`control: ${changes} org changes, ${starts} session starts`);
