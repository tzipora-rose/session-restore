// Read-only. Case-sensitive: for each exported name, prints the module-local name behind it
// (from the module's trailing export{...} clause) and the first 300 characters of its definition.
// Usage: node export-of.js <module file> <exported name> [...]
const fs = require('fs');
const [file, ...names] = process.argv.slice(2);
const t = fs.readFileSync(file, 'utf8');
const m = t.match(/export\{([^}]*)\}\s*;?\s*(\/\/[^\n]*)?\s*$/);
const map = new Map();
for (const part of (m ? m[1] : '').split(',')) { const [local, exported] = part.trim().split(/\s+as\s+/); map.set(exported ?? local, local); }
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const n of names) {
  const local = map.get(n);
  if (!local) { console.log(`${n}: not exported`); continue; }
  const re = new RegExp('(function\\s+' + esc(local) + '\\s*\\(|(?:\\bvar\\s+|\\blet\\s+|\\bconst\\s+|,)' + esc(local) + '\\s*=(?!=))');
  const d = re.exec(t);
  console.log(`${n} -> ${local}: ` + (d ? t.slice(d.index, d.index + 300) : '(definition not found)'));
}
console.log(`control: ${map.size} exports read`);
