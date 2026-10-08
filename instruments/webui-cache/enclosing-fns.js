// Read-only. For every occurrence of a needle in a minified JavaScript file, finds the innermost
// enclosing `function NAME(` declaration (or arrow/method when no declaration encloses it within
// the search window) and prints each distinct enclosing function once, whole, up to a length cap.
// Brace matching skips strings, template literals and comments, and treats a `/` that follows an
// operator or opening bracket as the start of a regular expression.
// Usage: node enclosing-fns.js <file> <needle> [max chars per function] [window chars]
const fs = require('fs');
const [file, needle, capArg, windowArg] = process.argv.slice(2);
const cap = Number(capArg || 6000), win = Number(windowArg || 200000);
const text = fs.readFileSync(file, 'utf8');

// Returns the index of the '}' that closes the '{' at `open`, or -1.
function matchBrace(open) {
  let depth = 0, i = open;
  const tplStack = [];
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") { const q = c; i++; while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; } i++; continue; }
    if (c === '`') { i++; while (i < text.length && text[i] !== '`') { if (text[i] === '\\') { i += 2; continue; } if (text[i] === '$' && text[i + 1] === '{') { tplStack.push(depth); depth++; i += 2; break; } i++; } if (text[i] === '`') i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 2; continue; }
    if (c === '/') {
      let j = i - 1; while (j >= 0 && /\s/.test(text[j])) j--;
      if (j < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(text[j]) || /\b(return|typeof|in|of|case|do|else|void|throw)$/.test(text.slice(Math.max(0, j - 8), j + 1))) {
        i++; let cls = false; while (i < text.length) { const d = text[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; i++; } i++; continue;
      }
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (tplStack.length && tplStack[tplStack.length - 1] === depth) {
        tplStack.pop(); i++;
        while (i < text.length && text[i] !== '`') { if (text[i] === '\\') { i += 2; continue; } if (text[i] === '$' && text[i + 1] === '{') { tplStack.push(depth); depth++; i += 2; break; } i++; }
        if (text[i] === '`') i++;
        continue;
      }
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

const re = /function\s*([A-Za-z_$][\w$]*)?\s*\(/g;
const seen = new Map();
let at = -1, hits = 0;
while ((at = text.indexOf(needle, at + 1)) >= 0) {
  hits++;
  let best = null;
  re.lastIndex = Math.max(0, at - win);
  let m;
  const starts = [];
  while ((m = re.exec(text)) && m.index < at) starts.push(m);
  for (let k = starts.length - 1; k >= 0; k--) {
    const s = starts[k];
    const open = text.indexOf('{', s.index + s[0].length - 1);
    if (open < 0 || open > at) continue;
    // the parameter list must close before the body opens
    const close = matchBrace(open);
    if (close >= at) { best = { start: s.index, end: close + 1, name: s[1] || '(anonymous)' }; break; }
  }
  const key = best ? best.start + ':' + best.end : 'none@' + at;
  if (!seen.has(key)) seen.set(key, { best, at: [at] }); else seen.get(key).at.push(at);
}
for (const [, v] of seen) {
  if (!v.best) { console.log('=== no enclosing function found for occurrence at ' + v.at.join(',') + ': ' + JSON.stringify(text.slice(v.at[0] - 200, v.at[0] + 200))); continue; }
  const body = text.slice(v.best.start, v.best.end);
  console.log('=== function ' + v.best.name + ' [' + v.best.start + '..' + v.best.end + ', ' + body.length + ' chars] holds occurrence(s) at ' + v.at.join(','));
  console.log(body.length > cap ? body.slice(0, cap) + ' …[cut ' + (body.length - cap) + ' chars]' : body);
}
console.log('=== ' + hits + ' occurrence(s) of ' + JSON.stringify(needle) + ' in ' + seen.size + ' enclosing function(s)');
