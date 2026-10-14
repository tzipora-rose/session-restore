// Copyright (C) 2026 tzipora-rose
//
// This file is part of session-restore.
//
// session-restore is free software: you can redistribute it and/or modify it under the
// terms of the GNU Affero General Public License, version 3, as published by
// the Free Software Foundation.
//
// session-restore is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for
// more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with session-restore. If not, see <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-only

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
