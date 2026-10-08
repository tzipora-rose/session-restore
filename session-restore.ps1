<#
  session-restore.ps1 - make every local Claude conversation visible in the sidebar, and work
  out how the signed-in account's sidebar groups and pinned chats become an exact copy of
  another account's.

  WHY THIS EXISTS
  The Claude desktop app is MSIX/Store-packaged, so its data lives under
  AppData\Local\Packages\Claude_<suffix>\LocalCache\Roaming\Claude\ (a normal console cannot
  follow the AppData\Roaming\Claude alias). The sidebar lists only the sessions that have an
  index entry under the CURRENTLY signed-in account's folder, and shows only that account's
  custom groups and pins. Conversations that are old, were opened under another account, or
  grew too long to scroll up in still exist on disk as transcripts, but if they have no index
  entry they never appear in the sidebar. This script synthesizes a sidebar entry for every
  chat the current account does not list - so the whole on-disk chat corpus consolidates under
  whichever account is signed in now. A chat's earlier transcripts (the app keeps them when a
  chat is rewound) get no entry of their own. Each entry it creates takes its dates, folder,
  title, model, effort, archived state and earlier transcripts from the same chat's entry in
  another account, or else from the transcript.

  If session-restore.config.json names an account in copyGroupsFromEmail, the script also puts
  each chat in the folder its twin in that account names, and works out what has to change so
  that the current account's groups and pinned chats are an exact copy of that account's,
  matching each chat by its transcript. It saves that as a plan. It writes no group and no pin
  itself: the app does, through its own sidebar tools, called by a Claude session in the app.
  -Sidebar lists the calls that are left.

  It auto-detects the package path, the current account and its org, and learns which email
  belongs to which account from Claude Code's own account files - no hardcoded IDs.

  USAGE (run from this folder; each line is a single command):
    Preview only (writes nothing):
      .\session-restore.ps1 -DryRun
    Do it (with Claude fully quit):
      .\session-restore.ps1
    With Claude open again: the calls left for a Claude session to make with the app's sidebar
    tools, so the groups and pins match the plan. Run it again afterwards to check:
      .\session-restore.ps1 -Sidebar
    The same, aiming at the groups and pins as they were before the run:
      .\session-restore.ps1 -Sidebar -Back
    Undo the most recent not-yet-undone run (repeat to walk further back):
      .\session-restore.ps1 -Undo
    Export the signed-in account's groups and pinned chats to a new file, in the exports folder
    of the tool's data folder, or to a file you name (an existing file is never overwritten):
      .\session-restore.ps1 -Export
      .\session-restore.ps1 -ExportTo <file>
    Import such a file: plans that the signed-in account's groups and pins become the file's,
    for a Claude session to apply with -Sidebar, as after a switch:
      .\session-restore.ps1 -Import <file>

  THE TWO STEPS OF A SWITCH: sign in to the account that should receive the chats, fully quit
  Claude (including from the system tray) and run the script: it creates the entries, sets the
  folders and saves the plan. Then reopen Claude and give any session the line the script
  printed: the session runs -Sidebar and makes the calls it lists. Before signing out of the
  account the groups come from, -Sidebar run there saves its groups and pins for the switch,
  reads the saved list back and says what it holds, or that it could not be saved and why.

  SAVED LISTS AND EXPORTS: a saved list (written whenever the script runs under an account) and
  an export have the same form: the account's groups and pinned chats, each chat by its
  transcript, which is the same in every account. Either can be imported, under that account or
  under another one. Chats created after the file was saved are left as they are.

  SAFETY: new sidebar entries are new files only, listed per run in a
  created-entries-<stamp>.txt next to this script. Before a chat entry is moved to another
  folder, and before the config file is filled in, the file is copied to
  .session-restore\backups\<stamp>\ in the user profile, and a write that fails
  its check is rolled back from that copy. -Undo reverses the newest run: it deletes that run's
  new entries and puts the backed-up files back exactly as they were. The script never writes
  into the app's browser storage or its settings file. The plan holds the groups and pins as
  they were before the run, so -Sidebar -Back can list the calls that put them back.

  TITLES: the title of the same chat's entry in another account > app custom title (a rename;
  last seen wins) > app ai-title (last seen wins) > first real user message (injected
  boilerplate skip-listed; every text block of a user record is considered) > dated fallback.
  Extra boilerplate openings to skip can be listed in the config file's titleSkipPrefixes.
  MODEL AND EFFORT: those of the same chat's entry in another account. A chat no other account
  lists takes its model from the transcript itself (newer transcripts log the model on every
  assistant record; the LAST logged model wins; old-format transcripts never log it and fall
  back to claude-opus-4-8) and a nominal effort "high", which is logged nowhere.
  PERMISSION MODE: every entry is created in the app's default mode. Choosing another mode for
  a chat is done in the app.
#>
param(
  [switch]$DryRun,
  [switch]$Undo,
  [switch]$Sidebar,
  [switch]$Back,
  [switch]$Export,
  [string]$ExportTo,
  [string]$Import,
  [string]$UserProfile = $env:USERPROFILE
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\JsJson.ps1')
. (Join-Path $PSScriptRoot 'lib\ChromiumLocalStorage.ps1')
. (Join-Path $PSScriptRoot 'lib\Transcripts.ps1')

$scriptDir      = $PSScriptRoot
$legacyManifest = Join-Path $scriptDir 'created-entries.txt'
$configFile     = Join-Path $scriptDir 'session-restore.config.json'
# Not under AppData: what a program started inside the packaged desktop app creates there, such
# as a Claude session's shell running -Sidebar, is stored in the app's package folder, out of
# sight of a console outside the app. A run and -Sidebar have to see the same files.
$dataDir        = Join-Path $UserProfile '.session-restore'
$accountsFile   = Join-Path $dataDir 'known-accounts.json'
$backupsRoot    = Join-Path $dataDir 'backups'
$planFile       = Join-Path $dataDir 'sidebar-plan.json'
$callsFile      = Join-Path $dataDir 'sidebar-calls.json'
$exportsDir     = Join-Path $dataDir 'exports'
$fallbackModel  = 'claude-opus-4-8'
$appOrigin      = 'https://claude.ai'
$storeItem      = 'dframe-store'
$groupsPref     = 'dframe-group-scopes'
$starredPref    = 'starred-local-code-sessions'
$builtInSkip    = @('This session is being continued', 'Caveat: The messages below', 'Your task is to create a detailed summary', 'Please write a', '<', '[')
$utf8           = New-Object System.Text.UTF8Encoding($false)
$stamp          = Get-Date -Format 'yyyyMMdd-HHmmss'

if ($Back -and -not $Sidebar) { Write-Host '-Back goes with -Sidebar: .\session-restore.ps1 -Sidebar -Back'; return }
if ($Sidebar -and ($DryRun -or $Undo)) { Write-Host '-Sidebar is a step of its own: run it without -DryRun and -Undo.'; return }
# an empty -ExportTo or -Import is refused here, so that it can never fall through to a run
$exportStep = ($Export -or $PSBoundParameters.ContainsKey('ExportTo'))
$importStep = $PSBoundParameters.ContainsKey('Import')
if ($PSBoundParameters.ContainsKey('ExportTo') -and -not $ExportTo.Trim()) { Write-Host '-ExportTo needs the file to write: .\session-restore.ps1 -ExportTo <file>'; return }
if ($importStep -and -not $Import.Trim()) { Write-Host '-Import needs the file to import: .\session-restore.ps1 -Import <file>'; return }
if (($exportStep -or $importStep) -and ($DryRun -or $Undo -or $Sidebar -or $Back -or ($exportStep -and $importStep))) {
  Write-Host '-Export, -ExportTo and -Import are steps of their own: run each without -DryRun, -Undo, -Sidebar, -Back or the other.'
  return
}

# Every read lets another program keep writing to the file and replace it: the app rewrites its
# settings file and its chat entries while it runs.
function Read-TextFile([string]$Path) {
  $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
  try {
    $reader = New-Object System.IO.StreamReader($stream, $utf8)
    try { $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}

function Write-TextFileAtomic([string]$Path, [string]$Text) {
  $temp = $Path + '.session-restore.tmp'
  [System.IO.File]::WriteAllText($temp, $Text, $utf8)
  [System.IO.File]::Replace($temp, $Path, [NullString]::Value)
}

function Get-UserConfig {
  $config = [pscustomobject]@{ CopyGroupsFrom = $null; AutoUpdate = $false; TitleSkipPrefixes = @(); Raw = $null; Text = $null }
  if (-not (Test-Path -LiteralPath $configFile)) { return $config }
  $config.Text = Read-TextFile $configFile
  try { $raw = ConvertFrom-JsJson $config.Text } catch { throw "session-restore.config.json is not valid JSON: $($_.Exception.Message)" }
  if (-not ($raw -is [System.Collections.IDictionary])) { throw 'session-restore.config.json must hold a JSON object.' }
  $config.Raw = $raw
  $from = Get-JsMember $raw 'copyGroupsFromEmail'
  if ($null -ne $from -and -not ($from -is [string])) { throw 'copyGroupsFromEmail in session-restore.config.json must be text.' }
  if ($from) { $config.CopyGroupsFrom = $from.Trim() }
  $auto = Get-JsMember $raw 'autoUpdateCopyGroupsFromEmail'
  if ($null -ne $auto) {
    if (-not ($auto -is [int] -or $auto -is [long]) -or ($auto -ne 0 -and $auto -ne 1)) { throw 'autoUpdateCopyGroupsFromEmail in session-restore.config.json must be 0 or 1.' }
    $config.AutoUpdate = ($auto -eq 1)
  }
  $prefixes = Get-JsMember $raw 'titleSkipPrefixes'
  if ($null -ne $prefixes) {
    if (-not ($prefixes -is [System.Collections.IList]) -or @($prefixes | Where-Object { -not ($_ -is [string]) }).Count -gt 0) {
      throw 'titleSkipPrefixes in session-restore.config.json must be a list of text.'
    }
    $config.TitleSkipPrefixes = @($prefixes | Where-Object { $_ })
  }
  $config
}

function Copy-FileShared([string]$Source, [string]$Destination) {
  $in = [System.IO.File]::Open($Source, 'Open', 'Read', 'ReadWrite, Delete')
  try {
    $out = [System.IO.File]::Create($Destination)
    try { $in.CopyTo($out) } finally { $out.Dispose() }
  } finally { $in.Dispose() }
}

function Copy-FolderShared([string]$Source) {
  $copy = Join-Path ([System.IO.Path]::GetTempPath()) ('session-restore-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $copy | Out-Null
  Get-ChildItem -LiteralPath $Source -File | Where-Object { $_.Name -ne 'LOCK' } |
    ForEach-Object { Copy-FileShared $_.FullName (Join-Path $copy $_.Name) }
  $copy
}

# Reads the sidebar's saved state from the app's browser storage, through a private copy of the
# folder, so the read never touches a file the app has open. Nothing is ever written there.
function Read-SidebarStorage([string]$LevelDbDir) {
  $keys = [byte[][]]::new(1)
  $keys[0] = ConvertTo-LocalStorageKey $appOrigin $storeItem
  $copy = Copy-FolderShared $LevelDbDir
  try {
    $state = Read-LdbState -Directory $copy -Keys $keys
    $text = $null
    if ($state.Values[0]) { $text = ConvertFrom-LocalStorageValue $state.Values[0].Value }
    $store = $null
    if ($text) { $store = ConvertFrom-JsJson $text }
    [pscustomobject]@{ State = $state; Store = $store; StoreText = $text }
  } finally {
    Remove-Item -LiteralPath $copy -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-StoreScopes($Store) {
  $state = Get-JsMember $Store 'state'
  $scopes = Get-JsMember $state 'customGroupsByScope'
  if ($scopes -is [System.Collections.IDictionary]) { return , $scopes }
  return $null
}

function Resolve-CurrentOrg([string]$AccountDir, [string]$Account, $Store, $CodeAccount) {
  $lastScope = [string](Get-JsMember (Get-JsMember $Store 'state') 'lastSidebarScopeKey')
  if ($lastScope -and $lastScope.StartsWith($Account + '/')) {
    $org = $lastScope.Substring($Account.Length + 1)
    if (Test-Path -LiteralPath (Join-Path $AccountDir $org)) { return [pscustomobject]@{ Org = $org; Source = "the sidebar's last-shown account" } }
  }
  if ($CodeAccount -and $CodeAccount.AccountUuid -eq $Account -and $CodeAccount.OrganizationUuid -and
      (Test-Path -LiteralPath (Join-Path $AccountDir $CodeAccount.OrganizationUuid))) {
    return [pscustomobject]@{ Org = $CodeAccount.OrganizationUuid; Source = "Claude Code's account file" }
  }
  $withEntries = Get-ChildItem -LiteralPath $AccountDir -Directory | ForEach-Object {
    $newest = Get-ChildItem -LiteralPath $_.FullName -Filter 'local_*.json' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { [pscustomobject]@{ Org = $_.Name; Newest = $newest.LastWriteTime } }
  } | Sort-Object Newest -Descending | Select-Object -First 1
  if ($withEntries) { return [pscustomobject]@{ Org = $withEntries.Org; Source = 'the org folder with the newest sidebar entry' } }
  $newestFolder = Get-ChildItem -LiteralPath $AccountDir -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newestFolder) { return [pscustomobject]@{ Org = $newestFolder.Name; Source = 'the most recently written org folder' } }
  return $null
}

function Read-CodeAccountFile([string]$Path) {
  try { $json = ConvertFrom-JsJson (Read-TextFile $Path) } catch { return $null }
  $oauth = Get-JsMember $json 'oauthAccount'
  $email = Get-JsMember $oauth 'emailAddress'
  $account = Get-JsMember $oauth 'accountUuid'
  if (-not ($email -is [string]) -or -not ($account -is [string]) -or -not $email -or -not $account) { return $null }
  $org = Get-JsMember $oauth 'organizationUuid'
  [pscustomobject]@{ Email = $email; AccountUuid = $account; OrganizationUuid = [string]$org; LastSeen = (Get-Item -LiteralPath $Path -Force).LastWriteTimeUtc }
}

function Get-KnownAccounts {
  $known = [ordered]@{}
  if (Test-Path -LiteralPath $accountsFile) {
    $record = ConvertFrom-JsJson (Read-TextFile $accountsFile)
    foreach ($entry in @(Get-JsList $record 'accounts')) {
      if (-not ($entry -is [System.Collections.IDictionary])) { continue }
      $email = [string](Get-JsMember $entry 'email')
      if (-not $email) { continue }
      $known[$email.ToLowerInvariant()] = [pscustomobject]@{
        Email = $email; AccountUuid = [string](Get-JsMember $entry 'accountUuid')
        OrganizationUuid = [string](Get-JsMember $entry 'organizationUuid')
        LastSeen = [DateTime]::Parse([string](Get-JsMember $entry 'lastSeen'), [Globalization.CultureInfo]::InvariantCulture, 'RoundtripKind')
      }
    }
  }
  $files = @(Get-ChildItem -LiteralPath $UserProfile -Filter '.claude.json*' -File -Force -ErrorAction SilentlyContinue)
  $backupDir = Join-Path $UserProfile '.claude\backups'
  if (Test-Path -LiteralPath $backupDir) { $files += @(Get-ChildItem -LiteralPath $backupDir -Filter '.claude.json*' -File -Force) }
  foreach ($file in $files) {
    $seen = Read-CodeAccountFile $file.FullName
    if (-not $seen) { continue }
    $id = $seen.Email.ToLowerInvariant()
    if (-not $known.Contains($id) -or $seen.LastSeen -gt $known[$id].LastSeen) { $known[$id] = $seen }
  }
  $known
}

function Save-KnownAccounts($Known) {
  $list = New-Object System.Collections.Generic.List[object]
  foreach ($entry in $Known.Values) {
    $item = New-JsObject
    $item['email'] = $entry.Email
    $item['accountUuid'] = $entry.AccountUuid
    $item['organizationUuid'] = $entry.OrganizationUuid
    $item['lastSeen'] = $entry.LastSeen.ToUniversalTime().ToString('o')
    $list.Add($item)
  }
  $record = New-JsObject
  $record['accounts'] = $list.ToArray()
  if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
  [System.IO.File]::WriteAllText($accountsFile, (ConvertTo-JsJson $record -Indent 2), $utf8)
}

# The transcripts of an entry's chat, as the app counts them: the one it resumes (cliSessionId,
# else unarchivedCliSessionId), and the others it keeps - its earlier parts (preClearCliSessionId,
# priorCliSessionIds) and unarchivedCliSessionId when the chat resumes another transcript.
function Get-EntryTranscripts($Entry) {
  $current = Get-JsMember $Entry 'cliSessionId'
  if (-not ($current -is [string]) -or -not $current) { $current = $null }
  $unarchived = Get-JsMember $Entry 'unarchivedCliSessionId'
  if (-not ($unarchived -is [string]) -or -not $unarchived) { $unarchived = $null }
  $others = New-Object System.Collections.Generic.List[string]
  if ($current -and $unarchived -and $unarchived -cne $current) { $others.Add($unarchived) }
  if (-not $current) { $current = $unarchived }
  $preClear = Get-JsMember $Entry 'preClearCliSessionId'
  if ($preClear -is [string] -and $preClear) { $others.Add($preClear) }
  foreach ($id in @(Get-JsList $Entry 'priorCliSessionIds')) { if ($id -is [string] -and $id) { $others.Add($id) } }
  [pscustomobject]@{ Current = $current; Others = $others.ToArray() }
}

# Every sidebar entry in every account's org folders, by the transcript its chat resumes; and, by
# transcript, the entries that keep it as another part of their chat.
function Get-EntriesByTranscript([string]$SessionsRoot) {
  $byTranscript = New-Object 'System.Collections.Generic.Dictionary[string,System.Collections.Generic.List[object]]'
  $partOf = New-Object 'System.Collections.Generic.Dictionary[string,System.Collections.Generic.List[object]]'
  $unreadable = New-Object System.Collections.Generic.List[string]
  foreach ($accountDir in (Get-ChildItem -LiteralPath $SessionsRoot -Directory)) {
    foreach ($orgDir in (Get-ChildItem -LiteralPath $accountDir.FullName -Directory)) {
      foreach ($file in (Get-ChildItem -LiteralPath $orgDir.FullName -Filter 'local_*.json' -File | Sort-Object Name)) {
        try { $entry = ConvertFrom-JsJson (Read-TextFile $file.FullName) } catch { $unreadable.Add($file.FullName); continue }
        if (-not ($entry -is [System.Collections.IDictionary])) { $unreadable.Add($file.FullName); continue }
        $item = [pscustomobject]@{ Account = $accountDir.Name; Org = $orgDir.Name; Path = $file.FullName; Entry = $entry }
        $transcripts = Get-EntryTranscripts $entry
        foreach ($part in $transcripts.Others) {
          if (-not $partOf.ContainsKey($part)) { $partOf[$part] = New-Object System.Collections.Generic.List[object] }
          $partOf[$part].Add($item)
        }
        $transcript = $transcripts.Current
        if (-not $transcript) { continue }
        if (-not $byTranscript.ContainsKey($transcript)) { $byTranscript[$transcript] = New-Object System.Collections.Generic.List[object] }
        $byTranscript[$transcript].Add($item)
      }
    }
  }
  [pscustomobject]@{ ByTranscript = $byTranscript; PartOf = $partOf; Unreadable = $unreadable }
}

# An entry's time field as epoch milliseconds, or $null when it is not a whole number.
function Get-EntryTimeMs($Entry, [string]$Name) {
  $value = Get-JsMember $Entry $Name
  if ($value -is [int] -or $value -is [long]) { return [long]$value }
  return $null
}

# The entry, in an account other than the receiving one, that a new entry for the same chat takes
# its dates and folder from: the one in the account copyGroupsFromEmail names, else the one most
# recently active.
function Select-Twin($Candidates, [string]$ReceivingAccount, [string]$PreferredAccount) {
  if (-not $Candidates) { return $null }
  $others = @($Candidates | Where-Object { $_.Account -ne $ReceivingAccount })
  if ($others.Count -eq 0) { return $null }
  $preferred = @($others | Where-Object { $PreferredAccount -and $_.Account -eq $PreferredAccount })
  if ($preferred.Count -gt 0) { $others = $preferred }
  @($others | Sort-Object @{ Expression = { $t = Get-EntryTimeMs $_.Entry 'lastActivityAt'; if ($null -eq $t) { [long]0 } else { $t } }; Descending = $true })[0]
}

# Which working folder each project folder under .claude\projects holds the transcripts of,
# learned from the folders the sidebar entries of every account name, keeping those that exist.
# When two of them give the same project folder name, the one more entries name wins.
function Get-FolderByProject($EntriesByTranscript) {
  $counts = New-Object 'System.Collections.Generic.Dictionary[string,int]'
  foreach ($list in $EntriesByTranscript.Values) {
    foreach ($item in $list) {
      $cwd = Get-JsMember $item.Entry 'cwd'
      if (-not ($cwd -is [string]) -or -not $cwd) { continue }
      if ($counts.ContainsKey($cwd)) { $counts[$cwd] = $counts[$cwd] + 1 } else { $counts[$cwd] = 1 }
    }
  }
  $best = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $bestCount = New-Object 'System.Collections.Generic.Dictionary[string,int]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($cwd in (@($counts.Keys) | Sort-Object)) {
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { continue }
    $name = Get-ProjectFolderName $cwd
    if (-not $bestCount.ContainsKey($name) -or $counts[$cwd] -gt $bestCount[$name]) { $best[$name] = $cwd; $bestCount[$name] = $counts[$cwd] }
  }
  , $best
}

# The copy of a transcript a new entry is built from when its twin's folder does not decide it: one
# in a project folder whose working folder is known, the largest first.
function Select-TranscriptCopy($Copies, $FolderByProject) {
  if ($Copies.Count -eq 1) { return $Copies[0] }
  @($Copies | Sort-Object @{ Expression = { $FolderByProject.ContainsKey($_.Directory.Name) }; Descending = $true },
                          @{ Expression = { $_.Length }; Descending = $true },
                          @{ Expression = { $_.Directory.Name } })[0]
}

function Get-AppActivity([string]$PackageFamily, [string[]]$StorageDirs) {
  $reasons = New-Object System.Collections.Generic.List[string]
  $package = $null
  try { $package = Get-AppxPackage -ErrorAction Stop | Where-Object { $_.PackageFamilyName -eq $PackageFamily } | Select-Object -First 1 } catch { }
  if ($package -and $package.InstallLocation) {
    $root = $package.InstallLocation.TrimEnd('\') + '\'
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $path = $null
        try { $path = $_.Path } catch { }
        $path -and $path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
      })
    if ($running.Count -gt 0) { $reasons.Add(('{0} of its processes are running' -f $running.Count)) }
  }
  foreach ($dir in $StorageDirs) {
    $lock = Join-Path $dir 'LOCK'
    if (Test-Path -LiteralPath $lock) {
      try { $handle = [System.IO.File]::Open($lock, 'Open', 'ReadWrite', 'None'); $handle.Dispose() }
      catch { $reasons.Add(('its storage folder {0} is in use' -f (Split-Path -Leaf (Split-Path -Parent $lock)))) }
    }
  }
  , $reasons.ToArray()
}

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }

# Copies everything a run is about to change - chat entries it moves to another folder and,
# when the run fills in the config's account, the config file - into the run's backup folder,
# each copy checked against its original, with a record -Undo reads. A second call adds to it.
function Backup-RunFiles([string]$RunDir, [string[]]$EntryFiles, [string]$ConfigPath) {
  New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
  $recordPath = Join-Path $RunDir 'backup.json'
  $record = New-JsObject
  if (Test-Path -LiteralPath $recordPath) { $record = ConvertFrom-JsJson (Read-TextFile $recordPath) }
  $entryRecords = New-Object System.Collections.Generic.List[object]
  foreach ($item in @(Get-JsList $record 'entries')) { $entryRecords.Add($item) }
  $paths = @($EntryFiles | Where-Object { $_ })
  if ($paths.Count -gt 0) {
    $entryDir = Join-Path $RunDir 'entries'
    New-Item -ItemType Directory -Path $entryDir -Force | Out-Null
    foreach ($path in $paths) {
      $name = Split-Path -Leaf $path
      Copy-Item -LiteralPath $path -Destination (Join-Path $entryDir $name)
      $item = New-JsObject
      $item['path'] = $path
      $item['copy'] = $name
      $item['sha256'] = Get-Sha256 $path
      if ((Get-Sha256 (Join-Path $entryDir $name)) -ne $item['sha256']) { throw "Backup copy of $name does not match the original." }
      $entryRecords.Add($item)
    }
  }
  $record['entries'] = $entryRecords.ToArray()
  if ($ConfigPath) {
    $copy = Join-Path $RunDir 'session-restore.config.json'
    Copy-Item -LiteralPath $ConfigPath -Destination $copy
    $record['configSha256'] = Get-Sha256 $ConfigPath
    if ((Get-Sha256 $copy) -ne $record['configSha256']) { throw 'Backup copy of session-restore.config.json does not match the original.' }
  }
  [System.IO.File]::WriteAllText($recordPath, (ConvertTo-JsJson $record -Indent 2), $utf8)
}

function Restore-RunFiles([string]$RunDir) {
  $record = ConvertFrom-JsJson (Read-TextFile (Join-Path $RunDir 'backup.json'))
  foreach ($item in @(Get-JsList $record 'entries')) {
    $target = [string]$item['path']
    Copy-Item -LiteralPath (Join-Path (Join-Path $RunDir 'entries') ([string]$item['copy'])) -Destination $target -Force
    if ((Get-Sha256 $target) -ne [string]$item['sha256']) { throw "Restored $(Split-Path -Leaf $target) does not match its backup." }
  }
  if (Test-JsKey $record 'configSha256') {
    Copy-Item -LiteralPath (Join-Path $RunDir 'session-restore.config.json') -Destination ($configFile + '.session-restore.tmp') -Force
    [System.IO.File]::Replace($configFile + '.session-restore.tmp', $configFile, [NullString]::Value)
    if ((Get-Sha256 $configFile) -ne [string]$record['configSha256']) { throw 'Restored session-restore.config.json does not match its backup.' }
  }
}

# The org folder of an account that holds the most chat entries.
function Get-BusiestOrg([string]$AccountDir) {
  if (-not (Test-Path -LiteralPath $AccountDir)) { return $null }
  $best = Get-ChildItem -LiteralPath $AccountDir -Directory | ForEach-Object {
    [pscustomobject]@{ Org = $_.Name; Entries = @(Get-ChildItem -LiteralPath $_.FullName -Filter 'local_*.json' -File).Count }
  } | Sort-Object Entries -Descending | Select-Object -First 1
  if ($best -and $best.Entries -gt 0) { return $best.Org }
  return $null
}

# The account copyGroupsFromEmail names: by its email, among the accounts this script has seen,
# or by its account id, which is the name of its folder under claude-code-sessions.
function Resolve-SourceAccount([string]$Value, $Known, [string]$SessionsRoot) {
  if (-not $Value) { return $null }
  $id = $Value.ToLowerInvariant()
  if ($Known.Contains($id)) {
    $seen = $Known[$id]
    return [pscustomobject]@{ AccountUuid = $seen.AccountUuid; OrganizationUuid = $seen.OrganizationUuid; Label = $seen.Email }
  }
  if ($Value -match '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' -and (Test-Path -LiteralPath (Join-Path $SessionsRoot $Value) -PathType Container)) {
    $seen = $Known.Values | Where-Object { $_.AccountUuid -eq $Value } | Select-Object -First 1
    if ($seen) { return [pscustomobject]@{ AccountUuid = $seen.AccountUuid; OrganizationUuid = $seen.OrganizationUuid; Label = $seen.Email } }
    return [pscustomobject]@{ AccountUuid = $id; OrganizationUuid = ''; Label = $id }
  }
  return $null
}

# Every chat entry of one account's org folder: by entry id, and by the transcript its chat
# resumes.
function Get-AccountEntries([string]$OrgDir) {
  $byId = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $byTranscript = New-Object 'System.Collections.Generic.Dictionary[string,System.Collections.Generic.List[string]]'
  if (Test-Path -LiteralPath $OrgDir) {
    foreach ($file in (Get-ChildItem -LiteralPath $OrgDir -Filter 'local_*.json' -File | Sort-Object Name)) {
      try { $entry = ConvertFrom-JsJson (Read-TextFile $file.FullName) } catch { continue }
      if (-not ($entry -is [System.Collections.IDictionary])) { continue }
      $id = [string](Get-JsMember $entry 'sessionId')
      if (-not $id) { $id = $file.BaseName }
      $transcript = (Get-EntryTranscripts $entry).Current
      $byId[$id] = [pscustomobject]@{
        Id = $id; Transcript = $transcript; Path = $file.FullName
        Title = [string](Get-JsMember $entry 'title')
        Archived = ((Get-JsMember $entry 'isArchived') -eq $true)
        Routine = [bool](Get-JsMember $entry 'scheduledTaskId')
        CreatedMs = (Get-EntryTimeMs $entry 'createdAt')
      }
      if ($transcript) {
        if (-not $byTranscript.ContainsKey($transcript)) { $byTranscript[$transcript] = New-Object System.Collections.Generic.List[string] }
        $byTranscript[$transcript].Add($id)
      }
    }
  }
  [pscustomobject]@{ ById = $byId; ByTranscript = $byTranscript }
}

# A scope's groups in sidebar order, each with the entry ids of the local Code chats filed in
# it, in their saved place. The sidebar's own saved state and the saved form in the app's
# settings file have the same shape, so this reads either.
function Get-ScopeGroups($Scope) {
  $groups = New-Object System.Collections.Generic.List[object]
  $byId = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  foreach ($group in @(Get-JsList $Scope 'groups')) {
    $id = Get-JsMember $group 'id'
    $name = Get-JsMember $group 'name'
    if (-not ($id -is [string]) -or -not ($name -is [string]) -or $byId.ContainsKey($id)) { continue }
    $item = [pscustomobject]@{ Id = $id; Name = $name; Sessions = (New-Object System.Collections.Generic.List[string]) }
    $groups.Add($item)
    $byId[$id] = $item
  }
  $notCode = 0
  $placed = New-Object 'System.Collections.Generic.HashSet[string]'
  $assignments = Get-JsMember $Scope 'assignments'
  $order = Get-JsMember $Scope 'order'
  if ($assignments -is [System.Collections.IDictionary]) {
    if ($order -is [System.Collections.IDictionary]) {
      foreach ($gid in @($order.Keys)) {
        if (-not $byId.ContainsKey($gid) -or -not ($order[$gid] -is [System.Collections.IList])) { continue }
        foreach ($key in @($order[$gid])) {
          if (-not ($key -is [string]) -or -not $key.StartsWith('code:')) { continue }
          if (-not (Test-JsKey $assignments $key) -or ([string]$assignments[$key] -cne $gid)) { continue }
          if ($placed.Add($key)) { $byId[$gid].Sessions.Add($key.Substring(5)) }
        }
      }
    }
    foreach ($key in @($assignments.Keys)) {
      $gid = [string]$assignments[$key]
      if (-not $byId.ContainsKey($gid)) { continue }
      if (-not $key.StartsWith('code:')) { $notCode++; continue }
      if ($placed.Add($key)) { $byId[$gid].Sessions.Add($key.Substring(5)) }
    }
  }
  [pscustomobject]@{ Groups = $groups.ToArray(); NotCode = $notCode }
}

# The signed-in account's groups and pins as the app has saved them in its settings file, which
# it rewrites within a second of every change. A group with no chats is not in that file.
function Get-SidebarNow([string]$PrefsPath, [string]$ScopeKey, $Entries) {
  $result = [pscustomobject]@{ Problem = $null; Groups = @(); Pinned = (New-Object 'System.Collections.Generic.HashSet[string]'); PinnedOrder = (New-Object System.Collections.Generic.List[string]) }
  $prefs = $null
  try { $prefs = ConvertFrom-JsJson (Read-TextFile $PrefsPath) } catch { $result.Problem = ("the app's settings file could not be read ({0})" -f $_.Exception.Message); return $result }
  $epitaxy = Get-JsMember (Get-JsMember $prefs 'preferences') 'epitaxyPrefs'
  if (-not ($epitaxy -is [System.Collections.IDictionary])) { $result.Problem = 'claude_desktop_config.json has no preferences.epitaxyPrefs object; the app may have changed how it saves groups and pins'; return $result }
  $scopes = Get-JsMember $epitaxy $groupsPref
  if ($null -ne $scopes -and -not ($scopes -is [System.Collections.IDictionary])) { $result.Problem = "the saved groups in the app's settings file are not in the shape this script knows"; return $result }
  $scope = Get-JsMember $scopes $ScopeKey
  if ($scope -is [System.Collections.IDictionary]) { $result.Groups = @((Get-ScopeGroups $scope).Groups) }
  if ((Test-JsKey $epitaxy $starredPref) -and -not ((Get-JsMember $epitaxy $starredPref) -is [System.Collections.IList])) { $result.Problem = "the pin list in the app's settings file is not in the shape this script knows"; return $result }
  foreach ($id in @(Get-JsList $epitaxy $starredPref)) { if ($id -is [string] -and $Entries.ById.ContainsKey($id) -and $result.Pinned.Add($id)) { $result.PinnedOrder.Add($id) } }
  $result
}

function Get-SidebarSummary($Groups, $PinnedCount) {
  $parts = @(@($Groups) | ForEach-Object { '"{0}" ({1})' -f $_.Name, @($_.Sessions).Count })
  $text = 'no groups with chats'
  if ($parts.Count -gt 0) { $text = $parts -join ', ' }
  '{0}; {1} pinned' -f $text, $PinnedCount
}

# A list of an account's groups and pinned chats, each chat by its transcript, which is the same
# in every account. It is the form of the list this script keeps for each account, written
# whenever it runs under that account so that a later run under another account can fall back on
# it, and of an export; either can be imported. It is written beside its target and read back,
# the way a later run or an import reads it, before it takes the target's place: a write that
# fails leaves the old file as it was, and an export never replaces a file. The result says what
# was written, or why nothing was.
function Write-SidebarList([string]$Path, [string]$Account, [string]$Org, $Entries, $Now, [bool]$NeverReplace) {
  $result = [pscustomobject]@{ Saved = $false; Replaced = $false; Problem = $null; Path = $Path; Groups = @(); Pinned = @(); Unnamed = 0; SavedAt = $null }
  if ($Now.Problem) { $result.Problem = $Now.Problem; return $result }
  $groups = New-Object System.Collections.Generic.List[object]
  $meant = New-Object System.Collections.Generic.List[object]
  foreach ($g in @($Now.Groups)) {
    $transcripts = New-Object System.Collections.Generic.List[object]
    foreach ($id in $g.Sessions) {
      $e = $null
      if (-not $Entries.ById.TryGetValue($id, [ref]$e) -or -not $e.Transcript) { $result.Unnamed++; continue }
      if (-not $transcripts.Contains($e.Transcript)) { $transcripts.Add($e.Transcript) }
    }
    $item = New-JsObject
    $item['name'] = $g.Name
    $item['transcripts'] = $transcripts.ToArray()
    $groups.Add($item)
    $meant.Add([pscustomobject]@{ Name = $g.Name; Transcripts = $transcripts.ToArray() })
  }
  $pinned = New-Object System.Collections.Generic.List[object]
  foreach ($id in $Now.PinnedOrder) {
    $e = $null
    if (-not $Entries.ById.TryGetValue($id, [ref]$e) -or -not $e.Transcript) { $result.Unnamed++; continue }
    if (-not $pinned.Contains($e.Transcript)) { $pinned.Add($e.Transcript) }
  }
  $meantGroups = $meant.ToArray()
  $meantPinned = $pinned.ToArray()
  $record = New-JsObject
  $record['v'] = 1
  $record['savedAt'] = [DateTime]::UtcNow.ToString('o')
  $record['accountUuid'] = $Account
  $record['organizationUuid'] = $Org
  $record['groups'] = $groups.ToArray()
  $record['pinned'] = $meantPinned
  $temp = $Path + '.session-restore.tmp'
  try {
    $folder = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
    if ($NeverReplace -and (Test-Path -LiteralPath $Path)) { $result.Problem = "$Path already exists, and an export never replaces a file"; return $result }
    [System.IO.File]::WriteAllText($temp, (ConvertTo-JsJson $record -Indent 2), $utf8)
    if (-not (Test-SidebarListSame (Read-SidebarList $temp) $Account $Org $meantGroups $meantPinned)) {
      $result.Problem = 'the new list, read back, differs from what was written'
      return $result
    }
    if ($NeverReplace) { [System.IO.File]::Move($temp, $Path) }
    elseif (Test-Path -LiteralPath $Path) { [System.IO.File]::Replace($temp, $Path, [NullString]::Value) }
    else { [System.IO.File]::Move($temp, $Path) }
    $result.Replaced = $true
    $kept = Read-SidebarList $Path
    if (-not (Test-SidebarListSame $kept $Account $Org $meantGroups $meantPinned)) {
      $result.Problem = 'the list, read back from its place, differs from what was written'
      return $result
    }
    $result.Saved = $true
    $result.Groups = $meantGroups
    $result.Pinned = $meantPinned
    $result.SavedAt = $kept.SavedAt
  } catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    $result.Problem = $cause.Message.Trim().TrimEnd('.')
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
  $result
}

function Get-SidebarListPath([string]$Account) { Join-Path $dataDir ('sidebar-list-' + $Account + '.json') }

function Save-SidebarList([string]$Account, [string]$Org, $Entries, $Now) {
  Write-SidebarList (Get-SidebarListPath $Account) $Account $Org $Entries $Now $false
}

function Test-SidebarListSame($List, [string]$Account, [string]$Org, $Groups, $Pinned) {
  if (-not $List -or ($List.AccountUuid -cne $Account) -or ($List.Org -cne $Org) -or ($null -eq $List.Pinned)) { return $false }
  $have = @($List.Groups)
  $want = @($Groups)
  if ($have.Count -ne $want.Count) { return $false }
  for ($i = 0; $i -lt $want.Count; $i++) {
    if ($have[$i].Name -cne $want[$i].Name) { return $false }
    if (-not (Test-SameSequence @($have[$i].Transcripts) @($want[$i].Transcripts))) { return $false }
  }
  return (Test-SameSequence @($List.Pinned) @($Pinned))
}

function Test-SameSequence($A, $B) {
  if (@($A).Count -ne @($B).Count) { return $false }
  for ($i = 0; $i -lt @($B).Count; $i++) { if ([string]@($A)[$i] -cne [string]@($B)[$i]) { return $false } }
  return $true
}

# What a list holds, in words: its groups with their chats, and its pinned chats.
function Format-SidebarListContent($Groups, $Pinned) {
  $parts = @(@($Groups) | ForEach-Object { $n = @($_.Transcripts).Count; '"{0}" ({1} chat{2})' -f $_.Name, $n, $(if ($n -eq 1) { '' } else { 's' }) })
  $text = 'no group holding a chat'
  if ($parts.Count -eq 1) { $text = $parts[0] }
  elseif ($parts.Count -gt 1) { $text = ($parts[0..($parts.Count - 2)] -join ', ') + ' and ' + $parts[-1] }
  $p = @($Pinned).Count
  $pins = 'no pinned chat'
  if ($p -gt 0) { $pins = '{0} pinned chat{1}' -f $p, $(if ($p -eq 1) { '' } else { 's' }) }
  '{0}, and {1}' -f $text, $pins
}

# Says what the list of the signed-in account's groups and pins holds and where, or that it could
# not be saved and why. Run under the account the groups come from, before a switch, this is the
# word that they are saved for the run under the other account.
function Write-SidebarListSave($Save, [string]$Label, [bool]$Template) {
  if (-not $Save.Saved) {
    $after = 'The list saved before, if any, is as it was.'
    if ($Save.Replaced) { $after = ('The file {0} may not hold the right list.' -f $Save.Path) }
    Write-Host ('NOT saved for a switch: the groups and pins of {0} could not be saved, because {1}. {2}' -f $Label, $Save.Problem, $after)
    return
  }
  Write-Host ('Saved for a switch: the groups and pins of {0}: {1}, in {2}. Read back, the file holds exactly these.' -f $Label, (Format-SidebarListContent $Save.Groups $Save.Pinned), $Save.Path)
  if ($Save.Unnamed -gt 0) { Write-Host ('  {0} chat(s) filed in a group or pinned here have no chat entry with a transcript, so the list cannot name them.' -f $Save.Unnamed) }
  if ($Template) { Write-Host 'This is the account session-restore.config.json names in copyGroupsFromEmail: after a switch, a run under another account copies these groups and pins.' }
}

# Reads a list this script saved or exported. Anything else, or a list it cannot vouch for, gives
# nothing: a list must name its account, say when it was saved, and hold a list of groups, each
# with a name and its transcripts, and, if it has pins, a list of them. A list saved before pins
# were kept gives Pinned as null, and its pins are left alone.
function Read-SidebarList([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { $record = ConvertFrom-JsJson (Read-TextFile $Path) } catch { return $null }
  if (-not ($record -is [System.Collections.IDictionary]) -or (Get-JsMember $record 'v') -ne 1) { return $null }
  $account = Get-JsMember $record 'accountUuid'
  if (-not ($account -is [string]) -or -not $account) { return $null }
  if (-not ((Get-JsMember $record 'groups') -is [System.Collections.IList])) { return $null }
  $savedUtc = $null
  try { $savedUtc = [DateTime]::Parse([string](Get-JsMember $record 'savedAt'), [Globalization.CultureInfo]::InvariantCulture, 'RoundtripKind').ToUniversalTime() } catch { return $null }
  $groups = New-Object System.Collections.Generic.List[object]
  foreach ($g in @(Get-JsList $record 'groups')) {
    $name = Get-JsMember $g 'name'
    if (-not ($name -is [string]) -or -not ((Get-JsMember $g 'transcripts') -is [System.Collections.IList])) { return $null }
    $groups.Add([pscustomobject]@{ Name = $name; Transcripts = [string[]]@(Get-JsList $g 'transcripts' | Where-Object { $_ -is [string] }) })
  }
  $pinned = $null
  if (Test-JsKey $record 'pinned') {
    if (-not ((Get-JsMember $record 'pinned') -is [System.Collections.IList])) { return $null }
    $pinned = [string[]]@(Get-JsList $record 'pinned' | Where-Object { $_ -is [string] })
  }
  [pscustomobject]@{
    SavedAt = $savedUtc.ToLocalTime().ToString('yyyy-MM-dd HH:mm'); SavedAtUtc = $savedUtc
    AccountUuid = $account; Org = [string](Get-JsMember $record 'organizationUuid')
    Groups = $groups.ToArray(); Pinned = $pinned
  }
}

# A state of the sidebar as the plan file holds it: each group's name and the entry ids filed
# in it, and the pinned entry ids. A part that is null is not planned and is left alone.
function ConvertTo-PlanState($Groups, $Pinned) {
  $state = New-JsObject
  if ($null -eq $Groups) { $state['groups'] = $null }
  else {
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($g in @($Groups)) {
      $item = New-JsObject
      $item['name'] = $g.Name
      $item['sessions'] = [object[]]@($g.Sessions)
      $list.Add($item)
    }
    $state['groups'] = $list.ToArray()
  }
  if ($null -eq $Pinned) { $state['pinned'] = $null } else { $state['pinned'] = [object[]]@($Pinned) }
  , $state
}

function ConvertFrom-PlanState($State) {
  $groups = $null
  $rawGroups = Get-JsMember $State 'groups'
  if ($rawGroups -is [System.Collections.IList]) {
    $groups = @(foreach ($g in $rawGroups) {
        [pscustomobject]@{ Name = [string](Get-JsMember $g 'name'); Sessions = [string[]]@(Get-JsList $g 'sessions' | Where-Object { $_ -is [string] }) }
      })
  }
  $pinned = $null
  $rawPinned = Get-JsMember $State 'pinned'
  if ($rawPinned -is [System.Collections.IList]) { $pinned = [string[]]@($rawPinned | Where-Object { $_ -is [string] }) }
  [pscustomobject]@{ Groups = $groups; Pinned = $pinned }
}

function Read-SidebarPlan {
  if (-not (Test-Path -LiteralPath $planFile)) { return $null }
  try { $plan = ConvertFrom-JsJson (Read-TextFile $planFile) } catch { return $null }
  if (-not ($plan -is [System.Collections.IDictionary]) -or (Get-JsMember $plan 'v') -ne 1) { return $null }
  , $plan
}

function Save-SidebarPlan($Plan) {
  if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
  [System.IO.File]::WriteAllText($planFile, (ConvertTo-JsJson $Plan -Indent 2), $utf8)
}

# What the app's sidebar tools still have to do so that the signed-in account's groups and pins
# match a target state: groups to create, chats to file or take out of a group, groups to
# delete, chats to pin or unpin, in the order to make them. A chat created after the plan was
# made is left as it is, and so is a chat the tools refuse (an archived chat, a routine's run).
# Filing a pinned chat in a group unpins it, so every pin comes after the moves.
function Get-SidebarCalls($Target, $Now, $Entries, [long]$MadeMs) {
  $calls = New-Object System.Collections.Generic.List[object]
  $notes = New-Object System.Collections.Generic.List[string]
  $result = [pscustomobject]@{ Calls = $calls; Notes = $notes; Blocked = $null }
  $canChange = {
    param([string]$id)
    $e = $null
    if (-not $Entries.ById.TryGetValue($id, [ref]$e)) { return $false }
    return (-not $e.Archived -and -not $e.Routine)
  }
  $isNewer = {
    param([string]$id)
    $e = $null
    if (-not $Entries.ById.TryGetValue($id, [ref]$e)) { return $false }
    return ($null -ne $e.CreatedMs -and $e.CreatedMs -gt $MadeMs)
  }
  $movedIn = New-Object 'System.Collections.Generic.HashSet[string]'
  if ($null -ne $Target.Groups) {
    $nowByName = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    $groupOf = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    foreach ($g in @($Now.Groups)) {
      if ($nowByName.ContainsKey($g.Name)) { $result.Blocked = ('two of this account''s groups are named "{0}"; rename or delete one of them in the app first' -f $g.Name); return $result }
      $nowByName[$g.Name] = $g
      foreach ($id in $g.Sessions) { $groupOf[$id] = $g.Name }
    }
    $targetOf = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    foreach ($g in @($Target.Groups)) {
      foreach ($other in @($Target.Groups)) {
        if (-not [object]::ReferenceEquals($g, $other) -and ($g.Name -ceq $other.Name)) { $result.Blocked = ('the plan names the group "{0}" twice' -f $g.Name); return $result }
      }
      foreach ($id in $g.Sessions) { $targetOf[$id] = $g.Name }
    }
    foreach ($g in @($Target.Groups)) {
      $need = New-Object System.Collections.Generic.List[string]
      foreach ($id in $g.Sessions) {
        if (-not (& $canChange $id)) { continue }
        $at = $null
        if ($groupOf.TryGetValue($id, [ref]$at) -and ($at -ceq $g.Name)) { continue }
        if ($targetOf[$id] -cne $g.Name) { continue }
        $need.Add($id)
      }
      if ($need.Count -eq 0) { continue }
      if (-not $nowByName.ContainsKey($g.Name)) { $calls.Add([pscustomobject]@{ Tool = 'create_group'; Group = $g.Name; Sessions = @(); Session = $null; Pinned = $null }) }
      for ($i = 0; $i -lt $need.Count; $i += 100) {
        $chunk = $need.GetRange($i, [Math]::Min(100, $need.Count - $i)).ToArray()
        $calls.Add([pscustomobject]@{ Tool = 'move_sessions'; Group = $g.Name; Sessions = $chunk; Session = $null; Pinned = $null })
        foreach ($id in $chunk) { [void]$movedIn.Add($id) }
      }
    }
    $leave = New-Object System.Collections.Generic.List[string]
    $staying = New-Object 'System.Collections.Generic.Dictionary[string,int]'
    $newer = 0
    foreach ($g in @($Now.Groups)) {
      $staying[$g.Name] = 0
      foreach ($id in $g.Sessions) {
        $to = $null
        if ($targetOf.TryGetValue($id, [ref]$to)) {
          if (($to -ceq $g.Name) -or -not (& $canChange $id)) { $staying[$g.Name] = $staying[$g.Name] + 1 }
          continue
        }
        if (-not $Entries.ById.ContainsKey($id)) { continue }
        if (-not (& $canChange $id)) { $staying[$g.Name] = $staying[$g.Name] + 1; continue }
        if (& $isNewer $id) { $newer++; $staying[$g.Name] = $staying[$g.Name] + 1; continue }
        $leave.Add($id)
      }
    }
    for ($i = 0; $i -lt $leave.Count; $i += 100) {
      $chunk = $leave.GetRange($i, [Math]::Min(100, $leave.Count - $i)).ToArray()
      $calls.Add([pscustomobject]@{ Tool = 'move_sessions'; Group = $null; Sessions = $chunk; Session = $null; Pinned = $null })
    }
    $targetNames = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($g in @($Target.Groups)) { [void]$targetNames.Add($g.Name) }
    foreach ($g in @($Now.Groups)) {
      if ($targetNames.Contains($g.Name)) { continue }
      if ($staying[$g.Name] -gt 0) { $notes.Add(('The group "{0}" is not in the plan, but {1} of its chats are left as they are, so it is kept.' -f $g.Name, $staying[$g.Name])); continue }
      $calls.Add([pscustomobject]@{ Tool = 'delete_group'; Group = $g.Name; Sessions = @(); Session = $null; Pinned = $null })
    }
    if ($newer -gt 0) { $notes.Add(('{0} grouped chat(s) were created after the plan was made and are left where they are.' -f $newer)) }
  }
  if ($null -ne $Target.Pinned) {
    $want = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($id in @($Target.Pinned)) {
      [void]$want.Add($id)
      if (-not (& $canChange $id)) { continue }
      if (-not $Now.Pinned.Contains($id) -or $movedIn.Contains($id)) { $calls.Add([pscustomobject]@{ Tool = 'set_pinned'; Group = $null; Sessions = @(); Session = $id; Pinned = $true }) }
    }
    foreach ($id in @($Now.Pinned)) {
      if ($want.Contains($id) -or $movedIn.Contains($id) -or -not (& $canChange $id) -or (& $isNewer $id)) { continue }
      $calls.Add([pscustomobject]@{ Tool = 'set_pinned'; Group = $null; Sessions = @(); Session = $id; Pinned = $false })
    }
  }
  $result
}

# Prints the calls, one per line, as the name of a sidebar tool and its input, and returns them
# as records for the calls file.
function Write-SidebarCalls($Calls, $Entries) {
  $records = New-Object System.Collections.Generic.List[object]
  $n = 0
  foreach ($call in $Calls) {
    $n++
    $arguments = New-JsObject
    $about = ''
    if ($call.Tool -eq 'create_group') { $arguments['name'] = $call.Group }
    elseif ($call.Tool -eq 'delete_group') { $arguments['group'] = $call.Group }
    elseif ($call.Tool -eq 'move_sessions') {
      $arguments['group'] = $call.Group
      $arguments['session_ids'] = [object[]]@($call.Sessions)
      $count = @($call.Sessions).Count
      $about = ('   ({0} chat{1})' -f $count, $(if ($count -eq 1) { '' } else { 's' }))
    } else {
      $arguments['session_id'] = $call.Session
      $arguments['pinned'] = [bool]$call.Pinned
      $e = $null
      if ($Entries.ById.TryGetValue([string]$call.Session, [ref]$e) -and $e.Title) { $about = '   "' + $e.Title + '"' }
    }
    Write-Host ('{0,3}. {1} {2}{3}' -f $n, $call.Tool, (ConvertTo-JsJson $arguments), $about)
    $record = New-JsObject
    $record['tool'] = $call.Tool
    $record['arguments'] = $arguments
    $records.Add($record)
  }
  , $records.ToArray()
}

function Save-SidebarCalls([string]$Run, [string]$Aim, $Records) {
  $file = New-JsObject
  $file['v'] = 1
  $file['run'] = $Run
  $file['aim'] = $Aim
  $file['listedAt'] = [DateTime]::UtcNow.ToString('o')
  $file['calls'] = [object[]]@($Records)
  if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
  [System.IO.File]::WriteAllText($callsFile, (ConvertTo-JsJson $file -Indent 2), $utf8)
}

$sidebarLegend = @(
  '  "group" is a group''s name: pass the id list_groups gives for that name. null means Ungrouped (group_id null).',
  '  create_group: skip it when list_groups already shows a group with exactly that name.',
  '  delete_group: its chats are already out of it by then; deleting a group never deletes a chat.'
)

# --- locate the packaged app store (derive the package suffix; never hardcode it) ---
$packageFolder = Get-ChildItem (Join-Path $UserProfile 'AppData\Local\Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude-code-sessions') } |
  Select-Object -First 1
if (-not $packageFolder) { Write-Host 'Could not locate the Claude package store (AppData\Local\Packages\Claude_*\LocalCache\Roaming\Claude). Is the desktop app installed?'; return }
$pkgRoot      = Join-Path $packageFolder.FullName 'LocalCache\Roaming\Claude'
$sessionsRoot = Join-Path $pkgRoot 'claude-code-sessions'
$configPath   = Join-Path $pkgRoot 'config.json'
$prefsPath    = Join-Path $pkgRoot 'claude_desktop_config.json'
$leveldbDir   = Join-Path $pkgRoot 'Local Storage\leveldb'

$userConfig = Get-UserConfig

# --- current account (auto-detected from the app's own config) ---
$acct = $null
if (Test-Path $configPath) { try { $acct = [string](Get-JsMember (ConvertFrom-JsJson (Read-TextFile $configPath)) 'lastKnownAccountUuid') } catch {} }
if (-not $acct) { $acct = (Get-ChildItem $sessionsRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name }
$acctDir = Join-Path $sessionsRoot $acct
if (-not (Test-Path $acctDir)) { Write-Host "Account folder not found for $acct"; return }

$codeAccount = Read-CodeAccountFile (Join-Path $UserProfile '.claude.json')

# --- -Sidebar: with the app open, what its sidebar tools still have to do. It reads plain files
# only: the plan, the app's settings file and this account's chat entries ---
if ($Sidebar) {
  Write-Host "Account : $acct"
  $known = Get-KnownAccounts
  $plan = Read-SidebarPlan
  $receiving = Get-JsMember $plan 'receiving'
  $forThis = ($plan -and ([string](Get-JsMember $receiving 'accountUuid') -eq $acct))
  $org = $null
  if ($forThis) {
    $org = [string](Get-JsMember $receiving 'organizationUuid')
    if (-not $org -or -not (Test-Path -LiteralPath (Join-Path $acctDir $org))) { Write-Host "Nothing listed: the saved plan names an org folder this account does not have ($org)."; return }
  } else {
    $orgChoice = Resolve-CurrentOrg $acctDir $acct $null $codeAccount
    if (-not $orgChoice) { Write-Host "No org folder under account $acct"; return }
    $org = $orgChoice.Org
  }
  $orgDir = Join-Path $acctDir $org
  $entries = Get-AccountEntries $orgDir
  $now = Get-SidebarNow $prefsPath "$acct/$org" $entries
  # this account's list of groups is saved first, and what was saved is said last, whatever
  # else this step prints
  $listSave = Save-SidebarList $acct $org $entries $now
  $hereLabel = ($known.Values | Where-Object { $_.AccountUuid -eq $acct } | Select-Object -First 1).Email
  if (-not $hereLabel) { $hereLabel = $acct }
  $configured = Resolve-SourceAccount $userConfig.CopyGroupsFrom $known $sessionsRoot
  $isTemplate = [bool]($configured -and ($configured.AccountUuid -eq $acct))
  try {
    if ($now.Problem) { Write-Host ("Nothing listed: {0}." -f $now.Problem); return }
    Write-Host ('Groups here now: {0}.' -f (Get-SidebarSummary $now.Groups $now.Pinned.Count))
    if (-not $plan) {
      Write-Host 'No sidebar plan is saved, so there is nothing to apply. A plan is made by running this script without -Sidebar after an account switch, with copyGroupsFromEmail set in session-restore.config.json.'
      return
    }
    $run = [string](Get-JsMember $plan 'run')
    if (-not $forThis) { Write-Host ("The saved sidebar plan (run {0}) was made for another account, not the one signed in. Nothing to apply here." -f $run); return }

    $planAim = [string](Get-JsMember $plan 'aim')
    if ($planAim -ne 'before') { $planAim = 'desired' }
    $aim = $planAim
    if ($Back) { $aim = 'before' }
    $madeMs = [long]0
    $made = Get-JsMember $plan 'madeAtMs'
    if ($made -is [int] -or $made -is [long]) { $madeMs = [long]$made }
    $madeText = [DateTimeOffset]::FromUnixTimeMilliseconds($madeMs).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
    $planSource = Get-JsMember $plan 'source'
    $sourceId = [string](Get-JsMember $planSource 'accountUuid')
    $label = ($known.Values | Where-Object { $_.AccountUuid -eq $sourceId } | Select-Object -First 1).Email
    if (-not $label) { $label = $sourceId }
    # a plan made from an imported file copies the sidebar as it was when the file was saved, so
    # chats created after that are the ones left as they are
    $stateMs = $madeMs
    $stateAt = Get-JsMember $planSource 'stateAtMs'
    if ($stateAt -is [int] -or $stateAt -is [long]) { $stateMs = [long]$stateAt }
    $importedFrom = [string](Get-JsMember $planSource 'importedFrom')
    if ($aim -eq 'before') { Write-Host ("Sidebar plan of run {0}, made {1}: aiming at the groups and pins as they were before that run." -f $run, $madeText) }
    elseif ($importedFrom) { Write-Host ("Sidebar plan of run {0}, made {1}: the groups and pins in {2}, saved {3} under {4}." -f $run, $madeText, $importedFrom, [DateTimeOffset]::FromUnixTimeMilliseconds($stateMs).LocalDateTime.ToString('yyyy-MM-dd HH:mm'), $label) }
    else { Write-Host ("Sidebar plan of run {0}, made {1}: the groups and pins of {2}." -f $run, $madeText, $label) }

    $target = ConvertFrom-PlanState (Get-JsMember $plan $aim)
    $diff = Get-SidebarCalls $target $now $entries $stateMs
    if ($diff.Blocked) { Write-Host ("Nothing listed: {0}." -f $diff.Blocked); return }
    foreach ($note in $diff.Notes) { Write-Host $note }
    $applied = [string](Get-JsMember $plan 'appliedAt')
    if ($diff.Calls.Count -eq 0) {
      Write-Host 'The sidebar matches the plan. Nothing is left to do.'
      Write-Host 'To confirm with the app itself, call list_groups: it shows the groups and counts given above, and also any group that holds no chat.'
      Save-SidebarCalls $run $aim @()
      if (($aim -eq $planAim) -and -not $applied) {
        $plan['appliedAt'] = [DateTime]::UtcNow.ToString('o')
        Save-SidebarPlan $plan
      }
      return
    }
    if ($applied -and ($aim -eq $planAim)) {
      $appliedText = $applied
      try { $appliedText = [DateTime]::Parse($applied, [Globalization.CultureInfo]::InvariantCulture, 'RoundtripKind').ToLocalTime().ToString('yyyy-MM-dd HH:mm') } catch { }
      Write-Host ("This plan was applied in full on {0}. The sidebar has changed since, as it does when chats are filed or pinned afterwards. Make the calls below only to go back to the plan." -f $appliedText)
    }
    Write-Host ("{0} call(s) left for the app's sidebar tools (mcp__ccd_sidebar__*). Make them in this order:" -f $diff.Calls.Count)
    foreach ($line in $sidebarLegend) { Write-Host $line }
    $records = Write-SidebarCalls $diff.Calls $entries
    Save-SidebarCalls $run $aim $records
    Write-Host "The same calls, as JSON: $callsFile"
    Write-Host 'Then run this command again: it lists what is still left, or says the sidebar matches the plan.'
    return
  } finally {
    Write-SidebarListSave $listSave $hereLabel $isTemplate
  }
}

# --- -Export / -ExportTo: the signed-in account's groups and pinned chats, as the app's settings
# file holds them now, written to a file of their own. It reads plain files only, and it never
# replaces a file ---
if ($exportStep) {
  Write-Host "Account : $acct"
  $known = Get-KnownAccounts
  $orgChoice = Resolve-CurrentOrg $acctDir $acct $null $codeAccount
  if (-not $orgChoice) { Write-Host "No org folder under account $acct"; return }
  $org = $orgChoice.Org
  $entries = Get-AccountEntries (Join-Path $acctDir $org)
  $now = Get-SidebarNow $prefsPath "$acct/$org" $entries
  $hereLabel = ($known.Values | Where-Object { $_.AccountUuid -eq $acct } | Select-Object -First 1).Email
  if (-not $hereLabel) { $hereLabel = $acct }
  if ($ExportTo) {
    $exportFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ExportTo)
    $exportFolder = Split-Path -Parent $exportFile
    if (-not $exportFolder -or -not (Test-Path -LiteralPath $exportFolder -PathType Container)) { Write-Host ("NOT exported: the folder {0} does not exist." -f $exportFolder); return }
  } else {
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    $safeLabel = -join @($hereLabel.ToCharArray() | ForEach-Object { if ($invalid -contains $_) { '_' } else { [string]$_ } })
    $exportFile = Join-Path $exportsDir ('groups-' + $safeLabel + '-' + $stamp + '.json')
  }
  $exported = Write-SidebarList $exportFile $acct $org $entries $now $true
  if (-not $exported.Saved) {
    $after = ''
    if ($exported.Replaced) { $after = (' The file {0} may not hold the right list.' -f $exportFile) }
    Write-Host ('NOT exported: {0}.{1}' -f $exported.Problem, $after)
    return
  }
  Write-Host ('Exported: the groups and pins of {0}: {1}, to {2}. Read back, the file holds exactly these.' -f $hereLabel, (Format-SidebarListContent $exported.Groups $exported.Pinned), $exportFile)
  if ($exported.Unnamed -gt 0) { Write-Host ('  {0} chat(s) filed in a group or pinned here have no chat entry with a transcript, so the file cannot name them.' -f $exported.Unnamed) }
  Write-Host 'To bring them back, under this account or another one, import the file:'
  Write-Host ('  powershell -ExecutionPolicy Bypass -File "{0}" -Import "{1}"' -f $PSCommandPath, $exportFile)
  return
}

# --- -Import: a plan for the signed-in account made from a list this script saved or exported:
# its groups and pinned chats become the file's, chat for chat, matched by transcript; chats
# created after the file was saved are left as they are. Like the plan of a run, a Claude
# session applies it with -Sidebar. It reads plain files only, and writes only the plan ---
if ($importStep) {
  Write-Host "Account : $acct"
  $known = Get-KnownAccounts
  $importFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Import)
  if (-not (Test-Path -LiteralPath $importFile -PathType Leaf)) { Write-Host "NOT imported: there is no file $importFile."; return }
  $list = Read-SidebarList $importFile
  if (-not $list) { Write-Host "NOT imported: $importFile is not a list of groups and pins that this script saved or exported."; return }
  $seenNames = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($g in $list.Groups) {
    if (-not $seenNames.Add($g.Name)) { Write-Host ('NOT imported: the file names the group "{0}" twice, so its chats cannot be filed by group name.' -f $g.Name); return }
  }
  $orgChoice = Resolve-CurrentOrg $acctDir $acct $null $codeAccount
  if (-not $orgChoice) { Write-Host "No org folder under account $acct"; return }
  $org = $orgChoice.Org
  $entries = Get-AccountEntries (Join-Path $acctDir $org)
  $now = Get-SidebarNow $prefsPath "$acct/$org" $entries
  if ($now.Problem) { Write-Host ("Nothing planned: {0}." -f $now.Problem); return }
  $fromLabel = ($known.Values | Where-Object { $_.AccountUuid -eq $list.AccountUuid } | Select-Object -First 1).Email
  if (-not $fromLabel) { $fromLabel = $list.AccountUuid }
  Write-Host ('Importing {0}: the groups and pins of {1}, saved {2}: {3}.' -f $importFile, $fromLabel, $list.SavedAt, (Format-SidebarListContent $list.Groups $list.Pinned))
  $usable = { param($e) -not $e.Archived -and -not $e.Routine }

  # groups: each of the file's groups, by this account's entries for its transcripts. A group none
  # of whose chats can be filed here is left out; when every group is left out, the groups here are
  # left alone, since that is no sign that the file holds none
  $stats = @{ NoEntryHere = 0; CannotFile = 0; LeftOut = 0 }
  $found = New-Object System.Collections.Generic.List[object]
  foreach ($g in $list.Groups) {
    $sessions = New-Object System.Collections.Generic.List[string]
    foreach ($t in $g.Transcripts) {
      $ids = $null
      if ($entries.ByTranscript.TryGetValue($t, [ref]$ids)) {
        foreach ($id in $ids) { if (& $usable $entries.ById[$id]) { if (-not $sessions.Contains($id)) { $sessions.Add($id) } } else { $stats.CannotFile++ } }
      } else { $stats.NoEntryHere++ }
    }
    if ($sessions.Count -gt 0) { $found.Add([pscustomobject]@{ Name = $g.Name; Sessions = $sessions.ToArray() }) } else { $stats.LeftOut++ }
  }
  # (an array from here on: Windows PowerShell 5.1 cannot wrap a list of objects in @(...))
  $importGroups = $found.ToArray()
  $groupsPlanned = -not ($importGroups.Count -eq 0 -and @($list.Groups).Count -gt 0)
  if ($groupsPlanned) {
    $groupsText = 'none'
    if ($importGroups.Count -gt 0) { $groupsText = (@($importGroups) | ForEach-Object { '"{0}" ({1})' -f $_.Name, @($_.Sessions).Count }) -join ', ' }
    Write-Host ("Groups to reach here: {0}" -f $groupsText)
    if (@($list.Groups).Count -eq 0) { Write-Host '  The file holds no group: applying this plan takes the chats here out of their groups, except chats created after the file was saved, and deletes the groups left empty.' }
  } else {
    Write-Host 'Groups: not planned. None of the groups in the file holds a chat that can be filed here.'
  }
  if ($stats.NoEntryHere) { Write-Host ("  {0} chat(s) in the file's groups have no chat entry here, so they cannot be filed." -f $stats.NoEntryHere) }
  if ($stats.CannotFile) { Write-Host ("  {0} chat(s) in the file's groups are archived here or are a routine's run, which the app's sidebar tools do not file." -f $stats.CannotFile) }
  if ($stats.LeftOut -and $groupsPlanned) { Write-Host ("  {0} group(s) in the file hold no chat that can be filed here and are left out." -f $stats.LeftOut) }

  # pins: the entries here for the file's pinned chats. A list saved before pins were kept holds
  # none, and then the pins here are left alone
  $importPinned = $null
  if ($null -ne $list.Pinned) {
    $pins = New-Object System.Collections.Generic.List[string]
    $pinStats = @{ NoEntryHere = 0; CannotPin = 0 }
    foreach ($t in $list.Pinned) {
      $ids = $null
      if ($entries.ByTranscript.TryGetValue($t, [ref]$ids)) {
        foreach ($id in $ids) { if (& $usable $entries.ById[$id]) { if (-not $pins.Contains($id)) { $pins.Add($id) } } else { $pinStats.CannotPin++ } }
      } else { $pinStats.NoEntryHere++ }
    }
    $importPinned = $pins.ToArray()
    Write-Host ("Pins to reach here: {0}" -f @($importPinned).Count)
    if ($pinStats.NoEntryHere) { Write-Host ("  {0} pinned chat(s) in the file have no chat entry here, so they cannot be pinned." -f $pinStats.NoEntryHere) }
    if ($pinStats.CannotPin) { Write-Host ("  {0} pinned chat(s) in the file are archived here or are a routine's run, which the app's sidebar tools do not pin." -f $pinStats.CannotPin) }
  } else {
    Write-Host 'Pins: not planned. The file was saved before lists kept pins, so the pins here are left as they are.'
  }
  if (-not $groupsPlanned -and $null -eq $importPinned) { Write-Host 'Nothing planned: the file gives neither groups nor pins that can be applied here.'; return }

  # the plan: chats created after the file was saved are left as they are
  $madeMs = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $stateMs = (New-Object DateTimeOffset($list.SavedAtUtc)).ToUnixTimeMilliseconds()
  if ($stateMs -gt $madeMs) { $stateMs = $madeMs }
  # (assigned, not returned from $(...): an empty list has to stay a list, not turn into nothing)
  $plannedGroups = $null
  $beforeGroups = $null
  if ($groupsPlanned) { $plannedGroups = $importGroups; $beforeGroups = @($now.Groups) }
  $beforePinned = $null
  if ($null -ne $importPinned) { $beforePinned = $now.PinnedOrder.ToArray() }
  $desired = ConvertTo-PlanState $plannedGroups $importPinned
  $before = ConvertTo-PlanState $beforeGroups $beforePinned
  $diff = Get-SidebarCalls (ConvertFrom-PlanState $desired) $now $entries $stateMs
  if ($diff.Blocked) { Write-Host ("Nothing planned, because {0}." -f $diff.Blocked); return }
  foreach ($note in $diff.Notes) { Write-Host $note }
  $deletes = @($diff.Calls | Where-Object { $_.Tool -eq 'delete_group' })
  if ($deletes.Count -gt 0) { Write-Host ("Groups here that the file does not have, to delete once their chats are out of them: {0}" -f ((@($deletes) | ForEach-Object { '"' + $_.Group + '"' }) -join ', ')) }
  $plan = New-JsObject
  $plan['v'] = 1
  $plan['run'] = $stamp
  $plan['madeAtMs'] = $madeMs
  $plan['madeAt'] = [DateTimeOffset]::FromUnixTimeMilliseconds($madeMs).UtcDateTime.ToString('o')
  $plan['receiving'] = New-JsObject
  $plan['receiving']['accountUuid'] = $acct
  $plan['receiving']['organizationUuid'] = $org
  $plan['source'] = New-JsObject
  $plan['source']['accountUuid'] = $list.AccountUuid
  $plan['source']['organizationUuid'] = $list.Org
  $plan['source']['groupsReadFrom'] = ('the file {0}, saved {1}' -f $importFile, $list.SavedAt)
  $plan['source']['importedFrom'] = $importFile
  $plan['source']['stateAtMs'] = $stateMs
  $plan['aim'] = 'desired'
  $plan['desired'] = $desired
  $plan['before'] = $before
  Save-SidebarPlan $plan
  Write-Host "Sidebar plan saved: $planFile"
  if ($diff.Calls.Count -eq 0) {
    Write-Host "Groups and pins: already as in the file. Nothing is left for the app's sidebar tools to do."
  } else {
    Write-Host ("Groups and pins: {0} call(s) are left for the app's own sidebar tools, which only a Claude session in the app can make. With Claude open, give any session this line:" -f $diff.Calls.Count)
    Write-Host ('  Apply my sidebar plan: run  powershell -NoProfile -ExecutionPolicy Bypass -File "{0}" -Sidebar  and make the calls it lists with your sidebar tools, in order. Then run it again, until it says the sidebar matches the plan.' -f $PSCommandPath)
  }
  return
}

# --- the sidebar's own storage, read through a private copy ---
$sidebarStore = $null
if (Test-Path -LiteralPath $leveldbDir) {
  try { $sidebarStore = Read-SidebarStorage $leveldbDir }
  catch { Write-Host ("Could not read the app's browser storage: {0}" -f $_.Exception.Message) }
}

# --- current org folder under that account ---
$storeObject = $null
if ($sidebarStore) { $storeObject = $sidebarStore.Store }
$orgChoice = Resolve-CurrentOrg $acctDir $acct $storeObject $codeAccount
if (-not $orgChoice) { Write-Host "No org folder under account $acct"; return }
$org = $orgChoice.Org
$orgDir = Join-Path $acctDir $org
Write-Host "Account : $acct"
Write-Host ("Org dir : {0}  (from {1})" -f $orgDir, $orgChoice.Source)

$known = Get-KnownAccounts
$currentEmail = ($known.Values | Where-Object { $_.AccountUuid -eq $acct } | Select-Object -First 1).Email
if ($currentEmail) { Write-Host "Signed in as: $currentEmail" }

# --- Undo mode: reverse the newest not-yet-undone run (legacy manifest = oldest step) ---
if ($Undo) {
  $stamps = New-Object 'System.Collections.Generic.SortedSet[string]'
  Get-ChildItem $scriptDir -Filter 'created-entries-*.txt' -File | ForEach-Object { if ($_.BaseName -match '^created-entries-(\d{8}-\d{6})$') { [void]$stamps.Add($Matches[1]) } }
  if (Test-Path -LiteralPath $backupsRoot) { Get-ChildItem -LiteralPath $backupsRoot -Directory | ForEach-Object { if ($_.Name -match '^\d{8}-\d{6}$') { [void]$stamps.Add($_.Name) } } }
  $plan = Read-SidebarPlan
  $planRun = [string](Get-JsMember $plan 'run')
  if ($plan -and ($planRun -match '^\d{8}-\d{6}$') -and ([string](Get-JsMember $plan 'aim') -ne 'before')) { [void]$stamps.Add($planRun) }
  if ($stamps.Count -eq 0 -and -not (Test-Path $legacyManifest)) { Write-Host 'No manifest found; nothing to undo.'; return }
  $newest = $null
  if ($stamps.Count -eq 0) {
    $manifest = Get-Item $legacyManifest
    $runBackup = $null
  } else {
    $newest = $stamps.Max
    $manifest = Get-Item -LiteralPath (Join-Path $scriptDir "created-entries-$newest.txt") -ErrorAction SilentlyContinue
    $runBackup = Join-Path $backupsRoot $newest
    if (-not (Test-Path -LiteralPath $runBackup)) { $runBackup = $null }
  }
  if ($runBackup) {
    $record = ConvertFrom-JsJson (Read-TextFile (Join-Path $runBackup 'backup.json'))
    if (@(Get-JsList $record 'entries').Count -gt 0) {
      $activity = Get-AppActivity $packageFolder.Name @($leveldbDir)
      if ($activity.Count -gt 0) { Write-Host ("Claude is still running ({0}). Quit it fully, including from the system tray, then run -Undo again. Nothing was changed." -f ($activity -join '; ')); return }
    }
    Restore-RunFiles $runBackup
    Remove-Item -LiteralPath $runBackup -Recurse -Force
    Write-Host ("Put back every file run {0} changed (chat entries it moved to another folder, and the config file if it filled it in) exactly as it was before." -f (Split-Path -Leaf $runBackup))
  }
  if ($manifest) {
    $removed = 0
    Get-Content $manifest.FullName | ForEach-Object { if ($_ -and (Test-Path -LiteralPath $_)) { Remove-Item -LiteralPath $_; $removed++ } }
    Remove-Item -LiteralPath $manifest.FullName
    Write-Host ("Removed {0} entries from manifest {1} (manifest retired; run -Undo again to walk further back)." -f $removed, $manifest.Name)
  }
  if ($plan -and $newest -and ($planRun -eq $newest)) {
    $plan['aim'] = 'before'
    [void]$plan.Remove('appliedAt')
    Save-SidebarPlan $plan
    Write-Host "Groups and pins: what a session already filed or pinned from this run's plan stays as it is in the app. The plan now aims at the groups and pins as they were before the run: to put them back, reopen Claude and have a session run this script with -Sidebar."
  }
  Write-Host ("Org dir now has {0} entries." -f (Get-ChildItem -LiteralPath $orgDir -Filter *.json -File).Count)
  Write-Host 'Reopen the Claude app to see the result.'
  return
}

# --- transcripts across every project folder ---
$projectsRoot = Join-Path $UserProfile '.claude\projects'
if (-not (Test-Path $projectsRoot)) { Write-Host "Transcripts root not found: $projectsRoot"; return }

# every account's sidebar entries, by the transcript each chat resumes
$allEntries = Get-EntriesByTranscript $sessionsRoot
$entriesByTranscript = $allEntries.ByTranscript
if ($allEntries.Unreadable.Count -gt 0) {
  Write-Host ("{0} sidebar entry file(s) could not be read and were left out:" -f $allEntries.Unreadable.Count)
  foreach ($path in $allEntries.Unreadable) { Write-Host "  $path" }
}

# chats already listed in this account/org (skip these)
$have = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($pair in $entriesByTranscript.GetEnumerator()) {
  foreach ($item in $pair.Value) { if ($item.Account -eq $acct -and $item.Org -eq $org) { [void]$have.Add($pair.Key) } }
}

# transcripts some entry, in any account, keeps as another part of its chat: never a chat of
# their own (skip these too)
$partOf = $allEntries.PartOf

# top-level session transcripts in each project subfolder (not subagent/workflow jsonl), by
# session: when a chat's entry names another working folder, the app copies the transcript into
# that folder's project folder, so one session can have more than one copy.
$copiesById = New-Object 'System.Collections.Generic.Dictionary[string,System.Collections.Generic.List[System.IO.FileInfo]]'
foreach ($projectDir in (Get-ChildItem -LiteralPath $projectsRoot -Directory)) {
  foreach ($file in (Get-ChildItem -LiteralPath $projectDir.FullName -Filter *.jsonl -File)) {
    if (-not $copiesById.ContainsKey($file.BaseName)) { $copiesById[$file.BaseName] = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]' }
    $copiesById[$file.BaseName].Add($file)
  }
}

# where new entries take their dates and folders from
$folderByProject = Get-FolderByProject $entriesByTranscript
$driveRoot = [System.IO.Path]::GetPathRoot($UserProfile)
$sourceAccount = Resolve-SourceAccount $userConfig.CopyGroupsFrom $known $sessionsRoot
$sourceAccountId = $null
if ($sourceAccount) { $sourceAccountId = $sourceAccount.AccountUuid }

# leading text that is injected/boilerplate, not the user's real first message
$skip = '^(?:' + ((@($builtInSkip) + @($userConfig.TitleSkipPrefixes) | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')'
$created = New-Object System.Collections.Generic.List[string]
$pendingTranscripts = New-Object 'System.Collections.Generic.HashSet[string]'
$tally = @{ twin = 0; custom = 0; ai = 0; user = 0; date = 0 }
$dateTally = @{ twin = 0; record = 0; file = 0 }
$folderTally = @{ twin = 0; stored = 0; record = 0; root = 0 }
$twinTally = @{ archived = 0; lineage = 0 }
$skippedParts = 0
$copyWarnings = New-Object System.Collections.Generic.List[string]
$samples = New-Object System.Collections.Generic.List[string]

# the LAST model the session logged (newer transcripts log it per assistant record;
# old-format transcripts never do -> $null -> caller falls back). Tail-read with an
# ADAPTIVE window: a single trailing record (giant tool result / snapshot) can exceed
# any fixed window - proven live 2026-07-18 on 9-14 MB transcripts whose 128 KB tails
# held zero model fields despite hundreds earlier in the file. Widen until a match or
# the whole file has been read.
function Get-TranscriptModel([string]$path) {
  try {
    $take = 262144
    for (;;) {
      $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
      try {
        $len = $fs.Length
        if ($take -gt $len) { $take = $len }
        [void]$fs.Seek($len - $take, 'Begin')
        $buf = New-Object byte[] $take
        [void]$fs.Read($buf, 0, $take)
        $text = [System.Text.Encoding]::UTF8.GetString($buf)
      } finally { $fs.Close() }
      $m = [regex]::Matches($text, '"model":"(claude-[a-z0-9.-]+)"')
      if ($m.Count -gt 0) { return $m[$m.Count - 1].Groups[1].Value }
      if ($take -ge $len) { return $null }   # whole file read, genuinely no model logged
      $take = $take * 4
    }
  } catch {}
  return $null
}

foreach ($cli in (@($copiesById.Keys) | Sort-Object)) {
  if ($have.Contains($cli)) { continue }
  if ($partOf.ContainsKey($cli)) { $skippedParts++; continue }
  try {
    $copies = $copiesById[$cli]
    $candidates = $null
    if ($entriesByTranscript.ContainsKey($cli)) { $candidates = $entriesByTranscript[$cli] }
    $twin = Select-Twin $candidates $acct $sourceAccountId

    # the folder: the twin's, when it exists and holds the transcript (else chosen below, once the
    # transcript is read); an entry naming a folder without it makes the app copy it there
    $folder = $null; $originFolder = $null; $folderSrc = $null; $t = $null
    if ($twin) {
      $twinCwd = Get-JsMember $twin.Entry 'cwd'
      if ($twinCwd -is [string] -and $twinCwd -and (Test-Path -LiteralPath $twinCwd -PathType Container)) {
        $project = Get-ProjectFolderName $twinCwd
        $inTwinFolder = @($copies | Where-Object { $_.Directory.Name -ieq $project })
        if ($inTwinFolder.Count -gt 0) {
          $t = $inTwinFolder[0]
          $folder = $twinCwd; $originFolder = $twinCwd; $folderSrc = 'twin'
          $twinOrigin = Get-JsMember $twin.Entry 'originCwd'
          if ($twinOrigin -is [string] -and $twinOrigin -and (Test-Path -LiteralPath $twinOrigin -PathType Container)) { $originFolder = $twinOrigin }
        }
      }
    }
    if (-not $t) { $t = Select-TranscriptCopy $copies $folderByProject }
    $firstCopy = @($copies | Sort-Object CreationTimeUtc)[0]

    $customTitle = $null; $aiTitle = $null; $userText = $null; $recordedCwd = $null
    foreach ($line in (Read-TranscriptHeadLines $t.FullName 250)) {
      if ($line.Length -lt 2) { continue }
      try { $o = $line | ConvertFrom-Json } catch { continue }
      if (-not $recordedCwd -and $o.cwd) { $recordedCwd = [string]$o.cwd }
      if ($o.type -eq 'custom-title' -and $o.customTitle) { $customTitle = [string]$o.customTitle; continue }   # last seen wins; keep scanning
      if ($o.type -eq 'ai-title' -and $o.aiTitle) { $aiTitle = [string]$o.aiTitle; continue }                   # last seen wins
      if (-not $userText -and $o.type -eq 'user' -and $o.message) {
        $c = $o.message.content
        $cands = @()
        if ($c -is [string]) { $cands = @($c) }
        elseif ($c) { foreach ($blk in $c) { if ($blk.type -eq 'text' -and $blk.text) { $cands += [string]$blk.text } } }
        foreach ($cand in $cands) {   # every text block gets a chance; first PASSING block wins
          $cand = $cand.Trim()
          if ($cand -and $cand -notmatch $skip -and $cand -notmatch 'system-reminder') { $userText = $cand; break }
        }
      }
    }
    if (-not $folder) {
      if ($folderByProject.ContainsKey($t.Directory.Name)) { $folder = $folderByProject[$t.Directory.Name]; $folderSrc = 'stored' }
      elseif ($recordedCwd -and (Test-Path -LiteralPath $recordedCwd -PathType Container)) { $folder = $recordedCwd; $folderSrc = 'record' }
      else { $folder = $driveRoot; $folderSrc = 'root' }
      $originFolder = $folder
    }
    if ($customTitle) { $title = $customTitle; $src = 'custom' }
    elseif ($aiTitle) { $title = $aiTitle; $src = 'ai' }
    elseif ($userText) { $title = $userText; $src = 'user' }
    else { $title = 'Chat ' + $firstCopy.CreationTime.ToString('yyyy-MM-dd'); $src = 'date' }
    $title = ($title -replace '\s+',' ').Trim()
    if ($title.Length -gt 100) { $title = $title.Substring(0,100) }
    if (-not $title) { $title = 'Chat ' + $firstCopy.CreationTime.ToString('yyyy-MM-dd'); $src = 'date' }

    $model = Get-TranscriptModel $t.FullName
    if (-not $model) { $model = $fallbackModel }
    $effort = 'high'; $titleSource = 'auto'

    # what the chat is in its twin's account, it is here: its title, model and effort, whether it
    # is archived, and its earlier transcripts, which get no entry of their own
    $archived = $false; $lineageJson = ''
    if ($twin) {
      $value = Get-JsMember $twin.Entry 'title'
      if ($value -is [string] -and $value) {
        $title = $value; $src = 'twin'
        $value = Get-JsMember $twin.Entry 'titleSource'
        if ($value -is [string] -and $value) { $titleSource = $value }
      }
      $value = Get-JsMember $twin.Entry 'model'
      if ($value -is [string] -and $value) { $model = $value }
      $value = Get-JsMember $twin.Entry 'effort'
      if ($value -is [string] -and $value) { $effort = $value }
      $value = Get-JsMember $twin.Entry 'isArchived'
      $archived = ($value -is [bool] -and $value)
      foreach ($name in @('priorCliSessionIds', 'preClearCliSessionId', 'rewindEdges', 'transcriptModelStates')) {
        if (Test-JsKey $twin.Entry $name) { $lineageJson += ',' + (ConvertTo-JsJson $name) + ':' + (ConvertTo-JsJson $twin.Entry[$name]) }
      }
      foreach ($part in (Get-EntryTranscripts $twin.Entry).Others) {
        if ($have.Contains($part)) { $copyWarnings.Add(('"{0}": this account already lists another transcript of this chat as a chat of its own; that entry is left as it is.' -f $title)) }
      }
    }

    # the dates: the twin's; else the transcript file's creation and its last record's time
    $createdMs = $null; $activityMs = $null; $focusedMs = $null; $dateSrc = $null
    if ($twin) {
      $createdMs = Get-EntryTimeMs $twin.Entry 'createdAt'
      $activityMs = Get-EntryTimeMs $twin.Entry 'lastActivityAt'
      $focusedMs = Get-EntryTimeMs $twin.Entry 'lastFocusedAt'
      if ($null -eq $focusedMs) { $focusedMs = $activityMs }
      if ($null -ne $createdMs -and $null -ne $activityMs) { $dateSrc = 'twin' }
    }
    if (-not $dateSrc) {
      $createdMs = [DateTimeOffset]::new($firstCopy.CreationTimeUtc).ToUnixTimeMilliseconds()
      $activityMs = Get-TranscriptLastRecordMs $t.FullName
      $dateSrc = 'record'
      if ($null -eq $activityMs) { $activityMs = [DateTimeOffset]::new($t.LastWriteTimeUtc).ToUnixTimeMilliseconds(); $dateSrc = 'file' }
      $focusedMs = $activityMs
    }

    if ($copies.Count -gt 1) {
      foreach ($other in $copies) {
        if ($other.FullName -eq $t.FullName) { continue }
        if (Test-TranscriptAhead $t.FullName $other.FullName) {
          $copyWarnings.Add(('"{0}": its transcript copy in {1} holds messages the copy in {2} lacks; the entry uses the copy in {2}.' -f $title, $other.Directory.Name, $t.Directory.Name))
        }
      }
    }

    if ($DryRun) {
      $tally[$src]++; $dateTally[$dateSrc]++; $folderTally[$folderSrc]++
      if ($archived) { $twinTally.archived++ }
      if ($lineageJson) { $twinTally.lineage++ }
      [void]$pendingTranscripts.Add($cli)
      if ($samples.Count -lt 22) { $samples.Add(('[{0,-6}][{1} {2}] {3}' -f $src, $model, $effort, $title)) }
      continue
    }

    $inv = [Globalization.CultureInfo]::InvariantCulture
    $sid = 'local_' + [guid]::NewGuid().ToString()
    $json = '{"sessionId":"' + $sid + '","cliSessionId":"' + $cli + '","cwd":' + (ConvertTo-JsJson $folder) + ',"originCwd":' + (ConvertTo-JsJson $originFolder) + ',"lastFocusedAt":' + ([long]$focusedMs).ToString($inv) + ',"createdAt":' + ([long]$createdMs).ToString($inv) + ',"lastActivityAt":' + ([long]$activityMs).ToString($inv) + ',"model":' + (ConvertTo-JsJson $model) + ',"effort":' + (ConvertTo-JsJson $effort) + ',"sessionSettings":{},"isArchived":' + $(if ($archived) { 'true' } else { 'false' }) + ',"title":' + (ConvertTo-JsJson $title) + ',"titleSource":' + (ConvertTo-JsJson $titleSource) + ',"permissionMode":"default","remoteMcpServersConfig":[],"alwaysAllowedReasons":[],"sessionPermissionUpdates":[],"classifierSummaryEnabled":true,"spawnSeed":{}' + $lineageJson + '}'
    [void](ConvertFrom-JsJson $json)
    $outPath = Join-Path $orgDir ($sid + '.json')
    [System.IO.File]::WriteAllText($outPath, $json, $utf8)
    $created.Add($outPath)
    $dateTally[$dateSrc]++; $folderTally[$folderSrc]++
    if ($archived) { $twinTally.archived++ }
    if ($lineageJson) { $twinTally.lineage++ }
  } catch { Write-Host ("skip {0}: {1}" -f $cli, $_.Exception.Message) }
}

$datesLine = "  dates: {0} from the same chat's entry in another account, {1} from the transcript's last record, {2} from the transcript file's times" -f $dateTally.twin, $dateTally.record, $dateTally.file
$foldersLine = "  folders: {0} from the same chat's entry in another account, {1} from where the transcript is stored, {2} from the transcript's records, {3} the drive root" -f $folderTally.twin, $folderTally.stored, $folderTally.record, $folderTally.root
$twinLine = "  as in the same chat's entry in another account: {0} archived, {1} carrying their earlier transcripts" -f $twinTally.archived, $twinTally.lineage

if ($DryRun) {
  $tot = $tally.twin + $tally.custom + $tally.ai + $tally.user + $tally.date
  Write-Host ("DRY RUN - nothing written. Would create {0} entries:" -f $tot)
  Write-Host ("  its title in another account : {0}" -f $tally.twin)
  Write-Host ("  your custom title  : {0}" -f $tally.custom)
  Write-Host ("  app ai-title       : {0}" -f $tally.ai)
  Write-Host ("  your first message : {0}" -f $tally.user)
  Write-Host ("  dated fallback     : {0}" -f $tally.date)
  Write-Host $datesLine
  Write-Host $foldersLine
  Write-Host $twinLine
  Write-Host '--- sample titles ---'
  $samples | ForEach-Object { Write-Host $_ }
} else {
  if ($created.Count -gt 0) {
    $manifestPath = Join-Path $scriptDir ('created-entries-' + $stamp + '.txt')
    [System.IO.File]::WriteAllText($manifestPath, ($created -join [Environment]::NewLine), $utf8)
    Write-Host ("Created {0} new sidebar entries." -f $created.Count)
    Write-Host $datesLine
    Write-Host $foldersLine
    Write-Host $twinLine
    Write-Host ("Manifest (for -Undo): {0}" -f $manifestPath)
  } else {
    Write-Host 'Nothing to create - every chat is already listed in this account.'
  }
  Write-Host ("Org dir now has {0} entries." -f (Get-ChildItem -LiteralPath $orgDir -Filter *.json -File).Count)
}
if ($skippedParts -gt 0) { Write-Host ("Left out: {0} transcript(s) that an entry keeps as another part of its chat." -f $skippedParts) }
foreach ($warning in $copyWarnings) { Write-Host $warning }

# --- groups, pins and folders: work out how this account's become an exact copy of the
# configured account's. Folders are set here, in the chat entries. Groups and pins are left to
# the app's own sidebar tools: this saves the plan, and -Sidebar lists the calls ---
$runDir = Join-Path $backupsRoot $stamp
if (-not $userConfig.CopyGroupsFrom) {
  Write-Host 'Groups, pins and folders: nothing planned (session-restore.config.json names no account in copyGroupsFromEmail).'
} else {
  & {
    Write-Host ''
    $source = $sourceAccount
    if (-not $source) {
      Write-Host '--- groups, pins and folders ---'
      Write-Host ("Nothing planned. copyGroupsFromEmail in session-restore.config.json names {0}, which is neither the email of an account this script has seen (in Claude Code's account files or in known-accounts.json) nor the id of an account folder on this computer." -f $userConfig.CopyGroupsFrom)
      return
    }
    $from = $source.Label
    Write-Host "--- groups, pins and folders: as in $from ---"
    if ($source.AccountUuid -eq $acct) { Write-Host "Nothing planned. You are signed in as $from, the account the groups and pins come from."; return }

    $prefs = $null
    try { $prefs = ConvertFrom-JsJson (Read-TextFile $prefsPath) } catch { Write-Host ("Nothing planned. The app's settings file could not be read: {0}" -f $_.Exception.Message); return }
    $epitaxy = Get-JsMember (Get-JsMember $prefs 'preferences') 'epitaxyPrefs'
    if (-not ($epitaxy -is [System.Collections.IDictionary])) { Write-Host 'Nothing planned. claude_desktop_config.json has no preferences.epitaxyPrefs object; the app may have changed how it saves groups and pins.'; return }
    $prefScopes = Get-JsMember $epitaxy $groupsPref
    if (-not ($prefScopes -is [System.Collections.IDictionary])) { $prefScopes = $null }
    $storeScopes = $null
    if ($sidebarStore -and $sidebarStore.Store) {
      if (-not (Get-JsMember $sidebarStore.Store 'state') -or $null -eq (Get-JsMember $sidebarStore.Store 'version')) {
        Write-Host "(The sidebar's own saved state is not in the shape this script knows, so it is not used.)"
      } else {
        $storeScopes = Get-StoreScopes $sidebarStore.Store
        if (@($sidebarStore.State.LogProblems).Count -gt 0) { Write-Host "(The app's browser storage was read while it was being written, so what was read from it may be a moment behind.)" }
      }
    }

    # the source account's groups: the sidebar's own saved state, else the saved form in the
    # app's settings file, else the list this script saved when it last ran under that account
    $sourcePrefix = $source.AccountUuid + '/'
    $sourceKey = $null; $sourceScope = $null; $readFrom = $null; $groupsSkipped = $null
    foreach ($place in @(@{ Scopes = $storeScopes; Name = "the sidebar's own storage" }, @{ Scopes = $prefScopes; Name = "the app's settings file" })) {
      if ($sourceKey -or $groupsSkipped -or -not $place.Scopes) { continue }
      $candidates = @($place.Scopes.Keys | Where-Object { $_.StartsWith($sourcePrefix) })
      if ($candidates.Count -eq 1) { $sourceKey = $candidates[0] }
      elseif ($candidates.Count -gt 1 -and $source.OrganizationUuid -and ($candidates -contains ($sourcePrefix + $source.OrganizationUuid))) { $sourceKey = $sourcePrefix + $source.OrganizationUuid }
      elseif ($candidates.Count -gt 1) { $groupsSkipped = ("{0} has groups under more than one org ({1})" -f $from, ($candidates -join ', ')) }
      if ($sourceKey) { $sourceScope = $place.Scopes[$sourceKey]; $readFrom = $place.Name }
    }
    $savedList = $null
    if (-not $sourceKey -and -not $groupsSkipped) {
      $savedList = Read-SidebarList (Get-SidebarListPath $source.AccountUuid)
      if ($savedList) { $readFrom = ('the list this script saved on {0}' -f $savedList.SavedAt) }
      else { $groupsSkipped = "$from has no groups saved on this computer" }
    }
    $sourceOrg = $null
    if ($sourceKey) { $sourceOrg = $sourceKey.Substring($sourcePrefix.Length) }
    elseif ($source.OrganizationUuid) { $sourceOrg = $source.OrganizationUuid }
    elseif ($savedList -and $savedList.Org) { $sourceOrg = $savedList.Org }
    else { $sourceOrg = Get-BusiestOrg (Join-Path $sessionsRoot $source.AccountUuid) }
    $sourceOrgDir = $null
    if ($sourceOrg) { $sourceOrgDir = Join-Path (Join-Path $sessionsRoot $source.AccountUuid) $sourceOrg }
    if (-not $sourceOrgDir -or -not (Test-Path -LiteralPath $sourceOrgDir)) { Write-Host "Nothing planned. The sidebar entries for $from are missing ($sourceOrgDir), so its chats cannot be matched."; return }

    $destKey = "$acct/$org"
    $sourceEntries = Get-AccountEntries $sourceOrgDir
    $destEntries = Get-AccountEntries $orgDir
    $usable = { param($e) -not $e.Archived -and -not $e.Routine }
    $titled = {
      param($items)
      @($items | ForEach-Object { if ($_.Title) { '"' + $_.Title + '"' } else { $_.Id } })
    }

    # --- groups: each of the source's groups by the transcripts of its chats, then by this
    # account's entries for those transcripts. A group none of whose chats can be filed here is
    # left out, as the app leaves a group with no chats out of its own settings file ---
    $stats = @{ NoSourceEntry = 0; NotCode = 0; Mapped = 0; NewEntry = 0; NoEntryHere = 0; CannotFile = 0; LeftOut = 0 }
    $desiredGroups = $null
    if (-not $groupsSkipped) {
      $sourceGroups = New-Object System.Collections.Generic.List[object]
      if ($savedList) { foreach ($g in $savedList.Groups) { $sourceGroups.Add($g) } }
      else {
        $read = Get-ScopeGroups $sourceScope
        $stats.NotCode = $read.NotCode
        foreach ($g in $read.Groups) {
          $transcripts = New-Object System.Collections.Generic.List[string]
          foreach ($id in $g.Sessions) {
            $entry = $null
            if ($sourceEntries.ById.TryGetValue($id, [ref]$entry) -and $entry.Transcript) {
              if (-not $transcripts.Contains($entry.Transcript)) { $transcripts.Add($entry.Transcript) }
            } else { $stats.NoSourceEntry++ }
          }
          $sourceGroups.Add([pscustomobject]@{ Name = $g.Name; Transcripts = $transcripts.ToArray() })
        }
      }
      $seenNames = New-Object 'System.Collections.Generic.HashSet[string]'
      foreach ($g in $sourceGroups) { if (-not $seenNames.Add($g.Name)) { $groupsSkipped = ('{0} has two groups named "{1}", so chats cannot be filed by group name' -f $from, $g.Name) } }
    }
    if (-not $groupsSkipped) {
      $desiredGroups = New-Object System.Collections.Generic.List[object]
      foreach ($g in $sourceGroups) {
        $sessions = New-Object System.Collections.Generic.List[string]
        $pendingHere = 0
        foreach ($t in $g.Transcripts) {
          $ids = $null
          if ($destEntries.ByTranscript.TryGetValue($t, [ref]$ids)) {
            $stats.Mapped++
            foreach ($id in $ids) { if (& $usable $destEntries.ById[$id]) { $sessions.Add($id) } else { $stats.CannotFile++ } }
          } elseif ($pendingTranscripts.Contains($t)) { $stats.NewEntry++; $pendingHere++ }
          else { $stats.NoEntryHere++ }
        }
        if ($sessions.Count -gt 0 -or $pendingHere -gt 0) { $desiredGroups.Add([pscustomobject]@{ Name = $g.Name; Sessions = $sessions.ToArray(); Chats = ($sessions.Count + $pendingHere) }) }
        else { $stats.LeftOut++ }
      }
      # (an array from here on: Windows PowerShell 5.1 cannot wrap a list of objects in @(...))
      $desiredGroups = $desiredGroups.ToArray()
      $groupsText = 'none'
      if ($desiredGroups.Count -gt 0) { $groupsText = (@($desiredGroups) | ForEach-Object { '"{0}" ({1})' -f $_.Name, $_.Chats }) -join ', ' }
      Write-Host ("Groups in {0} (read from {1}): {2}" -f $from, $readFrom, $groupsText)
      Write-Host ("Grouped chats matched to this account: {0}{1}" -f $stats.Mapped, $(if ($stats.NewEntry) { " (+{0} that get their entry in this run)" -f $stats.NewEntry } else { '' }))
      if ($stats.NoSourceEntry) { Write-Host ("  {0} grouped chat(s) have no sidebar entry left in {1}, so they cannot be matched." -f $stats.NoSourceEntry, $from) }
      if ($stats.NoEntryHere) { Write-Host ("  {0} grouped chat(s) have no transcript on this computer, so they cannot be matched." -f $stats.NoEntryHere) }
      if ($stats.CannotFile) { Write-Host ("  {0} grouped chat(s) are archived here or are a routine's run, which the app's sidebar tools do not file." -f $stats.CannotFile) }
      if ($stats.NotCode) { Write-Host ("  {0} grouped item(s) are not local Code sessions and are left out." -f $stats.NotCode) }
      if ($stats.LeftOut) { Write-Host ("  {0} group(s) hold no chat that can be filed here and are left out." -f $stats.LeftOut) }
      # every group left out is no sign that the source has none: leave this account's groups alone
      if ($desiredGroups.Count -eq 0 -and $sourceGroups.Count -gt 0) { $groupsSkipped = "none of the groups of $from holds a chat that can be filed here"; $desiredGroups = $null }
    }
    if ($groupsSkipped) { Write-Host "Groups: not planned. $groupsSkipped." }

    # --- pins: the app keeps ONE pin list for every account; each account sees the entries in
    # it that are its own. So the source's pins are its entries in that list ---
    $pinList = @()
    $pinsSkipped = $null
    $pinsValue = Get-JsMember $epitaxy $starredPref
    if (-not ($pinsValue -is [System.Collections.IList])) { $pinsSkipped = "the app's settings file has no pin list in the shape this script knows" }
    else { $pinList = @($pinsValue | Where-Object { $_ -is [string] }) }
    $desiredPinned = $null
    $pinStats = @{ NewEntry = 0; NoEntryHere = 0; CannotPin = 0 }
    $beforePinned = @($pinList | Where-Object { $destEntries.ById.ContainsKey($_) })
    if (-not $pinsSkipped) {
      $desiredPinned = New-Object System.Collections.Generic.List[string]
      $sourcePinned = New-Object System.Collections.Generic.List[object]
      foreach ($id in $pinList) {
        $entry = $null
        if (-not $sourceEntries.ById.TryGetValue($id, [ref]$entry)) { continue }
        $sourcePinned.Add($entry)
        $ids = $null
        if ($entry.Transcript -and $destEntries.ByTranscript.TryGetValue($entry.Transcript, [ref]$ids)) {
          foreach ($d in $ids) {
            if (-not (& $usable $destEntries.ById[$d])) { $pinStats.CannotPin++ }
            elseif (-not $desiredPinned.Contains($d)) { $desiredPinned.Add($d) }
          }
        } elseif ($entry.Transcript -and $pendingTranscripts.Contains($entry.Transcript)) { $pinStats.NewEntry++ }
        else { $pinStats.NoEntryHere++ }
      }
      $desiredPinned = $desiredPinned.ToArray()
      $toPin = @($desiredPinned | Where-Object { $beforePinned -notcontains $_ })
      $toUnpin = @($beforePinned | Where-Object { $desiredPinned -notcontains $_ })
      Write-Host ("Pins in {0}: {1}{2}" -f $from, $sourcePinned.Count, $(if ($sourcePinned.Count) { ' - ' + ((& $titled $sourcePinned.ToArray()) -join ', ') } else { '' }))
      Write-Host ("Pins here: {0} now; {1} to pin{2}, {3} to unpin" -f $beforePinned.Count, $toPin.Count, $(if ($pinStats.NewEntry) { " (+{0} that get their entry in this run)" -f $pinStats.NewEntry } else { '' }), $toUnpin.Count)
      if ($toUnpin.Count) {
        Write-Host ("  to unpin here, because {0} has not pinned them:" -f $from)
        foreach ($t in (& $titled @($toUnpin | ForEach-Object { $destEntries.ById[$_] }))) { Write-Host "    $t" }
      }
      if ($pinStats.NoEntryHere) { Write-Host ("  {0} pinned chat(s) of {1} have no transcript on this computer, so they cannot be matched." -f $pinStats.NoEntryHere, $from) }
      if ($pinStats.CannotPin) { Write-Host ("  {0} pinned chat(s) are archived here or are a routine's run, which the app's sidebar tools do not pin." -f $pinStats.CannotPin) }
    } else { Write-Host "Pins: not planned. $pinsSkipped." }

    # --- folders: each chat here goes in the folder its twin in the source account names, when
    # that folder exists and holds the chat's transcript. It stays put when a copy of its transcript
    # elsewhere holds messages the one there lacks, since the app would then show the older copy ---
    $folderEdits = New-Object System.Collections.Generic.List[object]
    $folderSkips = New-Object System.Collections.Generic.List[string]
    foreach ($pair in $entriesByTranscript.GetEnumerator()) {
      $mine = @($pair.Value | Where-Object { $_.Account -eq $acct -and $_.Org -eq $org })
      if ($mine.Count -eq 0) { continue }
      $theirs = @($pair.Value | Where-Object { $_.Account -eq $source.AccountUuid -and $_.Org -eq $sourceOrg })
      if ($theirs.Count -eq 0) { continue }
      $places = @($theirs | ForEach-Object {
          $c = Get-JsMember $_.Entry 'cwd'
          $o = Get-JsMember $_.Entry 'originCwd'
          if (-not ($o -is [string]) -or -not $o) { $o = $c }
          [pscustomobject]@{ Cwd = $c; Origin = $o }
        })
      $wantCwd = $places[0].Cwd
      $wantOrigin = $places[0].Origin
      $disagree = @($places | Where-Object { -not ($_.Cwd -ceq $wantCwd) -or -not ($_.Origin -ceq $wantOrigin) }).Count -gt 0
      foreach ($item in $mine) {
        $haveCwd = Get-JsMember $item.Entry 'cwd'
        $haveOrigin = Get-JsMember $item.Entry 'originCwd'
        if (($haveCwd -ceq $wantCwd) -and ($haveOrigin -ceq $wantOrigin)) { continue }
        $title = [string](Get-JsMember $item.Entry 'title')
        $reason = $null
        if ($disagree) { $reason = "its entries in $from name different folders" }
        elseif (Get-JsMember $item.Entry 'worktreePath') { $reason = 'it runs in a worktree' }
        elseif (-not ($wantCwd -is [string]) -or -not $wantCwd -or -not (Test-Path -LiteralPath $wantCwd -PathType Container)) { $reason = "the folder $wantCwd does not exist" }
        else {
          $project = Get-ProjectFolderName $wantCwd
          $target = Join-Path (Join-Path $projectsRoot $project) ($pair.Key + '.jsonl')
          if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { $reason = "its transcript is not in $project" }
          elseif ($copiesById.ContainsKey($pair.Key)) {
            foreach ($copy in $copiesById[$pair.Key]) {
              if ($copy.Directory.Name -ieq $project) { continue }
              if (Test-TranscriptAhead $target $copy.FullName) { $reason = "its transcript copy in $($copy.Directory.Name) holds messages the copy in $project lacks"; break }
            }
          }
        }
        if ($reason) { $folderSkips.Add(('"{0}" stays in {1}, because {2}.' -f $title, $haveCwd, $reason)); continue }
        $folderEdits.Add([pscustomobject]@{ Path = $item.Path; Cwd = $wantCwd; Origin = $wantOrigin; From = $haveCwd; Title = $title })
      }
    }
    if ($folderEdits.Count -gt 0) {
      Write-Host ("Folders: {0} chat(s) here are in a different folder from their twin in {1}:" -f $folderEdits.Count, $from)
      foreach ($f in ($folderEdits | Sort-Object Title)) { Write-Host ('  "{0}": {1} -> {2}' -f $f.Title, $f.From, $f.Cwd) }
    } elseif ($folderSkips.Count -eq 0) {
      Write-Host "Folders: every chat here that $from also has is in the same folder as there."
    }
    if ($folderSkips.Count -gt 0) {
      Write-Host ("Folders: {0} chat(s) here are in a different folder from their twin in {1} and are left where they are:" -f $folderSkips.Count, $from)
      foreach ($s in $folderSkips) { Write-Host "  $s" }
    }
    if ($folderEdits.Count -gt 0 -and -not $DryRun) {
      $activity = Get-AppActivity $packageFolder.Name @($leveldbDir)
      if ($activity.Count -gt 0) {
        Write-Host ("Folders: not changed, because Claude is still running ({0}). Quit it fully, including from the system tray, and run this script again to move those chats." -f ($activity -join '; '))
      } else {
        Backup-RunFiles $runDir @($folderEdits | ForEach-Object { $_.Path }) $null
        Write-Host "Backup  : $runDir"
        try {
          foreach ($edit in $folderEdits) {
            $entry = ConvertFrom-JsJson (Read-TextFile $edit.Path)
            $entry['cwd'] = $edit.Cwd
            $entry['originCwd'] = $edit.Origin
            Write-TextFileAtomic $edit.Path (ConvertTo-JsJson $entry)
          }
          $backupDir = Join-Path $runDir 'entries'
          $unexpected = $null
          foreach ($edit in $folderEdits) {
            $was = ConvertFrom-JsJson (Read-TextFile (Join-Path $backupDir (Split-Path -Leaf $edit.Path)))
            $is = ConvertFrom-JsJson (Read-TextFile $edit.Path)
            $good = Test-JsChangeConfined $was $is @((Get-JsPath '$' 'cwd'), (Get-JsPath '$' 'originCwd')) ([ref]$unexpected)
            if ($good -and (-not ($is['cwd'] -ceq $edit.Cwd) -or -not ($is['originCwd'] -ceq $edit.Origin))) { $good = $false }
            if (-not $good) { throw "the chat entry $(Split-Path -Leaf $edit.Path) read back wrong" }
          }
          Write-Host ("Folders: moved {0} chat(s)." -f $folderEdits.Count)
        } catch {
          $failure = $_.Exception.Message
          Write-Host "Folders: the write did not check out ($failure). Putting back the backed-up entries..."
          Restore-RunFiles $runDir
          Remove-Item -LiteralPath $runDir -Recurse -Force
          Write-Host 'Folders: rolled back; every chat entry is exactly as it was.'
        }
      }
    }

    # --- the plan: what this account's groups and pins should be, and what they are now ---
    if ($groupsSkipped -and $pinsSkipped) { return }
    $destScope = $null
    if ($storeScopes -and (Test-JsKey $storeScopes $destKey)) { $destScope = $storeScopes[$destKey] }
    elseif ($prefScopes -and (Test-JsKey $prefScopes $destKey)) { $destScope = $prefScopes[$destKey] }
    $beforeGroups = @()
    if ($destScope -is [System.Collections.IDictionary]) { $beforeGroups = @((Get-ScopeGroups $destScope).Groups) }
    $madeMs = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $desired = ConvertTo-PlanState $desiredGroups $desiredPinned
    # (assigned, not returned from $(...): an empty list has to stay a list, not turn into nothing)
    $beforeGroupsPlanned = $null
    if (-not $groupsSkipped) { $beforeGroupsPlanned = $beforeGroups }
    $beforePinnedPlanned = $null
    if (-not $pinsSkipped) { $beforePinnedPlanned = $beforePinned }
    $before = ConvertTo-PlanState $beforeGroupsPlanned $beforePinnedPlanned
    $nowPinned = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($id in $beforePinned) { [void]$nowPinned.Add($id) }
    $diff = Get-SidebarCalls (ConvertFrom-PlanState $desired) ([pscustomobject]@{ Groups = $beforeGroups; Pinned = $nowPinned }) $destEntries $madeMs
    if ($diff.Blocked) { Write-Host ("Groups and pins: not planned, because {0}." -f $diff.Blocked); return }
    foreach ($note in $diff.Notes) { Write-Host $note }
    $deletes = @($diff.Calls | Where-Object { $_.Tool -eq 'delete_group' })
    if ($deletes.Count -gt 0) { Write-Host ("Groups here that {0} does not have, to delete once their chats are out of them: {1}" -f $from, ((@($deletes) | ForEach-Object { '"' + $_.Group + '"' }) -join ', ')) }
    if ($DryRun) {
      Write-Host ("DRY RUN - would save a sidebar plan with about {0} call(s) for the app's sidebar tools; the entries this run would create are not counted yet." -f $diff.Calls.Count)
      return
    }
    $plan = New-JsObject
    $plan['v'] = 1
    $plan['run'] = $stamp
    $plan['madeAtMs'] = $madeMs
    $plan['madeAt'] = [DateTimeOffset]::FromUnixTimeMilliseconds($madeMs).UtcDateTime.ToString('o')
    $plan['receiving'] = New-JsObject
    $plan['receiving']['accountUuid'] = $acct
    $plan['receiving']['organizationUuid'] = $org
    $plan['source'] = New-JsObject
    $plan['source']['accountUuid'] = $source.AccountUuid
    $plan['source']['organizationUuid'] = $sourceOrg
    $plan['source']['groupsReadFrom'] = $readFrom
    $plan['aim'] = 'desired'
    $plan['desired'] = $desired
    $plan['before'] = $before
    Save-SidebarPlan $plan
    Write-Host "Sidebar plan saved: $planFile"
    if ($diff.Calls.Count -eq 0) {
      Write-Host "Groups and pins: already as in $from. Nothing is left for the app's sidebar tools to do."
    } else {
      Write-Host ("Groups and pins: {0} call(s) are left for the app's own sidebar tools, which only a Claude session in the app can make. When Claude is open again, give any session this line:" -f $diff.Calls.Count)
      Write-Host ('  Apply my sidebar plan: run  powershell -NoProfile -ExecutionPolicy Bypass -File "{0}" -Sidebar  and make the calls it lists with your sidebar tools, in order. Then run it again, until it says the sidebar matches the plan.' -f $PSCommandPath)
    }
  }
}

if (-not $DryRun) {
  # the list of this account's own groups, kept for a later run under another account; under the
  # account the config names, the one the groups come from, the run says what it saved
  $ownSave = $null
  try {
    $ownEntries = Get-AccountEntries $orgDir
    $ownSave = Save-SidebarList $acct $org $ownEntries (Get-SidebarNow $prefsPath "$acct/$org" $ownEntries)
  } catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    $ownSave = [pscustomobject]@{ Saved = $false; Replaced = $false; Problem = $cause.Message.Trim().TrimEnd('.'); Path = $null; Groups = @(); Pinned = @(); Unnamed = 0; SavedAt = $null }
  }
  if ($sourceAccount -and ($sourceAccount.AccountUuid -eq $acct)) {
    $ownLabel = $currentEmail
    if (-not $ownLabel) { $ownLabel = $acct }
    Write-SidebarListSave $ownSave $ownLabel $true
  }

  # the config's account, filled in when its setting asks for it: the account signed in for
  # this run, so that the next run, under another account, copies from the one just left
  if ($userConfig.AutoUpdate) {
    $me = $(if ($currentEmail) { $currentEmail } else { $acct })
    if (-not ($userConfig.CopyGroupsFrom -ieq $me)) {
      Backup-RunFiles $runDir @() $configFile
      $userConfig.Raw['copyGroupsFromEmail'] = $me
      $text = ConvertTo-JsJson $userConfig.Raw -Indent 2
      if ($userConfig.Text.EndsWith("`r`n")) { $text += "`r`n" } elseif ($userConfig.Text.EndsWith("`n")) { $text += "`n" }
      Write-TextFileAtomic $configFile $text
      Write-Host ("Config  : copyGroupsFromEmail now names {0}, the account signed in for this run (autoUpdateCopyGroupsFromEmail is 1)." -f $me)
    }
  }
  Save-KnownAccounts $known
  Write-Host 'Reopen the Claude app (fully quit it first if it is running) to see the result.'
}
