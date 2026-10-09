// Independent check of session-restore's lib\DesktopApp.ps1: runs its functions in Windows
// PowerShell and compares each answer with one written or worked out here, sharing no code with it.
//   1. Find-AppData on profiles built here: the packaged app's data, an unpackaged install's, a
//      packaged app installed over one, both, the packaged app's without Code sessions, none.
//   2. Test-LaunchedForScript on command lines: "Run with PowerShell" as Windows writes it, a
//      PowerShell window opened from the Start menu, -NoExit in its forms, and others.
//   3. Get-ParentProcessName, in a PowerShell this Node process starts.
//   4. Get-AppProcesses and Get-AppActivity: a stand-in program (a copy of ping.exe) running from
//      an unpackaged install's folder built here, then stopped; a storage folder whose LOCK file
//      is held, then let go; and, when the packaged app is installed and running, the app itself:
//      its main process counted, its background service and every other Windows session's
//      processes not. That last part needs a process that can read the app's processes, so it is
//      not tested from a console that is not elevated while the app is.
// Usage: node check-desktop-app.js <tool folder>
// The tool folder is the one holding lib\ (a scratch copy under test, or the installed tool).
// Each check prints "ok" or "FAIL" and its title. Verdict: CHECK CLEAN (exit 0), CHECK INCOMPLETE
// (exit 3) when a part could not be tested on this computer, CHECK FAILED (exit 1).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const toolDir = process.argv[2];
if (!toolDir || !fs.existsSync(path.join(toolDir, 'lib', 'DesktopApp.ps1'))) {
  console.error('usage: node check-desktop-app.js <tool folder holding lib\\DesktopApp.ps1>');
  process.exit(2);
}
// Windows PowerShell 5.1 started with PowerShell 7's PSModulePath finds 7's copies of the modules
// both have before its own and loses commands; without the variable it builds its own path
for (const k of Object.keys(process.env)) if (/^psmodulepath$/i.test(k)) delete process.env[k];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'check-desktop-app-'));
let fails = 0, untested = 0;
const check = (good, title) => { console.log((good ? '  ok   ' : '  FAIL ') + title); if (!good) fails++; };
const skip = (title, why) => { console.log(`  --   ${title}: not tested, ${why}`); untested++; };
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// Runs a snippet after dot-sourcing the libraries; input and output go through JSON files, so no
// argument quoting can change them.
function ps(snippet, input) {
  const inFile = path.join(work, 'in.json'), outFile = path.join(work, 'out.json'), script = path.join(work, 'run.ps1');
  fs.writeFileSync(inFile, JSON.stringify(input === undefined ? null : input), 'utf8');
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  const lib = path.join(toolDir, 'lib');
  fs.writeFileSync(script, [
    "$ErrorActionPreference = 'Stop'",
    ". '" + path.join(lib, 'JsJson.ps1').replace(/'/g, "''") + "'",
    ". '" + path.join(lib, 'DesktopApp.ps1').replace(/'/g, "''") + "'",
    "$in = ConvertFrom-JsJson ([System.IO.File]::ReadAllText('" + inFile.replace(/'/g, "''") + "', [System.Text.Encoding]::UTF8))",
    snippet,
    "[System.IO.File]::WriteAllText('" + outFile.replace(/'/g, "''") + "', (ConvertTo-JsJson $out), (New-Object System.Text.UTF8Encoding($false)))",
  ].join('\r\n'), 'ascii');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 64 << 20 });
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}
// The processes of this computer as Windows Management Instrumentation gives them, read with a
// query of this checker's own.
function processTable() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, SessionId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress"],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out);
}
const mkdir = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };

// --- 1. where the app keeps its data --------------------------------------------------------------
console.log('--- 1. Find-AppData on profiles built here');
const profiles = path.join(work, 'profiles');
const pkgData = (p, fam) => path.join(p, 'AppData', 'Local', 'Packages', fam, 'LocalCache', 'Roaming', 'Claude');
const roamingOf = p => path.join(p, 'AppData', 'Roaming', 'Claude');
// each case: how its profile is built, and, written by hand, which folder must be used (null:
// none, with what the reason must name)
const cases1 = [
  { name: 'the packaged app', build: p => mkdir(pkgData(p, 'Claude_test1'), 'claude-code-sessions'), want: p => pkgData(p, 'Claude_test1') },
  { name: 'an unpackaged install, no package folder', build: p => mkdir(roamingOf(p), 'claude-code-sessions'), want: p => roamingOf(p) },
  { name: 'a packaged app installed over an unpackaged one', build: p => { mkdir(p, 'AppData', 'Local', 'Packages', 'Claude_test1', 'LocalCache'); mkdir(roamingOf(p), 'claude-code-sessions'); }, want: p => roamingOf(p) },
  { name: 'both, each with Code sessions: the packaged app\'s', build: p => { mkdir(pkgData(p, 'Claude_test1'), 'claude-code-sessions'); mkdir(roamingOf(p), 'claude-code-sessions'); }, want: p => pkgData(p, 'Claude_test1') },
  { name: 'the packaged app\'s data without Code sessions, an unpackaged install\'s with: none', build: p => { mkdir(pkgData(p, 'Claude_test1')); mkdir(roamingOf(p), 'claude-code-sessions'); }, want: () => null, names: p => [pkgData(p, 'Claude_test1'), roamingOf(p)] },
  { name: 'the packaged app\'s data without Code sessions: none', build: p => mkdir(pkgData(p, 'Claude_test1')), want: () => null, names: p => [pkgData(p, 'Claude_test1')], notNames: p => [roamingOf(p)] },
  { name: 'an unpackaged install\'s folder without Code sessions: none', build: p => mkdir(roamingOf(p)), want: () => null, neither: true },
  { name: 'nothing at all: none', build: p => mkdir(p), want: () => null, neither: true },
  { name: 'two package folders, the second with Code sessions: the second\'s', build: p => { mkdir(pkgData(p, 'Claude_aaa')); mkdir(pkgData(p, 'Claude_bbb'), 'claude-code-sessions'); }, want: p => pkgData(p, 'Claude_bbb') },
];
const inputs1 = cases1.map((c, k) => { const p = path.join(profiles, 'p' + k); mkdir(p); c.build(p); return p; });
const got1 = ps('$out = [object[]]@($in | ForEach-Object { $r = Find-AppData $_; $o = New-JsObject; $o[\'root\'] = $r.Root; $o[\'problem\'] = $r.Problem; $o[\'families\'] = [object[]]@($r.PackageFamilies); $o })', inputs1);
cases1.forEach((c, k) => {
  const p = inputs1[k], r = got1[k], want = c.want(p);
  let good = want ? same(r.root, want) && !r.problem : !r.root && typeof r.problem === 'string' && r.problem.length > 0;
  if (good && c.names) good = c.names(p).every(n => r.problem.toLowerCase().includes(n.toLowerCase()));
  if (good && c.notNames) good = c.notNames(p).every(n => !r.problem.toLowerCase().includes(n.toLowerCase()));
  if (good && c.neither) good = /^neither /.test(r.problem);
  check(good, `Find-AppData, ${c.name}` + (good ? '' : ` (root ${r.root}; problem ${r.problem})`));
});
const famCase = inputs1[cases1.findIndex(c => /two package folders/.test(c.name))];
const famGot = got1[cases1.findIndex(c => /two package folders/.test(c.name))].families;
check(JSON.stringify(famGot) === JSON.stringify(['Claude_aaa', 'Claude_bbb']) && fs.existsSync(famCase), 'Find-AppData names every package folder as a package family');

// --- 2. whether this PowerShell was started to run the script and ends with it ---------------
console.log('--- 2. Test-LaunchedForScript on command lines');
const ps1 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const runWith = s => `"${ps1}" "-Command" "if((Get-ExecutionPolicy ) -ne 'AllSigned') { Set-ExecutionPolicy -Scope Process Bypass }; & '${s}'"`;
const script = 'C:\\x\\session-restore.ps1';
const cases2 = [
  ['"Run with PowerShell", as Windows writes it', runWith(script), true],
  ['a double-click where scripts run that way', `"${ps1}" "${script}"`, true],
  ['powershell -File from a console, other -No... switches given', `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${script} -DryRun`, true],
  ['the script named in other letter case', `powershell.exe -File C:\\X\\SESSION-RESTORE.PS1`, true],
  ['a folder name holding -noe', `powershell.exe -File C:\\a-noe\\session-restore.ps1`, true],
  ['a PowerShell window opened from the Start menu', `"${ps1}"`, false],
  ['-NoExit', `"${ps1}" -NoExit -ExecutionPolicy Bypass -File ${script}`, false],
  ['-noexit', `powershell.exe -noexit -File ${script}`, false],
  ['-noe', `powershell.exe -noe -File ${script}`, false],
  ['-noex', `powershell.exe -noex -File ${script}`, false],
  ['-noexi', `powershell.exe -NoExi -File ${script}`, false],
  ['"-NoExit" in quotes', `"${ps1}" "-NoExit" "-File" "${script}"`, false],
  ['/NoExit', `powershell.exe /NoExit -File ${script}`, false],
  ['another script', `powershell.exe -File C:\\x\\other.ps1`, false],
  ['an empty command line', '', false],
];
const got2 = ps('$out = [object[]]@($in | ForEach-Object { [bool](Test-LaunchedForScript $_ \'session-restore.ps1\') })', cases2.map(c => c[1]));
cases2.forEach(([name, , want], k) => check(got2[k] === want, `Test-LaunchedForScript, ${name}: ${got2[k]}`));

// --- 3. the parent of a PowerShell this process starts -------------------------------------------
console.log('--- 3. Get-ParentProcessName');
const got3 = ps('$out = Get-ParentProcessName', null);
check(same(got3, 'node'), `Get-ParentProcessName names this Node process: ${got3}`);

// --- 4. the app's processes, and whether it counts as running ------------------------------------
console.log('--- 4. Get-AppProcesses and Get-AppActivity');
const standinProfile = path.join(work, 'standin-profile');
const unpackaged = mkdir(standinProfile, 'AppData', 'Local', 'AnthropicClaude');
const standinExe = path.join(mkdir(unpackaged, 'app-9.9.9'), 'claude.exe');
fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE'), standinExe);
const appSnippet = '$roots = [string[]]@($in.roots); $p = Get-AppProcesses $roots; $a = Get-AppActivity $roots ([string[]]@($in.storage)); $out = New-JsObject; $out[\'ids\'] = [object[]]@($p | ForEach-Object { $_.Id }); $out[\'programs\'] = [object[]]@($p | ForEach-Object { $_.Program }); $out[\'reasons\'] = [object[]]@($a)';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const standin = spawn(standinExe, ['-n', '600', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
try {
  for (let k = 0; k < 50 && !alive(standin.pid); k++) sleep(100);
  check(alive(standin.pid), `control: the stand-in runs from ${standinExe} (process ${standin.pid})`);
  let r = ps(appSnippet, { roots: [unpackaged], storage: [] });
  check(r.ids.length === 1 && r.ids[0] === standin.pid && same(r.programs[0], standinExe), `the stand-in running from an unpackaged install's folder is the one process found (${JSON.stringify(r.ids)})`);
  check(JSON.stringify(r.reasons) === JSON.stringify(['1 of its processes are running']), `and the app counts as running: ${JSON.stringify(r.reasons)}`);
  standin.kill();
  for (let k = 0; k < 100 && alive(standin.pid); k++) sleep(100);
  r = ps(appSnippet, { roots: [unpackaged], storage: [] });
  check(r.ids.length === 0, `the stand-in stopped: no process found (${JSON.stringify(r.ids)})`);
  check(r.reasons.length === 0, `and nothing counts as running: ${JSON.stringify(r.reasons)}`);
} finally { if (alive(standin.pid)) standin.kill(); }
let r0 = ps(appSnippet, { roots: [], storage: [] });
check(r0.ids.length === 0 && r0.reasons.length === 0, 'no folders given: no process and no reason');
r0 = ps(appSnippet, { roots: [path.join(work, 'nowhere')], storage: [] });
check(r0.ids.length === 0 && r0.reasons.length === 0, 'a folder no program runs from: no process and no reason');

const storage = mkdir(work, 'storage', 'leveldb');
const lock = path.join(storage, 'LOCK');
fs.writeFileSync(lock, '');
const fd = fs.openSync(lock, 'r+');
let r4;
try { r4 = ps(appSnippet, { roots: [], storage: [storage] }); } finally { fs.closeSync(fd); }
check(JSON.stringify(r4.reasons) === JSON.stringify(['its storage folder leveldb is in use']), `a storage folder whose LOCK another program holds: ${JSON.stringify(r4.reasons)}`);
r4 = ps(appSnippet, { roots: [], storage: [storage] });
check(r4.reasons.length === 0, `the LOCK let go: nothing counts as running (${JSON.stringify(r4.reasons)})`);

// the packaged app itself, when it is installed and running
const pkgOut = execFileSync('powershell', ['-NoProfile', '-Command',
  "$p = Get-AppxPackage -Name Claude | Select-Object -First 1; if ($p) { @{ family = $p.PackageFamilyName; install = $p.InstallLocation } | ConvertTo-Json -Compress } else { 'null' }"],
  { encoding: 'utf8' }).trim();
const pkg = JSON.parse(pkgOut || 'null');
if (!pkg) skip('the packaged app\'s own processes', 'the packaged app is not installed on this computer');
else {
  const table = processTable();
  const me = table.find(t => t.ProcessId === process.pid);
  const prefix = pkg.install.replace(/\\+$/, '') + '\\';
  const under = t => typeof t.ExecutablePath === 'string' && t.ExecutablePath.toLowerCase().startsWith(prefix.toLowerCase());
  const mine = table.filter(t => under(t) && t.SessionId === me.SessionId);
  const mains = mine.filter(t => /^claude\.exe$/i.test(t.Name) && !/--type=/.test(t.CommandLine || '') && mine.some(c => c.ParentProcessId === t.ProcessId));
  const others = table.filter(t => under(t) && t.SessionId !== me.SessionId);
  const r = ps('$roots = Get-AppProgramRoots ([string[]]@($in.family)) $null; $p = Get-AppProcesses $roots; $out = New-JsObject; $out[\'roots\'] = [object[]]@($roots); $out[\'ids\'] = [object[]]@($p | ForEach-Object { $_.Id })', { family: pkg.family });
  check(r.roots.length === 1 && same(r.roots[0].replace(/\\+$/, ''), pkg.install.replace(/\\+$/, '')), `Get-AppProgramRoots gives the package's install folder (${r.roots.join(', ')})`);
  if (mains.length === 0) skip('the app\'s main process counted', 'the app is not running, or its processes\' programs cannot be read from here');
  else check(mains.every(m => r.ids.includes(m.ProcessId)), `the app's main process (${mains.map(m => m.ProcessId).join(', ')}) is among the ${r.ids.length} found`);
  if (others.length === 0) skip('no process of another Windows session counted', 'no process of the app\'s runs in another session, or its program cannot be read from here');
  else check(!others.some(o => r.ids.includes(o.ProcessId)), `no process of another Windows session is counted (${others.map(o => o.Name + ' ' + o.ProcessId + ', session ' + o.SessionId).join('; ')})`);
  const foreign = r.ids.filter(id => { const t = table.find(x => x.ProcessId === id); return t && t.SessionId !== me.SessionId; });
  check(foreign.length === 0, `every process found runs in this Windows session (${foreign.length} do not)`);
}

fs.rmSync(work, { recursive: true, force: true });
console.log(fails ? `\nCHECK FAILED -- ${fails} problem(s)` : untested ? `\nCHECK INCOMPLETE -- ${untested} part(s) not tested on this computer` : '\nCHECK CLEAN');
process.exit(fails ? 1 : untested ? 3 : 0);
