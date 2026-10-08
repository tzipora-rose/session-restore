// Read-only. For each given minified name, says whether a module file defines it (function or
// var/let/const declarator) or imports it, and from which file under which exported name.
// Usage: node resolve-names.js <module file> <name> [<name> ...]
const fs = require('fs');
const [file, ...names] = process.argv.slice(2);
const t = fs.readFileSync(file, 'utf8');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// all import clauses: import{a as b,c}from"./x.js"
const imports = new Map();
for (const m of t.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
  for (const part of m[1].split(',')) {
    const [exported, local] = part.trim().split(/\s+as\s+/);
    imports.set((local ?? exported).trim(), { exported: exported.trim(), from: m[2] });
  }
}
for (const n of names) {
  const e = esc(n);
  const fn = new RegExp('function\\s+' + e + '\\s*\\(').exec(t);
  const v = new RegExp('(?:\\bvar\\s+|\\blet\\s+|\\bconst\\s+|,)' + e + '\\s*=(?!=)').exec(t);
  const imp = imports.get(n);
  console.log(n.padEnd(5) + (fn ? ' function@' + fn.index : '') + (v ? ' declared@' + v.index : '') + (imp ? ' import ' + imp.exported + ' from ' + imp.from : '') + (!fn && !v && !imp ? ' (not found)' : ''));
}
console.log('control: ' + imports.size + ' imported names read');
