<#
  test-delete-chat.ps1 - proves delete-chat.ps1 (beside it) on fake profiles built under -Root,
  checking its preview, every refusal, a real run, a chat another account also lists, a transcript
  written in the last 10 minutes and a path the Recycle Bin cannot take.

  A real run sends 11 dummy files and folders to the Recycle Bin; the test restores each one with
  the shell's own Restore verb, which puts the data back but leaves each item's $I record in the
  Recycle Bin folder until the bin is emptied. -PlanOnly runs every check except the real run and
  sends nothing to the Recycle Bin.

  The refusal while the app runs signed in to the chat's account needs the Claude app running;
  with it closed, that check is skipped and says so.

  Usage (Windows PowerShell 5.1):
    powershell -ExecutionPolicy Bypass -File test-delete-chat.ps1 [-PlanOnly] [-Root <folder>]
#>
param(
  [string]$Script = (Join-Path $PSScriptRoot 'delete-chat.ps1'),
  [switch]$PlanOnly,
  [string]$Root = (Join-Path ([System.IO.Path]::GetTempPath()) 'delete-chat-test')
)
$ErrorActionPreference = 'Stop'
$here = Join-Path $Root ('run-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $here -Force | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$results = New-Object System.Collections.Generic.List[string]
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') { $results.Add(('{0}  {1}{2}' -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $(if ($Detail) { ' -- ' + $Detail } else { '' }))) }
function W([string]$Path, [string]$Text) { New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null; [IO.File]::WriteAllText($Path, $Text, $utf8) }
function Fingerprint([string]$Root) {
  $m = [ordered]@{}
  foreach ($f in (Get-ChildItem -LiteralPath $Root -Recurse -Force | Sort-Object FullName)) {
    $m[$f.FullName.Substring($Root.Length)] = $(if ($f.PSIsContainer) { 'DIR' } else { (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash })
  }
  $m
}
function Compare-Snapshots($A, $B) {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($k in $A.Keys) { if (-not $B.Contains($k)) { $out.Add("gone $k") } elseif ($A[$k] -ne $B[$k]) { $out.Add("changed $k") } }
  foreach ($k in $B.Keys) { if (-not $A.Contains($k)) { $out.Add("added $k") } }
  , $out
}

$appPackage = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1
if (-not $appPackage) { throw 'The Claude desktop app is not installed, and the test needs its package family name.' }
$pkgName = $appPackage.PackageFamilyName
$appRunning = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $p = $null; try { $p = $_.Path } catch { }; $p -and $p.StartsWith($appPackage.InstallLocation.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
# short account and org folder names keep every fake path under 260 characters
$A = 'a1'; $OA = 'o1'
$B = 'b1'; $OB = 'o2'
$E1 = 'e1e1e1e1-0000-4000-8000-000000000001'; $E2 = 'e2e2e2e2-0000-4000-8000-000000000001'; $E9 = 'e9e9e9e9-0000-4000-8000-000000000001'; $EB = 'ebebebeb-0000-4000-8000-000000000001'
$T1 = '11111111-0000-4000-8000-000000000001'; $T2 = '22222222-0000-4000-8000-000000000001'; $T3 = '33333333-0000-4000-8000-000000000001'; $T4 = '44444444-0000-4000-8000-000000000001'

function Build([string]$Root, [string]$SignedIn, [switch]$TwinInB, [switch]$RecentWrite, [string]$AccountA = $A) {
  if (Test-Path -LiteralPath $Root) { throw "fake root already exists: $Root" }
  $app = Join-Path $Root "p\AppData\Local\Packages\$pkgName\LocalCache\Roaming\Claude"
  $sa = Join-Path $app "claude-code-sessions\$AccountA\$OA"; $sb = Join-Path $app "claude-code-sessions\$B\$OB"
  $proj = Join-Path $Root 'p\.claude\projects'
  W (Join-Path $app 'config.json') ('{"lastKnownAccountUuid":"' + $SignedIn + '"}')
  $firstCopy = Join-Path $proj "C--\$T1.jsonl"
  W $firstCopy '{"type":"user","timestamp":"2026-01-01T00:00:00.000Z"}'
  W (Join-Path $proj "C--\$T1\custom-title.json") '{"x":1}'
  W (Join-Path $proj "C--Other\$T1.jsonl") '{"type":"user","timestamp":"2026-01-01T00:00:00.000Z"}'
  W (Join-Path $proj "C--\$T2.jsonl") '{}'
  W (Join-Path $proj "C--\$T3.jsonl") '{}'
  W (Join-Path $proj "C--\$T4.jsonl") '{}'
  # transcripts last written an hour ago, except the second copy when a recent write is staged
  foreach ($j in (Get-ChildItem -LiteralPath $proj -Recurse -Filter '*.jsonl' -File)) { $j.LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-1) }
  if ($RecentWrite) { (Get-Item -LiteralPath (Join-Path $proj "C--Other\$T1.jsonl")).LastWriteTimeUtc = [DateTime]::UtcNow }
  $act = [DateTimeOffset]::UtcNow.AddHours(-1).ToUnixTimeMilliseconds()
  W (Join-Path $sa "local_$E1.json") ('{"sessionId":"local_' + $E1 + '","cliSessionId":"' + $T1 + '","isArchived":true,"lastActivityAt":' + $act + ',"title":"x"}')
  W (Join-Path $sa "local_$E2.json") ('{"sessionId":"local_' + $E2 + '","cliSessionId":"' + $T2 + '","priorCliSessionIds":["' + $T3 + '"],"isArchived":false,"lastActivityAt":1,"title":"y"}')
  W (Join-Path $sa 'archived-sessions.idx') ('{"v":1,"archived":["local_' + $E9 + '","local_' + $E1 + '"]}')
  W (Join-Path $sa 'scheduled-tasks.json') '{"scheduledTasks":[]}'
  W (Join-Path $sb "local_$EB.json") ('{"sessionId":"local_' + $EB + '","cliSessionId":"' + $(if ($TwinInB) { $T1 } else { $T4 }) + '","isArchived":false,"lastActivityAt":1,"title":"z"}')
  New-Item -ItemType Directory -Path (Join-Path $Root "p\.claude\session-env\$T1") -Force | Out-Null
  W (Join-Path $Root "p\.claude\debug\$T1.txt") 'debug'
  W (Join-Path $Root "p\.claude\file-history\$T2\keep.txt") 'other chat'
  W (Join-Path $Root "t\claude\C--\$T1\scratch.txt") 'scratch'
  W (Join-Path $Root "t\claude\C--Other\$T1\scratch.txt") 'scratch'
  W (Join-Path $Root "p\.claude\dynamic-workflow\conv-cache\$T1.tsv") 'cache'
  W (Join-Path $Root "p\.claude\dynamic-workflow\text-cache-v3\$T1.json") 'stats'
  W (Join-Path $Root "p\.claude\dynamic-workflow\conv-cache\$T2.tsv") 'cache of another chat'
  [pscustomobject]@{ Root = $Root; Profile = (Join-Path $Root 'p'); Temp = (Join-Path $Root 't\claude'); OrgA = $sa; OrgB = $sb; Proj = $proj }
}
function Run($Fake, [string[]]$Extra) {
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script, '-UserProfile', $Fake.Profile, '-TempRoot', $Fake.Temp) + $Extra
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & powershell.exe @args2 2>&1 | ForEach-Object { "$_" }; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
  [pscustomobject]@{ Code = $code; Text = ($out -join "`n") }
}

# control: the comparison must see a known change, a removal and an addition
$cx = Compare-Snapshots ([ordered]@{ '\one' = '1'; '\two' = '2' }) ([ordered]@{ '\one' = 'X'; '\three' = '3' })
Check 'control: the snapshot comparison finds a known change, removal and addition' (@($cx).Count -eq 3 -and $cx -contains 'changed \one' -and $cx -contains 'gone \two' -and $cx -contains 'added \three') (($cx) -join '; ')
$recycledPaths = New-Object System.Collections.Generic.List[string]
try {
  # --- fake 1: signed in to B while "the app" (the real one, same package family) runs ---
  $f1 = Build (Join-Path $here 'f1') $B
  $longest = (Get-ChildItem -LiteralPath $f1.Root -Recurse -Force | ForEach-Object { $_.FullName.Length } | Measure-Object -Maximum).Maximum
  Check 'every fake path is under 260 characters' ($longest -lt 260) ("longest $longest")
  $before = Fingerprint $f1.Root
  $r = Run $f1 @('-Transcript', $T1, '-DryRun')
  Check 'dry run exits cleanly' ($r.Code -eq 0) $r.Text.Split("`n")[-1]
  Check 'dry run changes nothing' ((Compare-Snapshots $before (Fingerprint $f1.Root)).Count -eq 0)
  foreach ($want in @("local_$E1.json", "C--\$T1.jsonl", "C--Other\$T1.jsonl", "C--\$T1", "session-env\$T1", "debug\$T1.txt", "claude\C--\$T1", "claude\C--Other\$T1", "deleted_$E1", "deleted_$T1", "C--\$T1.desktop-released.json", "C--Other\$T1.desktop-released.json")) {
    Check "dry run plans $want" ($r.Text -like "*$want*")
  }
  Check 'dry run leaves other chats alone' (-not ($r.Text -like "*$T2*") -and -not ($r.Text -like "*$T3*") -and -not ($r.Text -like "*$T4*"))

  $r = Run $f1 @('-Transcript', $T3)
  Check 'refuses an earlier part of another chat' ($r.Code -ne 0 -and $r.Text -like '*earlier part of the chat*') $r.Text.Split("`n")[-1]
  $r = Run $f1 @('-Transcript', '99999999-0000-4000-8000-000000000001')
  Check 'refuses a transcript no entry lists' ($r.Code -ne 0 -and $r.Text -like '*No entry lists*')
  $r = Run $f1 @('-Transcript', $T1, '-AlsoRecycle', (Join-Path $f1.Profile ".claude\dynamic-workflow\conv-cache\$T2.tsv"))
  Check 'refuses an extra not named after the chat' ($r.Code -ne 0 -and $r.Text -like '*is not named after*')
  Check 'refusals changed nothing' ((Compare-Snapshots $before (Fingerprint $f1.Root)).Count -eq 0)

  # signed in to the chat's account while the app runs
  [IO.File]::WriteAllText((Join-Path $f1.Profile "AppData\Local\Packages\$pkgName\LocalCache\Roaming\Claude\config.json"), '{"lastKnownAccountUuid":"' + $A + '"}', $utf8)
  if ($appRunning) {
    $r = Run $f1 @('-Transcript', $T1, '-DryRun')
    Check 'refuses while the app runs signed in to the chat''s account' ($r.Code -ne 0 -and $r.Text -like '*Quit it fully*') $r.Text.Split("`n")[-1]
  } else { $results.Add('SKIP  refuses while the app runs signed in to the chat''s account -- the Claude app is not running') }
  [IO.File]::WriteAllText((Join-Path $f1.Profile "AppData\Local\Packages\$pkgName\LocalCache\Roaming\Claude\config.json"), '{"lastKnownAccountUuid":"' + $B + '"}', $utf8)
  Check 'that refusal changed nothing' ((Compare-Snapshots $before (Fingerprint $f1.Root)).Count -eq 0)

  # the real run (skipped with -PlanOnly, which sends nothing to the Recycle Bin)
  if (-not $PlanOnly) {
  $cache = Join-Path $f1.Profile ".claude\dynamic-workflow\conv-cache\$T1.tsv"
  $stats = Join-Path $f1.Profile ".claude\dynamic-workflow\text-cache-v3\$T1.json"
  $r = Run $f1 @('-Transcript', $T1, '-AlsoRecycle', ($cache + '|' + $stats))
  Check 'run exits cleanly' ($r.Code -eq 0) $r.Text.Split("`n")[-1]
  foreach ($l in $r.Text.Split("`n")) { if ($l -match '^\s+recycled (.+)$') { $recycledPaths.Add($Matches[1].Trim()) } }
  $after = Fingerprint $f1.Root
  $d = Compare-Snapshots $before $after
  $expectGone = @("\p\AppData\Local\Packages\$pkgName\LocalCache\Roaming\Claude\claude-code-sessions\$A\$OA\local_$E1.json",
    "\p\.claude\projects\C--\$T1.jsonl", "\p\.claude\projects\C--Other\$T1.jsonl", "\p\.claude\projects\C--\$T1", "\p\.claude\projects\C--\$T1\custom-title.json",
    "\p\.claude\session-env\$T1", "\p\.claude\debug\$T1.txt", "\t\claude\C--\$T1", "\t\claude\C--\$T1\scratch.txt", "\t\claude\C--Other\$T1", "\t\claude\C--Other\$T1\scratch.txt",
    "\p\.claude\dynamic-workflow\conv-cache\$T1.tsv", "\p\.claude\dynamic-workflow\text-cache-v3\$T1.json")
  $expectAdded = @("\p\AppData\Local\Packages\$pkgName\LocalCache\Roaming\Claude\claude-code-sessions\$A\$OA\deleted_$E1", "\p\AppData\Local\Packages\$pkgName\LocalCache\Roaming\Claude\claude-code-sessions\$A\$OA\deleted_$T1",
    "\p\.claude\projects\C--\$T1.desktop-released.json", "\p\.claude\projects\C--Other\$T1.desktop-released.json")
  $expectChanged = @("\p\AppData\Local\Packages\$pkgName\LocalCache\Roaming\Claude\claude-code-sessions\$A\$OA\archived-sessions.idx")
  $want = @($expectGone | ForEach-Object { "gone $_" }) + @($expectAdded | ForEach-Object { "added $_" }) + @($expectChanged | ForEach-Object { "changed $_" })
  $missing = @($want | Where-Object { $d -notcontains $_ }); $unexpected = @($d | Where-Object { $want -notcontains $_ })
  Check 'exactly the expected files changed' ($missing.Count -eq 0 -and $unexpected.Count -eq 0) ('missing: ' + ($missing -join '; ') + ' | unexpected: ' + ($unexpected -join '; '))
  $idx = [IO.File]::ReadAllText((Join-Path $f1.OrgA 'archived-sessions.idx'), $utf8)
  Check 'archived-sessions.idx is the app''s format without the entry' ($idx -ceq ('{"v":1,"archived":["local_' + $E9 + '"]}')) $idx
  $ts = [IO.File]::ReadAllText((Join-Path $f1.OrgA "deleted_$T1"), $utf8)
  $ts2 = [IO.File]::ReadAllText((Join-Path $f1.OrgA "deleted_$E1"), $utf8)
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Check 'tombstones hold one recent epoch-milliseconds time' ($ts -match '^\d{13}$' -and $ts -ceq $ts2 -and [math]::Abs($nowMs - [long]$ts) -lt 600000) $ts
  $mk = [IO.File]::ReadAllText((Join-Path $f1.Proj "C--\$T1.desktop-released.json"), $utf8)
  Check 'release marker is the app''s format' ($mk -cmatch '^\{\n  "v": 1,\n  "releasedAt": "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z",\n  "reason": "delete"\n\}$') ($mk -replace "`n", '\n')
  Check 'recycled 11 items (entry, old idx, two transcript copies, transcript folder, session-env, debug file, two temp folders, two extras split on |)' ($recycledPaths.Count -eq 11) ("{0}" -f $recycledPaths.Count)
  # the old idx can only come back once the new one is out of its way
  Move-Item -LiteralPath (Join-Path $f1.OrgA 'archived-sessions.idx') -Destination (Join-Path $f1.Root 'archived-sessions.idx.written-by-the-run')
  }

  # --- fake 2: the chat is also listed by account B, and its other copy was written late ---
  $f2 = Build (Join-Path $here 'f2') $B -TwinInB -RecentWrite
  $before2 = Fingerprint $f2.Root
  $r = Run $f2 @('-Transcript', $T1)
  Check 'two accounts list it: refuses without -Account' ($r.Code -ne 0 -and $r.Text -like '*pick one with -Account*') $r.Text.Split("`n")[-1]
  $r = Run $f2 @('-Transcript', $T1, '-Account', $A, '-DryRun')
  Check 'twin claimed elsewhere: transcript kept' ($r.Text -like "*Kept: $T1 stays: another entry claims it*")
  Check 'twin claimed elsewhere: entry and tombstones still planned' ($r.Text -like "*local_$E1.json*" -and $r.Text -like "*deleted_$E1*" -and $r.Text -like "*deleted_$T1*" -and -not ($r.Text -like "*$T1.desktop-released.json*"))
  Check 'dry run changed nothing (fake 2)' ((Compare-Snapshots $before2 (Fingerprint $f2.Root)).Count -eq 0)
  # --- fake 3: a path the Recycle Bin cannot take must stop the run before anything is touched ---
  $f3 = Build (Join-Path $here 'f3') $B -AccountA ('a' * 90)
  $entry3 = Join-Path $f3.OrgA "local_$E1.json"
  $r = Run $f3 @('-Transcript', $T1)
  $still = @("\\?\$entry3", ('\\?\' + (Join-Path $f3.Proj "C--\$T1.jsonl")), ('\\?\' + (Join-Path $f3.OrgA 'archived-sessions.idx'))) | Where-Object { [IO.File]::Exists($_) }
  $none = @(('\\?\' + (Join-Path $f3.OrgA "deleted_$T1")), ('\\?\' + (Join-Path $f3.Proj "C--\$T1.desktop-released.json"))) | Where-Object { [IO.File]::Exists($_) }
  Check 'a path of 260 characters or more: refused before anything' ($r.Code -ne 0 -and $r.Text -like '*260 characters or longer*' -and @($still).Count -eq 3 -and @($none).Count -eq 0) ("entry path {0} chars; {1}" -f $entry3.Length, $r.Text.Split("`n")[0])
  # remove the twin in B to reach the recent-write rule
  Move-Item -LiteralPath (Join-Path $f2.OrgB "local_$EB.json") -Destination (Join-Path $f2.Root 'twin-set-aside.json')
  $r = Run $f2 @('-Transcript', $T1, '-DryRun')
  Check 'a copy written in the last 10 minutes: transcript kept' ($r.Text -like "*Kept: $T1 stays: a copy of it was written in the last 10 minutes*") $r.Text.Split("`n")[-1]
} finally {
  # restore every test item from the Recycle Bin with the shell's own Restore verb
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $binDir = Join-Path ([System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($here))) ('$Recycle.Bin\' + $sid)
  $wanted = @{}
  foreach ($p in $recycledPaths) { $wanted[$p.ToLowerInvariant()] = $true }
  $restored = 0
  if ($wanted.Count -gt 0) {
    $byData = @{}
    foreach ($info in (Get-ChildItem -LiteralPath $binDir -Force -Filter '$I*' -File)) {
      $bytes = [IO.File]::ReadAllBytes($info.FullName)
      if ([BitConverter]::ToInt64($bytes, 0) -ne 2) { continue }
      $chars = [BitConverter]::ToInt32($bytes, 24)
      $orig = [Text.Encoding]::Unicode.GetString($bytes, 28, ($chars - 1) * 2)
      if ($wanted.ContainsKey($orig.ToLowerInvariant())) { $byData[(Join-Path $binDir ('$R' + $info.Name.Substring(2))).ToLowerInvariant()] = $orig }
    }
    $shell = New-Object -ComObject Shell.Application
    $bin = $shell.Namespace(10)
    foreach ($item in @($bin.Items())) {
      if ($byData.ContainsKey(([string]$item.Path).ToLowerInvariant())) { $item.InvokeVerb('undelete'); $restored++ }
    }
    Start-Sleep -Seconds 2
    $back = @($recycledPaths | Where-Object { Test-Path -LiteralPath $_ }).Count
    Check 'every test item restored from the Recycle Bin' ($back -eq $recycledPaths.Count -and $restored -eq $recycledPaths.Count) ("{0} restored, {1} of {2} back in place" -f $restored, $back, $recycledPaths.Count)
  }
  $results | ForEach-Object { Write-Host $_ }
}
