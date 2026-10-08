// Read-only. Compares two builds of the app's web interface statement by statement, so a change
// to the code that stores the sidebar shows up although every build renames its identifiers.
// Each top-level statement (and each declarator of a top-level var/let/const list) becomes a
// chunk; inside a chunk, identifiers are renamed in order of first appearance (v1, v2, ...),
// except property names after a dot and object keys, so the same code from two builds compares
// equal. Chunks found on only one side are paired by similarity; a pair that mentions any of the
// given terms is printed as token-level differences, with renamed identifiers treated as equal,
// and an unpaired chunk is printed whole.
// A side is one decoded file, or "@<list file>" naming one file per line (each is chunked on its
// own, and its chunk count is printed, so a file that failed to split shows up). The TypeScript
// folder is the one `npm root -g` prints, holding typescript\.
// Controls before trusting a result: a file against itself, and against a copy with one function
// renamed throughout, must give 0 differences; a copy with one string edited, exactly that 1.
// Usage: node compare-webui-builds.js <old file | @list> <new file | @list> <typescript dir> <term,term,...> [max chars]
const fs = require('fs');
const path = require('path');
const [oldFile, newFile, tsDir, termsArg, capArg] = process.argv.slice(2);
const ts = require(path.join(tsDir, 'typescript'));
const terms = termsArg.split(',').filter(Boolean);
const cap = Number(capArg || 2500);
const K = ts.SyntaxKind;

function tokenize(text) {
  const sc = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const toks = [];
  const braceStack = [];
  let prev = null;
  const regexOk = () => {
    if (!prev) return true;
    const k = prev.kind;
    if (k === K.Identifier || k === K.NumericLiteral || k === K.StringLiteral || k === K.CloseParenToken ||
        k === K.CloseBracketToken || k === K.CloseBraceToken || k === K.NoSubstitutionTemplateLiteral ||
        k === K.TemplateTail || k === K.ThisKeyword || k === K.SuperKeyword || k === K.TrueKeyword ||
        k === K.FalseKeyword || k === K.NullKeyword || k === K.PlusPlusToken || k === K.MinusMinusToken) return false;
    return true;
  };
  for (;;) {
    let kind = sc.scan();
    if (kind === K.EndOfFileToken) break;
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && regexOk()) kind = sc.reScanSlashToken();
    if (kind === K.TemplateHead) braceStack.push('tpl');
    else if (kind === K.OpenBraceToken) braceStack.push('{');
    else if (kind === K.CloseBraceToken) {
      const top = braceStack.pop();
      if (top === 'tpl') {
        kind = sc.reScanTemplateToken(false);
        if (kind === K.TemplateMiddle) braceStack.push('tpl');
      }
    }
    const t = { kind, text: sc.getTokenText(), pos: sc.getTokenStart() };
    toks.push(t);
    prev = t;
  }
  return toks;
}

// Split at depth 0 on ';' and ',' and before function/class/var/let/const/export keywords.
function chunks(text) {
  const toks = tokenize(text);
  const out = [];
  let depth = 0, cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  for (const t of toks) {
    const k = t.kind;
    if (depth === 0 && (k === K.FunctionKeyword || k === K.ClassKeyword || k === K.VarKeyword || k === K.LetKeyword ||
        k === K.ConstKeyword || k === K.ExportKeyword || k === K.ImportKeyword || k === K.AsyncKeyword)) {
      const last = cur[cur.length - 1];
      if (!last || last.kind === K.CloseBraceToken || last.kind === K.SemicolonToken) flush();
    }
    if (k === K.OpenBraceToken || k === K.OpenParenToken || k === K.OpenBracketToken || k === K.TemplateHead || k === K.DollarToken) depth++;
    if (k === K.CloseBraceToken || k === K.CloseParenToken || k === K.CloseBracketToken || k === K.TemplateTail) depth = Math.max(0, depth - 1);
    cur.push(t);
    if (depth === 0 && (k === K.SemicolonToken || k === K.CommaToken)) flush();
  }
  flush();
  return out.map(c => {
    const names = new Map();
    const parts = [];
    for (let i = 0; i < c.length; i++) {
      const t = c[i];
      if (t.kind === K.Identifier || t.kind === K.PrivateIdentifier) {
        const before = c[i - 1], after = c[i + 1];
        const isProp = before && (before.kind === K.DotToken || before.kind === K.QuestionDotToken);
        const isKey = after && after.kind === K.ColonToken && before && (before.kind === K.OpenBraceToken || before.kind === K.CommaToken);
        if (isProp || isKey) { parts.push(t.text); continue; }
        if (!names.has(t.text)) names.set(t.text, 'v' + (names.size + 1));
        parts.push(names.get(t.text));
      } else parts.push(t.text);
    }
    const start = c[0].pos, last = c[c.length - 1];
    return { norm: parts.join(' '), parts, rawToks: c.map(t => t.text), raw: text.slice(start, last.pos + last.text.length) };
  });
}

// Myers diff over two token arrays; returns hunks of [opStart, opEnd) / [npStart, npEnd) ranges.
function myers(a, b) {
  const n = a.length, m = b.length, max = n + m;
  const v = new Int32Array(2 * max + 2), trace = [];
  const off = max;
  v[off + 1] = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) {
        // backtrack
        const edits = [];
        let cx = n, cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd];
          const kk = cx - cy;
          const prevK = (kk === -dd || (kk !== dd && pv[off + kk - 1] < pv[off + kk + 1])) ? kk + 1 : kk - 1;
          const px = pv[off + prevK], py = px - prevK;
          while (cx > px && cy > py) { cx--; cy--; }
          if (cx === px) edits.push({ t: 'ins', y: py }); else edits.push({ t: 'del', x: px });
          cx = px; cy = py;
        }
        edits.reverse();
        return edits;
      }
    }
    if (d > 4000) return null;
  }
  return null;
}

function hunks(oldC, newC, ctx) {
  const shape = p => p.map(x => (/^v\d+$/.test(x) ? "ID" : x));
  const edits = myers(shape(oldC.parts), shape(newC.parts));
  if (!edits) return ['(too many differences to align)'];
  // map edits to sets of changed indices on each side
  const delSet = new Set(edits.filter(e => e.t === 'del').map(e => e.x));
  const insSet = new Set(edits.filter(e => e.t === 'ins').map(e => e.y));
  // walk both sides in lockstep to build hunks
  const out = [];
  let i = 0, j = 0;
  while (i < oldC.parts.length || j < newC.parts.length) {
    if (delSet.has(i) || insSet.has(j)) {
      const i0 = i, j0 = j;
      while (delSet.has(i) || insSet.has(j)) { if (delSet.has(i)) i++; else if (insSet.has(j)) j++; }
      const pre = newC.rawToks.slice(Math.max(0, j0 - ctx), j0).join(' ');
      const post = newC.rawToks.slice(j, j + ctx).join(' ');
      out.push('  … ' + pre + '  [-' + oldC.rawToks.slice(i0, i).join(' ') + '-]  {+' + newC.rawToks.slice(j0, j).join(' ') + '+}  ' + post + ' …');
    } else { i++; j++; }
  }
  return out;
}

function bag(norm) { return new Set(norm.split(' ').filter(x => !/^v\d+$/.test(x) && x.length > 1)); }
function sim(a, b) { let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.max(1, a.size + b.size - n); }

// A side is one file, or "@<list file>" naming one file per line; each file is chunked on its own,
// and each file's chunk count and largest chunk are reported so a file that failed to split shows.
function side(arg, label) {
  const files = arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8').split(/\r?\n/).filter(Boolean) : [arg];
  const all = [];
  for (const f of files) {
    const cs = chunks(fs.readFileSync(f, 'utf8'));
    const biggest = cs.reduce((m, c) => Math.max(m, c.raw.length), 0);
    console.log('control: ' + label + ' ' + path.basename(f) + ': ' + cs.length + ' chunks, largest ' + biggest + ' chars');
    for (const c of cs) all.push(c);
  }
  return all;
}
const A = side(oldFile, 'old');
const B = side(newFile, 'new');
const count = arr => { const m = new Map(); for (const c of arr) m.set(c.norm, (m.get(c.norm) || 0) + 1); return m; };
const ca = count(A), cb = count(B);
const strictOnlyA = A.filter(c => !cb.has(c.norm));
const strictOnlyB = B.filter(c => !ca.has(c.norm));
console.log('control: old ' + A.length + ' chunks, new ' + B.length + ' chunks; identical under renaming: old ' + (A.length - strictOnlyA.length) + ', new ' + (B.length - strictOnlyB.length) + '; only in old ' + strictOnlyA.length + ', only in new ' + strictOnlyB.length);
const mentions = c => terms.filter(t => c.raw.includes(t));
const bagsA = strictOnlyA.map(c => bag(c.norm));
const df = new Map();
bagsA.forEach((b, i) => { for (const x of b) { if (!df.has(x)) df.set(x, []); df.get(x).push(i); } });
const usedA = new Set();
let shown = 0;
for (const c of strictOnlyB) {
  const m = mentions(c);
  const bb = bag(c.norm);
  const votes = new Map();
  for (const x of bb) { const l = df.get(x); if (!l || l.length > 60) continue; for (const i of l) votes.set(i, (votes.get(i) || 0) + 1); }
  const cands = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(e => e[0]);
  let best = -1, bestS = 0;
  for (const i of cands) { const s = sim(bagsA[i], bb); if (s > bestS) { bestS = s; best = i; } }
  const partner = best >= 0 && bestS >= 0.5 ? strictOnlyA[best] : null;
  const mp = partner ? mentions(partner) : [];
  if (partner) usedA.add(best);
  if (!m.length && !mp.length) continue;
  shown++;
  console.log('\n######## NEW chunk mentioning [' + m.join(', ') + ']' + (partner ? ' — paired with an old chunk (similarity ' + bestS.toFixed(2) + ')' : ' — no similar old chunk'));
  if (partner) {
    console.log('    (new statement begins: ' + c.raw.slice(0, 160) + ' …)');
    for (const h of hunks(partner, c, 12)) console.log(h);
  } else console.log('+++ new: ' + (c.raw.length > cap ? c.raw.slice(0, cap) + ' …[cut ' + (c.raw.length - cap) + ']' : c.raw));
}
for (let i = 0; i < strictOnlyA.length; i++) {
  if (usedA.has(i)) continue;
  const c = strictOnlyA[i];
  const m = mentions(c);
  if (!m.length) continue;
  shown++;
  console.log('\n######## OLD-ONLY chunk mentioning [' + m.join(', ') + '], no similar new chunk');
  console.log('--- old: ' + (c.raw.length > cap ? c.raw.slice(0, cap) + ' …[cut ' + (c.raw.length - cap) + ']' : c.raw));
}
console.log('\ncontrol: ' + shown + ' differing chunk(s) mention a term');
