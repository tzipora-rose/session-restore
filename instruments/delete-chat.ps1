<#
  delete-chat.ps1 - delete one local Claude Code chat from the Claude desktop app's data the way
  the app's own Delete does it, without signing in to the account that lists the chat. Every
  file the app would remove goes to the Recycle Bin instead, so nothing is destroyed until the
  Recycle Bin is emptied.

  What the app's Delete does, in this order, and what this script does at each step:
    1. Removes the chat's entry file from its account's sidebar folder and drops its id from that
       folder's archived-sessions.idx (rewritten, or removed when no id is left).
       Here: the entry file goes to the Recycle Bin; so does the old archived-sessions.idx before
       the new one is written.
    2. Writes a tombstone file deleted_<id> holding the time in epoch milliseconds, for the
       entry's own id and each transcript id of the chat that no other entry of the same account
       claims.
    3. For each transcript of the chat that no other entry of any account claims, in each project
       folder holding a copy: writes <id>.desktop-released.json, then removes <id>.jsonl and the
       folder <id>; then the session's other files: <id>.ccr-tip.json, <id>.precompact.json and
       <id>.jsonl.pre-import beside it; the folders named <id> in file-history, session-env,
       uploads, tasks and image-cache; the files named <id> in debug, usage-data\facets,
       usage-data\session-meta and startup-perf; and the session's temp folder.
       Here: the same files go to the Recycle Bin.
  Files the app does not handle but that are named after the chat (another tool's caches, for
  example) can be passed with -AlsoRecycle, several separated by | (a character no Windows path
  holds, so a list survives powershell -File); each must exist and carry the transcript id in its
  name. They go to the Recycle Bin last.

  The app keeps only the signed-in account's chats in memory, and rewrites their entries while it
  runs. So the script refuses while the app runs signed in to the chat's account; with the app
  closed, or signed in to another account, it proceeds.

  It refuses a transcript that only appears as an earlier part of another chat. It leaves a
  transcript in place, as the app does, when another entry of any account claims it. And it leaves
  it in place when a copy of it was written in the last 10 minutes, since something may still be
  writing it; the app makes that check by comparing the transcript's last message with the chat's
  last activity, which means reading the transcript, and this script never opens a transcript.

  Usage (Windows PowerShell 5.1):
    Preview, writes nothing:
      powershell -ExecutionPolicy Bypass -File delete-chat.ps1 -Transcript <id> -DryRun
    Delete:
      powershell -ExecutionPolicy Bypass -File delete-chat.ps1 -Transcript <id> [-AlsoRecycle "<path>|<path>"]
    -Account <account id> picks the entry when more than one account lists the chat.
    -UserProfile <path> and -TempRoot <path> point it at another profile (testing).
#>
param(
  [Parameter(Mandatory = $true)][string]$Transcript,
  [string]$Account,
  [string[]]$AlsoRecycle = @(),
  [switch]$DryRun,
  [string]$UserProfile = $env:USERPROFILE,
  [string]$TempRoot
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') { throw 'Run this with Windows PowerShell 5.1 (powershell.exe), not PowerShell 7.' }
if ([IntPtr]::Size -ne 8) { throw 'Run this in a 64-bit PowerShell.' }
Add-Type -AssemblyName System.Web.Extensions

$uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if ($Transcript -notmatch $uuidPattern) { throw "Not a transcript id: $Transcript" }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = [int]::MaxValue

if (-not ('SessionRestore.RecycleBin' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace SessionRestore {
  public static class RecycleBin {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCT {
      public IntPtr hwnd;
      public uint wFunc;
      public string pFrom;
      public string pTo;
      public ushort fFlags;
      [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
      public IntPtr hNameMappings;
      public string lpszProgressTitle;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
    private const uint FO_DELETE = 3;
    private const ushort FOF_SILENT = 0x0004, FOF_NOCONFIRMATION = 0x0010, FOF_ALLOWUNDO = 0x0040,
      FOF_NOERRORUI = 0x0400, FOF_WANTNUKEWARNING = 0x4000;
    // Returns 0 when the shell reports success; FOF_WANTNUKEWARNING makes the shell ask instead
    // of destroying an item it cannot recycle.
    public static int Send(string path, out bool aborted) {
      SHFILEOPSTRUCT op = new SHFILEOPSTRUCT();
      op.wFunc = FO_DELETE;
      op.pFrom = path + "\0";
      op.fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | FOF_WANTNUKEWARNING);
      int result = SHFileOperation(ref op);
      aborted = op.fAnyOperationsAborted;
      return result;
    }
  }
}
'@
}

# The Recycle Bin's own record of an item: each $I file in the user's Recycle Bin folder on that
# drive holds the item's original full path (format 2: UTF-16 path after a 28-byte header). The
# same path can have been recycled before, so the newest record wins.
function Find-RecycledItem([string]$OriginalPath) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $bin = Join-Path ([System.IO.Path]::GetPathRoot($OriginalPath)) ('$Recycle.Bin\' + $sid)
  if (-not (Test-Path -LiteralPath $bin)) { return $null }
  $found = $null
  foreach ($info in (Get-ChildItem -LiteralPath $bin -Force -Filter '$I*' -File)) {
    $bytes = [System.IO.File]::ReadAllBytes($info.FullName)
    if ($bytes.Length -lt 28) { continue }
    $version = [BitConverter]::ToInt64($bytes, 0)
    if ($version -eq 2) {
      $chars = [BitConverter]::ToInt32($bytes, 24)
      $text = [System.Text.Encoding]::Unicode.GetString($bytes, 28, [Math]::Max(0, [Math]::Min($bytes.Length - 28, ($chars - 1) * 2)))
    } elseif ($version -eq 1 -and $bytes.Length -ge 24 + 520) {
      $text = [System.Text.Encoding]::Unicode.GetString($bytes, 24, 520).TrimEnd([char]0)
    } else { continue }
    if ($text -ieq $OriginalPath) {
      $record = [pscustomobject]@{ Info = $info.FullName; Data = (Join-Path $bin ('$R' + $info.Name.Substring(2))); DeletedUtc = [DateTime]::FromFileTimeUtc([BitConverter]::ToInt64($bytes, 16)) }
      if (-not $found -or $record.DeletedUtc -gt $found.DeletedUtc) { $found = $record }
    }
  }
  return $found
}

$script:recycled = 0
function Send-ToRecycleBin([string]$Path) {
  if ($Path.Length -ge 260) { throw "$Path is 260 characters or longer, which the Recycle Bin cannot take; nothing further was done." }
  $before = [DateTime]::UtcNow.AddSeconds(-2)
  $aborted = $false
  $code = [SessionRestore.RecycleBin]::Send($Path, [ref]$aborted)
  if ($code -ne 0 -or $aborted) { throw ("The Recycle Bin did not take {0} (shell result {1}{2}); nothing further was done." -f $Path, $code, $(if ($aborted) { ', cancelled' } else { '' })) }
  if (Test-Path -LiteralPath $Path) { throw "$Path is still there after being sent to the Recycle Bin; nothing further was done." }
  $record = Find-RecycledItem $Path
  if (-not $record -or $record.DeletedUtc -lt $before -or -not (Test-Path -LiteralPath $record.Data)) {
    throw "$Path is gone, but the Recycle Bin holds no record of it from just now. Stop and check the Recycle Bin before running anything else."
  }
  $script:recycled++
  Write-Host "  recycled $Path"
}

function Write-NewFile([string]$Path, [string]$Text) {
  $temp = $Path + '.delete-chat.tmp'
  [System.IO.File]::WriteAllText($temp, $Text, $utf8)
  if (Test-Path -LiteralPath $Path) { [System.IO.File]::Replace($temp, $Path, [NullString]::Value) }
  else { [System.IO.File]::Move($temp, $Path) }
  if ([System.IO.File]::ReadAllText($Path, $utf8) -cne $Text) { throw "$Path did not read back as written." }
}

function Get-Field($Map, [string]$Name) {
  if ($Map -is [System.Collections.IDictionary] -and $Map.ContainsKey($Name)) { return $Map[$Name] }
  return $null
}

# --- where the app, Claude Code and Claude Code's temp folder keep their files ---
$package = Get-ChildItem (Join-Path $UserProfile 'AppData\Local\Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude-code-sessions') } | Select-Object -First 1
if (-not $package) { throw 'Could not find the Claude desktop app''s data under AppData\Local\Packages.' }
$appRoot = Join-Path $package.FullName 'LocalCache\Roaming\Claude'
$sessionsRoot = Join-Path $appRoot 'claude-code-sessions'
$configDir = Join-Path $UserProfile '.claude'
$projectsRoot = Join-Path $configDir 'projects'
if (-not $TempRoot) {
  $base = $env:CLAUDE_CODE_TMPDIR
  if (-not $base) { $base = [System.IO.Path]::GetTempPath() }
  $TempRoot = Join-Path $base 'claude'
}

# --- every entry of every account, with the ids it claims ---
$entries = New-Object System.Collections.Generic.List[object]
foreach ($accountDir in (Get-ChildItem -LiteralPath $sessionsRoot -Directory)) {
  foreach ($orgDir in (Get-ChildItem -LiteralPath $accountDir.FullName -Directory)) {
    foreach ($file in (Get-ChildItem -LiteralPath $orgDir.FullName -Filter 'local_*.json' -File)) {
      try { $e = $json.DeserializeObject([System.IO.File]::ReadAllText($file.FullName, $utf8)) } catch { throw "Could not read the entry $($file.FullName); nothing was done." }
      $live = @((Get-Field $e 'cliSessionId'), (Get-Field $e 'unarchivedCliSessionId')) | Where-Object { $_ -is [string] -and $_ -match '^[0-9A-Za-z_-]{1,64}$' }
      $lineage = @(@(Get-Field $e 'preClearCliSessionId') + @(Get-Field $e 'priorCliSessionIds')) | Where-Object { $_ -is [string] -and $_ -match '^[0-9A-Za-z_-]{1,64}$' }
      $entries.Add([pscustomobject]@{
          Account = $accountDir.Name; Org = $orgDir.Name; Path = $file.FullName
          Id = $file.BaseName; Uuid = $file.BaseName.Substring(6)
          Live = @($live); Lineage = @($lineage)
          IsArchived = ((Get-Field $e 'isArchived') -eq $true)
        })
    }
  }
}

$targets = @($entries | Where-Object { $_.Live -contains $Transcript })
if ($Account) { $targets = @($targets | Where-Object { $_.Account -eq $Account }) }
if ($targets.Count -eq 0) {
  $asEarlier = @($entries | Where-Object { $_.Lineage -contains $Transcript })
  if ($asEarlier.Count -gt 0) { throw "Transcript $Transcript is an earlier part of the chat $($asEarlier[0].Id) ($($asEarlier[0].Account)), not a chat of its own; nothing was done." }
  throw "No entry lists transcript $Transcript as its chat$(if ($Account) { " in account $Account" }); nothing was done."
}
if ($targets.Count -gt 1) { throw ("{0} entries list transcript {1} ({2}); pick one with -Account. Nothing was done." -f $targets.Count, $Transcript, (($targets | ForEach-Object { $_.Account + '\' + $_.Id }) -join ', ')) }
$target = $targets[0]
$orgDir = Split-Path -Parent $target.Path
$others = @($entries | Where-Object { $_.Path -ne $target.Path })
$chatIds = @(@($target.Live) + @($target.Lineage) | Select-Object -Unique)

# --- the app: refuse while it runs signed in to the chat's account ---
$running = 0
try {
  $pkg = Get-AppxPackage -ErrorAction Stop | Where-Object { $_.PackageFamilyName -eq $package.Name } | Select-Object -First 1
  if ($pkg -and $pkg.InstallLocation) {
    $root = $pkg.InstallLocation.TrimEnd('\') + '\'
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $p = $null; try { $p = $_.Path } catch { }; $p -and $p.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) }).Count
  }
} catch { throw 'Could not tell whether the Claude app is running; nothing was done.' }
$signedIn = $null
try { $signedIn = [string](Get-Field ($json.DeserializeObject([System.IO.File]::ReadAllText((Join-Path $appRoot 'config.json'), $utf8))) 'lastKnownAccountUuid') } catch { }
if ($running -gt 0 -and (-not $signedIn -or $signedIn -eq $target.Account)) {
  throw ("The Claude app is running signed in to the account that lists this chat ({0}), so it may rewrite the entry. Quit it fully, including from the system tray, or switch to another account, then run this again. Nothing was done." -f $target.Account)
}

# --- what the app's Delete would do ---
$sameAccountClaims = New-Object 'System.Collections.Generic.HashSet[string]'
$anyClaims = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($o in $others) {
  foreach ($id in @(@($o.Uuid) + @($o.Live) + @($o.Lineage))) {
    [void]$anyClaims.Add($id)
    if ($o.Account -eq $target.Account -and $o.Org -eq $target.Org) { [void]$sameAccountClaims.Add($id) }
  }
}
$tombstones = @(@($target.Uuid) + $chatIds | Select-Object -Unique | Where-Object { -not $sameAccountClaims.Contains($_) })
$kept = New-Object System.Collections.Generic.List[string]
$released = New-Object System.Collections.Generic.List[object]
foreach ($id in $chatIds) {
  if ($anyClaims.Contains($id)) { $kept.Add("$id stays: another entry claims it"); continue }
  $dirs = @(Get-ChildItem -LiteralPath $projectsRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "$id.jsonl") -PathType Leaf })
  if ($dirs.Count -eq 0) { $kept.Add("$id has no transcript on disk"); continue }
  $recent = [DateTime]::UtcNow.AddMinutes(-10)
  $live = @($dirs | Where-Object { (Get-Item -LiteralPath (Join-Path $_.FullName "$id.jsonl")).LastWriteTimeUtc -gt $recent })
  if ($live.Count -gt 0) { $kept.Add("$id stays: a copy of it was written in the last 10 minutes, so something may still be writing it"); continue }
  $released.Add([pscustomobject]@{ Id = $id; Dirs = $dirs })
}

$recycle = New-Object System.Collections.Generic.List[string]
$markers = New-Object System.Collections.Generic.List[string]
foreach ($r in $released) {
  foreach ($d in $r.Dirs) {
    $markers.Add((Join-Path $d.FullName ($r.Id + '.desktop-released.json')))
    foreach ($leaf in @("$($r.Id).jsonl", $r.Id, "$($r.Id).ccr-tip.json", "$($r.Id).precompact.json", "$($r.Id).jsonl.pre-import")) {
      $p = Join-Path $d.FullName $leaf
      if (Test-Path -LiteralPath $p) { $recycle.Add($p) }
    }
  }
  foreach ($store in @('file-history', 'session-env', 'uploads', 'tasks', 'image-cache')) {
    $p = Join-Path (Join-Path $configDir $store) $r.Id
    if (Test-Path -LiteralPath $p -PathType Container) { $recycle.Add($p) }
  }
  foreach ($pair in @(@('debug', '.txt'), @('debug', '.1.txt'), @('usage-data\facets', '.json'), @('usage-data\session-meta', '.json'), @('startup-perf', '.txt'), @('startup-perf', '.json'))) {
    $p = Join-Path (Join-Path $configDir $pair[0]) ($r.Id + $pair[1])
    if (Test-Path -LiteralPath $p -PathType Leaf) { $recycle.Add($p) }
  }
  foreach ($d in $r.Dirs) {
    $p = Join-Path (Join-Path $TempRoot $d.Name) $r.Id
    if (Test-Path -LiteralPath $p -PathType Container) { $recycle.Add($p) }
  }
}
$extras = New-Object System.Collections.Generic.List[string]
foreach ($x in @($AlsoRecycle | ForEach-Object { $_ -split '\|' })) {
  $x = $x.Trim()
  if (-not $x) { continue }
  $full = [System.IO.Path]::GetFullPath($x)
  if (-not (Test-Path -LiteralPath $full)) { throw "-AlsoRecycle: $full does not exist; nothing was done." }
  if ((Split-Path -Leaf $full) -notlike "*$Transcript*") { throw "-AlsoRecycle: $full is not named after transcript $Transcript; nothing was done." }
  $extras.Add($full)
}

# The shell's delete call destroys, without recycling and without any warning, an item whose path
# is 260 characters or longer (measured: it reported success and the Recycle Bin got no entry). So
# every path the run would recycle, or write, and every file inside a folder it would recycle,
# must be shorter, or nothing is done.
$tooLong = New-Object System.Collections.Generic.List[string]
$checkPaths = @(@($target.Path, ($target.Path + '.tmp'), (Join-Path $orgDir 'archived-sessions.idx')) + $recycle + $extras + @($markers) + @($tombstones | ForEach-Object { Join-Path $orgDir ('deleted_' + $_) }))
foreach ($p in $checkPaths) {
  if ($p.Length -ge 260) { $tooLong.Add($p) }
  if (Test-Path -LiteralPath $p -PathType Container) {
    foreach ($inner in [System.IO.Directory]::EnumerateFileSystemEntries($p, '*', [System.IO.SearchOption]::AllDirectories)) { if ($inner.Length -ge 260) { $tooLong.Add($inner) } }
  }
}
if ($tooLong.Count -gt 0) { throw ("These paths are 260 characters or longer, which the Recycle Bin cannot take, so nothing was done: " + ($tooLong -join '; ')) }

$idxPath = Join-Path $orgDir 'archived-sessions.idx'
$idxPlan = 'none'
$idxText = $null
if (Test-Path -LiteralPath $idxPath) {
  $ids = $null
  try {
    $idx = $json.DeserializeObject([System.IO.File]::ReadAllText($idxPath, $utf8))
    if ((Get-Field $idx 'v') -eq 1 -and (Get-Field $idx 'archived') -is [System.Collections.IList]) { $ids = @((Get-Field $idx 'archived') | ForEach-Object { [string]$_ }) }
  } catch { }
  if ($null -eq $ids) { $idxPlan = 'unreadable' }
  elseif ($ids -contains $target.Id) {
    $left = [string[]]@($ids | Where-Object { $_ -ne $target.Id -and $_ -match '^local_[A-Za-z0-9_-]+$' } | Select-Object -Unique)
    [System.Array]::Sort($left, [System.StringComparer]::Ordinal)
    if ($left.Count -eq 0) { $idxPlan = 'remove' }
    else { $idxPlan = 'rewrite'; $idxText = '{"v":1,"archived":[' + (($left | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']}' }
  }
}

Write-Host "Chat     : transcript $Transcript, entry $($target.Id)$(if ($target.IsArchived) { ' (archived)' })"
Write-Host "Account  : $($target.Account) / $($target.Org)$(if ($running -gt 0) { " (the app is running, signed in to $signedIn)" } else { ' (the app is closed)' })"
Write-Host 'To the Recycle Bin:'
Write-Host "  $($target.Path)"
if (Test-Path -LiteralPath ($target.Path + '.tmp')) { Write-Host "  $($target.Path).tmp" }
if ($idxPlan -eq 'rewrite' -or $idxPlan -eq 'remove') { Write-Host "  $idxPath (the old one; $(if ($idxPlan -eq 'rewrite') { 'rewritten without the entry' } else { 'no id left, so not rewritten' }))" }
foreach ($p in $recycle) { Write-Host "  $p" }
foreach ($p in $extras) { Write-Host "  $p" }
Write-Host 'Written:'
foreach ($t in $tombstones) { Write-Host ("  " + (Join-Path $orgDir ('deleted_' + $t))) }
foreach ($m in $markers) { Write-Host "  $m" }
if ($idxPlan -eq 'rewrite') { Write-Host "  $idxPath" }
if ($idxPlan -eq 'unreadable') { Write-Host "(archived-sessions.idx is not in the shape this script knows, so it is left alone; the app rebuilds it at its next start.)" }
foreach ($k in $kept) { Write-Host "Kept: $k" }
if ($DryRun) { Write-Host 'DRY RUN - nothing was changed.'; return }

# --- do it, in the app's order ---
Send-ToRecycleBin $target.Path
if (Test-Path -LiteralPath ($target.Path + '.tmp')) { Send-ToRecycleBin ($target.Path + '.tmp') }
if ($idxPlan -eq 'rewrite' -or $idxPlan -eq 'remove') {
  Send-ToRecycleBin $idxPath
  if ($idxPlan -eq 'rewrite') { Write-NewFile $idxPath $idxText }
}
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture)
foreach ($t in $tombstones) { Write-NewFile (Join-Path $orgDir ('deleted_' + $t)) $nowMs }
foreach ($m in $markers) {
  $at = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
  Write-NewFile $m ("{`n  `"v`": 1,`n  `"releasedAt`": `"" + $at + "`",`n  `"reason`": `"delete`"`n}")
}
foreach ($p in $recycle) { Send-ToRecycleBin $p }
foreach ($p in $extras) { Send-ToRecycleBin $p }

$left = @(@($target.Path) + $recycle + $extras | Where-Object { Test-Path -LiteralPath $_ })
if ($left.Count -gt 0) { throw ('Still present after the run: ' + ($left -join ', ')) }
Write-Host ("Done. {0} item(s) are in the Recycle Bin; empty it when you are sure." -f $script:recycled)
