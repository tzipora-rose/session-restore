// Read-only. Cuts one method or function out of each of two capture folders (from a header that
// occurs exactly once on each side to its matching closing brace), tokenizes both with the
// TypeScript scanner, treats every identifier and every short property name (3 characters or
// fewer, the form a minifier gives cross-file references) as interchangeable, and prints every
// place where the remaining tokens differ. A build folder is a desktop-app capture's
// asar\.vite\build; the TypeScript folder is the one `npm root -g` prints, holding typescript\.
// Controls before trusting a result: the same build on both sides must give 0 differences, and a
// copy with one string edited inside the method exactly that 1.
// Usage: node compare-app-methods.js <old build dir> <new build dir> <typescript dir> <header text>
const fs = require('fs');
const path = require('path');
const [oldDir, newDir, tsDir, header] = process.argv.slice(2);
const ts = require(path.join(tsDir, 'typescript'));
const K = ts.SyntaxKind;

function findOnce(dir) {
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    let i = -1;
    while ((i = t.indexOf(header, i + 1)) >= 0) hits.push({ f, t, i });
  }
  if (hits.length !== 1) throw new Error(dir + ': header occurs ' + hits.length + ' times');
  return hits[0];
}
function tokens(text) {
  const sc = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const out = []; const stack = []; let prev = null;
  for (;;) {
    let k = sc.scan();
    if (k === K.EndOfFileToken) break;
    if ((k === K.SlashToken || k === K.SlashEqualsToken) && (!prev || ![K.Identifier, K.NumericLiteral, K.StringLiteral, K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken].includes(prev.kind))) k = sc.reScanSlashToken();
    if (k === K.TemplateHead) stack.push('t'); else if (k === K.OpenBraceToken) stack.push('{');
    else if (k === K.CloseBraceToken) { if (stack.pop() === 't') { k = sc.reScanTemplateToken(false); if (k === K.TemplateMiddle) stack.push('t'); } }
    const tok = { kind: k, text: sc.getTokenText(), pos: sc.getTokenStart() };
    out.push(tok); prev = tok;
  }
  return out;
}
// the method: from the header to the brace that closes the brace the header ends with
function cut(hit) {
  const toks = tokens(hit.t.slice(hit.i, hit.i + 400000));
  let depth = 0, end = -1;
  for (let j = 0; j < toks.length; j++) {
    const k = toks[j].kind;
    if (k === K.OpenBraceToken || k === K.TemplateHead) depth++;
    if (k === K.CloseBraceToken || k === K.TemplateTail) { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error('no closing brace');
  return toks.slice(0, end + 1);
}
function shape(toks) {
  return toks.map((t, j) => {
    if (t.kind === K.Identifier) {
      const before = toks[j - 1];
      const isProp = before && (before.kind === K.DotToken || before.kind === K.QuestionDotToken);
      if (isProp && t.text.length > 3) return t.text;
      return 'ID';
    }
    return t.text;
  });
}
function lcsHunks(a, b, ra, rb) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; continue; }
    const i0 = i, j0 = j;
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) { if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) i++; else j++; }
    out.push('  … ' + rb.slice(Math.max(0, j0 - 10), j0).join(' ') + '  [-' + ra.slice(i0, i).join(' ') + '-]  {+' + rb.slice(j0, j).join(' ') + '+}  ' + rb.slice(j, j + 10).join(' ') + ' …');
  }
  return out;
}
const o = findOnce(oldDir), n = findOnce(newDir);
const ot = cut(o), nt = cut(n);
const hs = lcsHunks(shape(ot), shape(nt), ot.map(t => t.text), nt.map(t => t.text));
console.log('old: ' + o.f + ', ' + ot.length + ' tokens; new: ' + n.f + ', ' + nt.length + ' tokens; ' + hs.length + ' difference(s)');
for (const h of hs) console.log(h);
