// Checks that Read-TranscriptHeadLines in a tool folder's lib\Transcripts.ps1 lets another process
// keep writing to the transcript it reads, in Windows PowerShell 5.1, the shell the tool runs in:
//   1. it reads a file that another process holds open for appending;
//   2. once it has returned, another process can append to the file while the PowerShell process
//      that read it is still running.
// Each check has a control that must fail the same test: [System.IO.File]::ReadLines left with
// break, which shares the file for reading only and keeps its handle open until a garbage
// collection. A control that passes means the test could not have caught the fault, and the
// check fails.
// It works on a scratch file under the temp folder and removes it afterwards.
// Usage: node check-shared-read.js <tool folder>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const tool = process.argv[2];
if (!tool || !fs.existsSync(path.join(tool, 'lib', 'Transcripts.ps1'))) { console.error('usage: node check-shared-read.js <tool folder holding lib\\Transcripts.ps1>'); process.exit(2); }
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-restore-shared-read-'));
const file = path.join(dir, 'transcript.jsonl');
fs.writeFileSync(file, Array.from({ length: 300 }, (_, i) => JSON.stringify({ type: 'user', n: i })).join('\n') + '\n');
const env = { ...process.env, SR_TOOL: tool, SR_FILE: file };
const load = ". (Join-Path $env:SR_TOOL 'lib\\JsJson.ps1'); . (Join-Path $env:SR_TOOL 'lib\\Transcripts.ps1'); $ErrorActionPreference = 'Stop'; ";
const readers = {
  tool: load + '$lines = Read-TranscriptHeadLines $env:SR_FILE 250; $n = $lines.Count; ',
  control: load + '$n = 0; foreach ($line in [System.IO.File]::ReadLines($env:SR_FILE)) { $n++; if ($n -ge 250) { break } }; ',
};
const ps = (script, opts) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, ...opts }];

function readsWhileWritten(reader) {
  const fd = fs.openSync(file, 'a');
  try {
    const r = spawnSync(...ps(readers[reader] + "[Console]::Out.WriteLine('COUNT ' + $n)", { encoding: 'utf8' }));
    return /COUNT 250/.test(r.stdout || '') && r.status === 0;
  } finally { fs.closeSync(fd); }
}
function appendableAfter(reader) {
  return new Promise(resolve => {
    const [cmd, args, opts] = ps(readers[reader] + "[Console]::Out.WriteLine('READY ' + $n); [void][Console]::In.ReadLine()", {});
    const child = spawn(cmd, args, opts);
    let out = '', done = false;
    const finish = result => { if (done) return; done = true; try { child.stdin.write('\n'); child.stdin.end(); } catch { } resolve(result); };
    child.stdout.on('data', d => {
      out += d;
      if (!/READY 250/.test(out) || done) return;
      let appended = true, code = null;
      try { fs.appendFileSync(file, JSON.stringify({ type: 'user', appended: true }) + '\n'); } catch (e) { appended = false; code = e.code; }
      finish({ ready: true, appended, code });
    });
    child.on('exit', () => finish({ ready: false, appended: false, code: 'the reader exited before it was ready: ' + out.trim() }));
  });
}

(async () => {
  try {
    console.log('--- 1. the read works while another process holds the transcript open for appending');
    const control1 = readsWhileWritten('control');
    const tool1 = readsWhileWritten('tool');
    check(!control1, 'control: [System.IO.File]::ReadLines cannot open the file then (it could: ' + control1 + ')');
    check(tool1, 'Read-TranscriptHeadLines read its 250 lines');
    console.log('--- 2. after the read returns, another process can append while the reading process still runs');
    const control2 = await appendableAfter('control');
    const tool2 = await appendableAfter('tool');
    check(control2.ready && !control2.appended, 'control: after ReadLines left with break, the append is refused (' + (control2.appended ? 'it was not refused' : control2.code) + ')');
    check(tool2.ready && tool2.appended, 'after Read-TranscriptHeadLines, the append succeeds' + (tool2.appended ? '' : ' (' + tool2.code + ')'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(fails ? `\nCHECK FAILED -- ${fails} problem(s)` : '\nCHECK CLEAN');
  process.exit(fails ? 1 : 0);
})();
