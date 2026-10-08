<#
  new-sandbox.ps1 - build a disposable copy of the Claude desktop app's sidebar data for testing
  session-restore.ps1, compare it with how it was built, or remove it safely.

  A sandbox is a fake user profile holding COPIES of the app's sidebar index
  (claude-code-sessions), its settings file (claude_desktop_config.json), its browser storage
  (Local Storage\leveldb) and its IndexedDB folders; minimal account files naming the same accounts
  as Claude Code's real ones; and a junction (a folder link) to the real transcripts folder, which
  session-restore.ps1 only reads. Pass the sandbox's profile folder to the script with -UserProfile.

    Build:    .\new-sandbox.ps1 -Name <name> -SignedInEmail <email of the account to test as>
              .\new-sandbox.ps1 -Name <name> -SignedInAccount <its account id>
    Compare:  .\new-sandbox.ps1 -Name <name> -Compare
    Remove:   .\new-sandbox.ps1 -Name <name> -Remove

  -SignedInAccount takes the account's folder name under claude-code-sessions. It is for an
  account no Claude Code account file names, which -SignedInEmail cannot find: those files name
  only the account Claude Code last ran under.

  Run the script under test from a COPY in a scratch folder, never from its installed folder: it
  writes each run's created-entries manifest beside itself, and a sandbox manifest in the installed
  folder would become a step of the real -Undo stack.

  The junction: remove a sandbox with -Remove, never with a recursive delete. -Remove unlinks the
  junction first (rmdir removes a link, not what it points at), refuses if any other link remains,
  and only then deletes the rest. A recursive delete that follows the link would delete the real
  transcripts.

  The storage copies are taken while the app may be writing them. If the script then reports that a
  storage log did not check out, remove the sandbox and build it again.
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$SignedInEmail,
  [string]$SignedInAccount,
  [switch]$Compare,
  [switch]$Remove,
  [string]$Root = (Join-Path ([System.IO.Path]::GetTempPath()) 'session-restore-sandboxes'),
  [string]$UserProfile = $env:USERPROFILE
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions
if ($Name -notmatch '^[A-Za-z0-9._-]+$') { throw "Name may hold letters, digits, dot, dash and underscore only: $Name" }

$sandbox      = Join-Path $Root $Name
$profileDir   = Join-Path $sandbox 'profile'
$link         = Join-Path $profileDir '.claude\projects'
$realProjects = Join-Path $UserProfile '.claude\projects'
$store        = Join-Path $profileDir 'AppData\Local\Packages\Claude_sandbox\LocalCache\Roaming\Claude'
$fingerprints = Join-Path $sandbox 'fingerprints-at-build.json'

function Test-Link([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return ($null -ne $item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint))
}

function Get-StoreFingerprints {
  $map = [ordered]@{}
  foreach ($file in (Get-ChildItem -LiteralPath $store -Recurse -File -Force | Sort-Object FullName)) {
    $map[$file.FullName.Substring($store.Length + 1)] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  }
  $map
}

if ($Remove) {
  if (-not (Test-Path -LiteralPath $sandbox)) { Write-Host "No sandbox at $sandbox"; return }
  $before = (Get-ChildItem -LiteralPath $realProjects -Force | Measure-Object).Count
  if (Test-Link $link) {
    cmd /c rmdir "$link" | Out-Null
    if (Test-Path -LiteralPath $link) { throw "The junction $link is still there; nothing was deleted." }
  }
  $links = @(Get-ChildItem -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
  if ($links.Count -gt 0) { throw ("Nothing was deleted: the sandbox still holds links: " + (($links | ForEach-Object FullName) -join ', ')) }
  $after = (Get-ChildItem -LiteralPath $realProjects -Force | Measure-Object).Count
  if ($after -ne $before) { throw "The real transcripts folder changed while the link was removed; nothing was deleted." }
  [System.IO.Directory]::Delete($sandbox, $true)
  Write-Host "Removed $sandbox. The transcripts folder it linked to was not touched."
  return
}

if ($Compare) {
  if (-not (Test-Path -LiteralPath $fingerprints)) { throw "No fingerprints for a sandbox named $Name." }
  $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $serializer.MaxJsonLength = [int]::MaxValue
  $then = $serializer.DeserializeObject([System.IO.File]::ReadAllText($fingerprints))
  $now = Get-StoreFingerprints
  $changed = @($then.Keys | Where-Object { $now.Contains($_) -and $now[$_] -ne $then[$_] })
  $gone = @($then.Keys | Where-Object { -not $now.Contains($_) })
  $added = @($now.Keys | Where-Object { -not $then.ContainsKey($_) })
  Write-Host ("Compared with the build: {0} files then, {1} now; {2} changed, {3} gone, {4} added." -f $then.Count, $now.Count, $changed.Count, $gone.Count, $added.Count)
  foreach ($f in $changed) { Write-Host "  changed $f" }
  foreach ($f in $gone) { Write-Host "  gone    $f" }
  foreach ($f in $added) { Write-Host "  added   $f" }
  return
}

if (-not $SignedInEmail -and -not $SignedInAccount) { throw 'Pass -SignedInEmail (the email of the account the sandbox is signed in as) or -SignedInAccount (its account id).' }
if ($SignedInEmail -and $SignedInAccount) { throw 'Pass -SignedInEmail or -SignedInAccount, not both.' }
if (Test-Path -LiteralPath $sandbox) { throw "A sandbox already exists at $sandbox. Remove it with -Remove first." }
if (-not (Test-Path -LiteralPath $realProjects)) { throw "No transcripts folder at $realProjects" }

$package = Get-ChildItem (Join-Path $UserProfile 'AppData\Local\Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude-code-sessions') } |
  Select-Object -First 1
if (-not $package) { throw 'Could not locate the Claude package store under AppData\Local\Packages.' }
$source = Join-Path $package.FullName 'LocalCache\Roaming\Claude'
if ($SignedInAccount -and ($SignedInAccount -notmatch '^[0-9a-fA-F-]{36}$' -or -not (Test-Path -LiteralPath (Join-Path $source ('claude-code-sessions\' + $SignedInAccount)) -PathType Container))) {
  throw "No account folder named $SignedInAccount under claude-code-sessions."
}

function Copy-Shared([string]$From, [string]$To) {
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  foreach ($file in (Get-ChildItem -LiteralPath $From -File | Where-Object { $_.Name -ne 'LOCK' })) {
    $in = [System.IO.File]::Open($file.FullName, 'Open', 'Read', 'ReadWrite, Delete')
    try {
      $out = [System.IO.File]::Create((Join-Path $To $file.Name))
      try { $in.CopyTo($out) } finally { $out.Dispose() }
    } finally { $in.Dispose() }
  }
}

New-Item -ItemType Directory -Path $store -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'claude-code-sessions') -Destination $store -Recurse
Copy-Item -LiteralPath (Join-Path $source 'claude_desktop_config.json') -Destination $store
Copy-Shared (Join-Path $source 'Local Storage\leveldb') (Join-Path $store 'Local Storage\leveldb')
foreach ($db in @(Get-ChildItem -LiteralPath (Join-Path $source 'IndexedDB') -Directory -Filter '*.indexeddb.leveldb' -ErrorAction SilentlyContinue)) {
  Copy-Shared $db.FullName (Join-Path $store ('IndexedDB\' + $db.Name))
}

# Minimal account files, one per real one, named and dated like it: session-restore.ps1 reads the
# email, account id and org id from them and prefers the most recently written record per email.
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$serializer.MaxJsonLength = [int]::MaxValue
$accountFiles = @(Get-ChildItem -LiteralPath $UserProfile -Filter '.claude.json*' -File -Force -ErrorAction SilentlyContinue)
$backups = Join-Path $UserProfile '.claude\backups'
if (Test-Path -LiteralPath $backups) { $accountFiles += @(Get-ChildItem -LiteralPath $backups -Filter '.claude.json*' -File -Force) }
New-Item -ItemType Directory -Path (Join-Path $profileDir '.claude\backups') -Force | Out-Null
$signedIn = $(if ($SignedInAccount) { $SignedInAccount } else { $null })
$written = 0
foreach ($file in $accountFiles) {
  try { $json = $serializer.DeserializeObject([System.IO.File]::ReadAllText($file.FullName)) } catch { continue }
  if (-not ($json -is [System.Collections.IDictionary]) -or -not $json.ContainsKey('oauthAccount')) { continue }
  $oauth = $json['oauthAccount']
  if (-not ($oauth -is [System.Collections.IDictionary]) -or -not $oauth['accountUuid'] -or -not $oauth['emailAddress']) { continue }
  $minimal = @{ oauthAccount = @{ accountUuid = [string]$oauth['accountUuid']; emailAddress = [string]$oauth['emailAddress']; organizationUuid = [string]$oauth['organizationUuid'] } }
  $target = Join-Path $profileDir $file.FullName.Substring($UserProfile.TrimEnd('\').Length + 1)
  [System.IO.File]::WriteAllText($target, $serializer.Serialize($minimal))
  (Get-Item -LiteralPath $target -Force).LastWriteTimeUtc = $file.LastWriteTimeUtc
  $written++
  if ($SignedInEmail -and [string]$oauth['emailAddress'] -ieq $SignedInEmail) { $signedIn = [string]$oauth['accountUuid'] }
}
if (-not $signedIn) { throw "No Claude Code account file names $SignedInEmail, so the sandbox cannot be signed in as it. Pass -SignedInAccount with its account id instead." }
[System.IO.File]::WriteAllText((Join-Path $store 'config.json'), $serializer.Serialize(@{ lastKnownAccountUuid = $signedIn }))

New-Item -ItemType Junction -Path $link -Target $realProjects | Out-Null
[System.IO.File]::WriteAllText($fingerprints, $serializer.Serialize((Get-StoreFingerprints)))

Write-Host "Sandbox profile : $profileDir"
Write-Host ("Signed in as    : {0}" -f $(if ($SignedInEmail) { "$SignedInEmail ($signedIn)" } else { $signedIn }))
Write-Host "Account files   : $written"
Write-Host "Transcripts     : linked, read-only use ($realProjects)"
Write-Host 'Remove it with -Remove, never with a recursive delete.'
