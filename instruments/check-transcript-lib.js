// Independent check of session-restore's lib\Transcripts.ps1: runs its functions in Windows
// PowerShell and compares each answer with one computed here, sharing no code with it.
//   1. Get-ProjectFolderName against the desktop app's own function (copied from its code).
//   2. Get-TranscriptLastRecordMs against a parse here, for every top-level transcript.
//   3. Test-TranscriptAhead on crafted copies, and on every session stored in more than one folder.
// Usage: node check-transcript-lib.js <tool folder> [--profile <dir>]
// The tool folder is the one holding lib\ (a scratch copy under test, or the installed tool).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const toolDir = process.argv[2];
if (!toolDir || !fs.existsSync(path.join(toolDir, 'lib', 'Transcripts.ps1'))) {
  console.error('usage: node check-transcript-lib.js <tool folder holding lib\\Transcripts.ps1> [--profile <dir>]');
  process.exit(2);
}
const pi = process.argv.indexOf('--profile');
const profile = pi > 0 ? process.argv[pi + 1] : os.homedir();
const projects = path.join(profile, '.claude', 'projects');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'check-transcript-lib-'));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };

// Runs a PowerShell snippet after dot-sourcing the two libraries; input and output go through
// JSON files so no argument quoting can change them.
function ps(snippet, input) {
  const inFile = path.join(work, 'in.json'), outFile = path.join(work, 'out.json'), script = path.join(work, 'run.ps1');
  fs.writeFileSync(inFile, JSON.stringify(input), 'utf8');
  const lib = path.join(toolDir, 'lib');
  fs.writeFileSync(script, [
    "$ErrorActionPreference = 'Stop'",
    ". '" + path.join(lib, 'JsJson.ps1').replace(/'/g, "''") + "'",
    ". '" + path.join(lib, 'Transcripts.ps1').replace(/'/g, "''") + "'",
    "$in = ConvertFrom-JsJson ([System.IO.File]::ReadAllText('" + inFile.replace(/'/g, "''") + "', [System.Text.Encoding]::UTF8))",
    snippet,
    "[System.IO.File]::WriteAllText('" + outFile.replace(/'/g, "''") + "', (ConvertTo-JsJson $out), (New-Object System.Text.UTF8Encoding($false)))",
  ].join('\r\n'), 'ascii');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 64 << 20 });
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

// --- 1. project folder names -------------------------------------------------------------------
// The desktop app's function, as it stands in its code (desktop app 2.9939.4.0):
//   function GQn(e,t){let n=e,r=n.replace(/[^a-zA-Z0-9]/g,"-");if(r.length<=WQn)return r;let i=0;
//   for(let e=0;e<n.length;e++)i=(i<<5)-i+n.charCodeAt(e)|0;return`${r.slice(0,WQn)}-${Math.abs(i).toString(36)}`}
function appFolderName(n) {
  const r = n.replace(/[^a-zA-Z0-9]/g, '-');
  if (r.length <= 200) return r;
  let i = 0;
  for (let e = 0; e < n.length; e++) i = (i << 5) - i + n.charCodeAt(e) | 0;
  return `${r.slice(0, 200)}-${Math.abs(i).toString(36)}`;
}
const names = ['C:\\', 'C:\\Projects', 'C:\\Projects\\a folder with spaces\\and a longer name, with punctuation',
  'C:\\work\\some-project', 'D:\\a b\\c.d', 'C:\\t\u00e9st\\\u{1F600}\\x'];
for (const len of [199, 200, 201, 250, 400]) {
  for (let seed = 0; seed < 6; seed++) {
    let s = 'C:\\';
    for (let k = 0; s.length < len; k++) s += String.fromCharCode(32 + ((k * 7919 + seed * 104729) % 95)) + (k % 13 === 0 ? '\\' : '');
    names.push(s.slice(0, len));
  }
}
console.log('--- 1. project folder names: the library against the app\'s own function');
const got1 = ps('$out = [object[]]@($in | ForEach-Object { Get-ProjectFolderName $_ })', names);
let hashed = 0, negative = 0;
names.forEach((n, k) => {
  const want = appFolderName(n);
  if (want.length > 200) { hashed++; let i = 0; for (let e = 0; e < n.length; e++) i = (i << 5) - i + n.charCodeAt(e) | 0; if (i < 0) negative++; }
  if (got1[k] !== want) check(false, 'name of ' + JSON.stringify(n.slice(0, 60)) + ': library ' + JSON.stringify(got1[k]) + ', app ' + JSON.stringify(want));
});
check(got1.length === names.length && names.every((n, k) => got1[k] === appFolderName(n)),
  `${names.length} paths agree, ${hashed} of them long enough for the hash (${negative} with a negative hash)`);
const onDisk = fs.readdirSync(projects).filter(d => fs.statSync(path.join(projects, d)).isDirectory());
// control: some transcript lies in the folder the app's function names for the folder it recorded
let control = null;
for (const d of onDisk) {
  for (const f of fs.readdirSync(path.join(projects, d)).filter(n => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(projects, d, f), 'utf8').split('\n', 50)) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && typeof o.cwd === 'string' && o.cwd) { if (appFolderName(o.cwd) === d) control = d; break; }
    }
    if (control) break;
  }
  if (control) break;
}
check(!!control, 'control: the app\'s function names the folder of a transcript from the folder it recorded' + (control ? ' (' + control + ')' : ''));

// --- 2. last record times -----------------------------------------------------------------------
function lastRecordMs(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let k = lines.length - 1; k >= 0; k--) {
    const s = lines[k].trim();
    if (!s.startsWith('{')) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o && typeof o.timestamp === 'string' && o.timestamp) { const t = Date.parse(o.timestamp); if (!isNaN(t)) return t; }
  }
  return null;
}
const transcripts = [];
for (const d of onDisk) for (const f of fs.readdirSync(path.join(projects, d))) if (f.endsWith('.jsonl')) transcripts.push(path.join(projects, d, f));
console.log('--- 2. last record times: the library against a parse here, ' + transcripts.length + ' transcripts');
const before = transcripts.map(f => fs.statSync(f).mtimeMs);
const got2 = ps('$out = [object[]]@($in | ForEach-Object { $v = Get-TranscriptLastRecordMs $_; if ($null -eq $v) { $null } else { [long]$v } })', transcripts);
let agree = 0, skipped = 0, none = 0;
transcripts.forEach((f, k) => {
  if (fs.statSync(f).mtimeMs !== before[k]) { skipped++; return; }
  const want = lastRecordMs(f);
  if (want === null) none++;
  if (got2[k] === want) agree++;
  else check(false, path.basename(path.dirname(f)) + '\\' + path.basename(f) + ': library ' + got2[k] + ', here ' + want);
});
check(agree + skipped === transcripts.length, `${agree} agree (${none} with no timestamped record), ${skipped} written to during the check and left out`);
check(agree > 0 && got2.some(v => typeof v === 'number'), 'control: the library returned times, not only nothing');

// --- 3. whether one copy holds records another lacks --------------------------------------------
console.log('--- 3. copies: the library against the expected answer');
const rec = o => JSON.stringify(o) + '\n';
const base = rec({ type: 'user', timestamp: '2026-09-29T10:00:00.000Z', message: { content: 'a' } }) +
             rec({ type: 'assistant', timestamp: '2026-09-29T10:00:05.000Z', message: { content: 'b' } }) +
             rec({ type: 'mode', mode: 'default' });
const cases = [
  ['identical', base, base, false],
  ['other adds a record with no timestamp', base, base + rec({ type: 'atis-latch', atis: '' }), false],
  ['other adds a message', base, base + rec({ type: 'user', timestamp: '2026-09-29T10:01:00.000Z', message: { content: 'c' } }), true],
  ['other adds a line that is not JSON', base, base + '{"type":"user","timest\n', true],
  ['other differs inside the common part', base, base.replace('"b"', '"x"') + rec({ type: 'mode', mode: 'x' }), true],
  ['other is a prefix of the target', base + rec({ type: 'user', timestamp: '2026-09-29T10:01:00.000Z', message: { content: 'c' } }), base, false],
  ['other is shorter and differs', base, base.slice(0, 20).replace('user', 'usex'), true],
  ['other is empty', base, '', false],
  ['other adds a message after a state record', base, base + rec({ type: 'mode', mode: 'x' }) + rec({ type: 'assistant', timestamp: '2026-09-29T10:02:00.000Z' }), true],
];
const pairs = cases.map(([name, t, o], k) => {
  const tp = path.join(work, 'case' + k + '-target.jsonl'), op = path.join(work, 'case' + k + '-other.jsonl');
  fs.writeFileSync(tp, t, 'utf8'); fs.writeFileSync(op, o, 'utf8');
  return [tp, op];
});
const byId = new Map();
for (const f of transcripts) { const id = path.basename(f, '.jsonl'); if (!byId.has(id)) byId.set(id, []); byId.get(id).push(f); }
const realPairs = [];
for (const [id, files] of byId) if (files.length > 1) for (const t of files) for (const o of files) if (t !== o) realPairs.push([t, o]);
function aheadHere(t, o) {
  const a = fs.readFileSync(t), b = fs.readFileSync(o);
  const n = Math.min(a.length, b.length);
  if (!a.subarray(0, n).equals(b.subarray(0, n))) return true;
  if (b.length <= a.length) return false;
  for (const line of b.subarray(a.length).toString('utf8').split('\n')) {
    const s = line.trim(); if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { return true; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) return true;
    if (typeof r.timestamp === 'string' && r.timestamp) return true;
  }
  return false;
}
const got3 = ps('$out = [object[]]@($in | ForEach-Object { [bool](Test-TranscriptAhead $_[0] $_[1]) })', [...pairs, ...realPairs]);
cases.forEach(([name, , , want], k) => check(got3[k] === want, `${name}: ${got3[k]} (expected ${want})`));
realPairs.forEach(([t, o], k) => {
  const want = aheadHere(t, o), got = got3[cases.length + k];
  check(got === want, `real copies of ${path.basename(t, '.jsonl').slice(0, 8)}: ${path.basename(path.dirname(o))} ahead of ${path.basename(path.dirname(t))}: ${got} (here ${want})`);
});

fs.rmSync(work, { recursive: true, force: true });
console.log(fails ? `\nCHECK FAILED -- ${fails} problem(s)` : '\nCHECK CLEAN');
process.exit(fails ? 1 : 0);
