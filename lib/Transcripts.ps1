<#
  Transcripts.ps1 - what a sidebar entry has to agree with about its Claude Code transcript: the
  project folder a working folder's transcripts are stored in, a transcript's first lines, the
  time of its last record, and whether one copy of a transcript holds records another copy
  lacks. Every read here lets Claude Code keep appending to the transcript.

  Needs lib\JsJson.ps1.
#>

function ConvertTo-Base36([int64]$Value) {
  $digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  if ($Value -le 0) { return '0' }
  $text = ''
  while ($Value -gt 0) {
    $text = [string]$digits[[int]($Value % 36)] + $text
    $Value = [int64][Math]::Floor($Value / 36)
  }
  $text
}

# The folder under .claude\projects that holds the transcripts of sessions run in $Path, named as
# the desktop app names it: every character other than an ASCII letter or digit becomes '-', and a
# name longer than 200 characters is cut to 200 and followed by '-' and a base-36 hash of the path.
function Get-ProjectFolderName([string]$Path) {
  $name = [regex]::Replace($Path, '[^a-zA-Z0-9]', '-')
  if ($name.Length -le 200) { return $name }
  [int64]$hash = 0
  foreach ($c in $Path.ToCharArray()) { $hash = ($hash * 31 + [int]$c) % 4294967296 }
  if ($hash -ge 2147483648) { $hash = $hash - 4294967296 }
  $name.Substring(0, 200) + '-' + (ConvertTo-Base36 ([Math]::Abs($hash)))
}

# A file's bytes, read while another process may be appending to it.
function Read-FileBytesShared([string]$Path) {
  $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
  try {
    $bytes = New-Object byte[] $stream.Length
    $got = 0
    while ($got -lt $bytes.Length) {
      $n = $stream.Read($bytes, $got, $bytes.Length - $got)
      if ($n -le 0) { break }
      $got += $n
    }
    if ($got -lt $bytes.Length) { [Array]::Resize([ref]$bytes, $got) }
  } finally { $stream.Dispose() }
  , $bytes
}

# The first lines of a transcript, at most $Max of them, read while another process may be
# appending to it: the stream lets others write, and is closed before this returns.
function Read-TranscriptHeadLines([string]$Path, [int]$Max) {
  $lines = New-Object System.Collections.Generic.List[string]
  $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
  try {
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
    while ($lines.Count -lt $Max) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { break }
      $lines.Add($line)
    }
  } finally { $stream.Dispose() }
  , $lines.ToArray()
}

# The time of a transcript's last record that carries a top-level "timestamp", in epoch
# milliseconds, or $null when it has none. Read from the end through a window that widens until
# such a record is found, because one record can be larger than any fixed window.
function Get-TranscriptLastRecordMs([string]$Path) {
  [int64]$take = 262144
  for (;;) {
    $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
    try {
      $length = $stream.Length
      if ($take -gt $length) { $take = $length }
      [void]$stream.Seek($length - $take, 'Begin')
      $buffer = New-Object byte[] $take
      $got = 0
      while ($got -lt $take) {
        $n = $stream.Read($buffer, $got, $take - $got)
        if ($n -le 0) { break }
        $got += $n
      }
    } finally { $stream.Dispose() }
    $lines = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $got) -split "`n"
    $first = 0
    if ($take -lt $length) { $first = 1 }
    for ($i = $lines.Count - 1; $i -ge $first; $i--) {
      $line = $lines[$i].Trim()
      if (-not $line.StartsWith('{')) { continue }
      try { $record = ConvertFrom-JsJson $line } catch { continue }
      $stamp = Get-JsMember $record 'timestamp'
      if ($stamp -is [string] -and $stamp) {
        $parsed = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse($stamp, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
          return $parsed.ToUnixTimeMilliseconds()
        }
      }
    }
    if ($take -ge $length) { return $null }
    $take = [Math]::Min($length, $take * 4)
  }
}

# Whether the transcript copy at $Other holds records that the copy at $Target lacks, so that an
# entry pointed at $Target would hide part of the conversation: $Other begins with all of $Target
# and goes on with a record that carries a timestamp or cannot be read, or the two copies differ
# before the shorter one ends. Records with no top-level timestamp (titles, modes, file snapshots)
# are session state, not messages.
function Test-TranscriptAhead([string]$Target, [string]$Other) {
  $a = Read-FileBytesShared $Target
  $b = Read-FileBytesShared $Other
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $common = [Math]::Min($a.Length, $b.Length)
    $ha = [Convert]::ToBase64String($sha.ComputeHash($a, 0, $common))
    $hb = [Convert]::ToBase64String($sha.ComputeHash($b, 0, $common))
    if ($ha -ne $hb) { return $true }
    if ($b.Length -le $a.Length) { return $false }
    $rest = [System.Text.Encoding]::UTF8.GetString($b, $a.Length, $b.Length - $a.Length)
    foreach ($piece in ($rest -split "`n")) {
      $line = $piece.Trim()
      if (-not $line) { continue }
      try { $record = ConvertFrom-JsJson $line } catch { return $true }
      if (-not ($record -is [System.Collections.IDictionary])) { return $true }
      $stamp = Get-JsMember $record 'timestamp'
      if ($stamp -is [string] -and $stamp) { return $true }
    }
    return $false
  } finally { $sha.Dispose() }
}
