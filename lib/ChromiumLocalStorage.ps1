<#
  ChromiumLocalStorage.ps1 - read values from the LevelDB database that holds the browser
  storage of a Chromium-based app such as the Claude desktop app (its "Local Storage\leveldb"
  folder).

  It implements only what that needs, following the published formats: LevelDB's log, table
  and manifest files (github.com/google/leveldb, doc/log_format.md and doc/table_format.md) and
  Snappy decompression (github.com/google/snappy, format_description.txt).

  It only reads, and is given a private copy of the folder to read: LevelDB allows one process
  at a time, and nothing here ever writes to a database.
#>

$script:LdbBlockSize  = 32768
$script:LdbHeaderSize = 7
$script:LdbAllBits    = [uint64]4294967295
$script:LdbMaskDelta  = [uint64]2726488792
$script:LdbTableMagic = [Convert]::ToUInt64('db4775248b80fb57', 16)
$script:LdbLatin1     = [System.Text.Encoding]::GetEncoding(28591)
$script:LdbManifestCache = @{}

$script:LdbCrcTable = [uint64[]]::new(256)
& {
  $polynomial = [uint64]2197175160
  for ($n = 0; $n -lt 256; $n++) {
    [uint64]$c = $n
    for ($k = 0; $k -lt 8; $k++) {
      if (($c -band [uint64]1) -ne 0) { $c = $polynomial -bxor ($c -shr 1) } else { $c = $c -shr 1 }
    }
    $script:LdbCrcTable[$n] = $c
  }
}

function Get-LdbCrc32c {
  param([byte[]]$Data, [int]$Offset = 0, [int]$Count = -1, [uint64]$Seed = 0)
  if ($Count -lt 0) { $Count = $Data.Length - $Offset }
  $table = $script:LdbCrcTable
  [uint64]$crc = $Seed -bxor $script:LdbAllBits
  $end = $Offset + $Count
  for ($i = $Offset; $i -lt $end; $i++) {
    $crc = $table[[int](($crc -bxor $Data[$i]) -band [uint64]255)] -bxor ($crc -shr 8)
  }
  $crc -bxor $script:LdbAllBits
}

function Get-LdbMaskedCrc {
  param([uint64]$Crc)
  $rotated = ($Crc -shr 15) -bor (($Crc -shl 17) -band $script:LdbAllBits)
  ($rotated + $script:LdbMaskDelta) -band $script:LdbAllBits
}

function Read-LdbVarint {
  param([byte[]]$Buffer, [ref]$Position)
  [uint64]$result = 0
  $shift = 0
  $p = $Position.Value
  while ($true) {
    if ($p -ge $Buffer.Length) { throw 'A LevelDB number runs past the end of its record.' }
    $b = $Buffer[$p]
    $p++
    $result = $result -bor ([uint64]($b -band 127) -shl $shift)
    if (($b -band 128) -eq 0) { $Position.Value = $p; return $result }
    $shift += 7
    if ($shift -gt 63) { throw 'A LevelDB number is longer than 64 bits.' }
  }
}

function Read-LdbSlice {
  param([byte[]]$Buffer, [ref]$Position)
  $length = [int](Read-LdbVarint $Buffer $Position)
  if ($Position.Value + $length -gt $Buffer.Length) { throw 'A LevelDB field runs past the end of its record.' }
  $slice = [byte[]]::new($length)
  [Array]::Copy($Buffer, $Position.Value, $slice, 0, $length)
  $Position.Value = $Position.Value + $length
  , $slice
}

function Expand-LdbSnappy {
  param([byte[]]$Source, [int]$Offset, [int]$Count)
  $end = $Offset + $Count
  $pos = $Offset
  $length = [int](Read-LdbVarint $Source ([ref]$pos))
  $out = [byte[]]::new($length)
  $op = 0
  while ($pos -lt $end) {
    $tag = [int]$Source[$pos]
    $pos++
    $kind = $tag -band 3
    if ($kind -eq 0) {
      $run = $tag -shr 2
      if ($run -ge 60) {
        $extra = $run - 59
        $run = 0
        for ($i = 0; $i -lt $extra; $i++) { $run = $run -bor ([int]$Source[$pos + $i] -shl (8 * $i)) }
        $pos += $extra
      }
      $run++
      if ($op + $run -gt $length -or $pos + $run -gt $end) { throw 'Snappy literal overruns its block.' }
      [Array]::Copy($Source, $pos, $out, $op, $run)
      $pos += $run
      $op += $run
      continue
    }
    if ($kind -eq 1) {
      $run = 4 + (($tag -shr 2) -band 7)
      $distance = (($tag -shr 5) -shl 8) -bor [int]$Source[$pos]
      $pos++
    } elseif ($kind -eq 2) {
      $run = 1 + ($tag -shr 2)
      $distance = [int]$Source[$pos] -bor ([int]$Source[$pos + 1] -shl 8)
      $pos += 2
    } else {
      $run = 1 + ($tag -shr 2)
      $distance = [int][BitConverter]::ToUInt32($Source, $pos)
      $pos += 4
    }
    if ($distance -le 0 -or $distance -gt $op -or $op + $run -gt $length) { throw 'Snappy copy points outside its block.' }
    if ($distance -ge $run) {
      [Array]::Copy($out, $op - $distance, $out, $op, $run)
    } else {
      for ($i = 0; $i -lt $run; $i++) { $out[$op + $i] = $out[$op - $distance + $i] }
    }
    $op += $run
  }
  if ($op -ne $length) { throw 'Snappy block decompressed to the wrong length.' }
  , $out
}

function Read-LdbLogFile {
  param([byte[]]$Bytes)
  $records = [System.Collections.Generic.List[byte[]]]::new()
  $problems = [System.Collections.Generic.List[string]]::new()
  $pending = $null
  $pos = 0
  while ($pos -lt $Bytes.Length) {
    $blockLeft = $script:LdbBlockSize - ($pos % $script:LdbBlockSize)
    if ($blockLeft -lt $script:LdbHeaderSize) {
      for ($i = $pos; $i -lt [Math]::Min($Bytes.Length, $pos + $blockLeft); $i++) {
        if ($Bytes[$i] -ne 0) { $problems.Add("non-zero block padding at offset $i"); break }
      }
      $pos += $blockLeft
      continue
    }
    if ($pos + $script:LdbHeaderSize -gt $Bytes.Length) { $problems.Add("incomplete record header at offset $pos"); break }
    $storedCrc = [uint64][BitConverter]::ToUInt32($Bytes, $pos)
    $length = [int]$Bytes[$pos + 4] -bor ([int]$Bytes[$pos + 5] -shl 8)
    $type = [int]$Bytes[$pos + 6]
    if ($type -eq 0 -and $length -eq 0) { $problems.Add("zero-filled record at offset $pos"); break }
    if ($pos + $script:LdbHeaderSize + $length -gt $Bytes.Length) { $problems.Add("incomplete record at offset $pos"); break }
    $crc = Get-LdbCrc32c -Data $Bytes -Offset ($pos + 6) -Count (1 + $length)
    if ((Get-LdbMaskedCrc $crc) -ne $storedCrc) { $problems.Add("checksum mismatch at offset $pos") }
    $payload = [byte[]]::new($length)
    [Array]::Copy($Bytes, $pos + $script:LdbHeaderSize, $payload, 0, $length)
    if ($type -eq 1) {
      if ($null -ne $pending) { $problems.Add("unfinished record before offset $pos"); $pending = $null }
      $records.Add($payload)
    } elseif ($type -eq 2) {
      if ($null -ne $pending) { $problems.Add("unfinished record before offset $pos") }
      $pending = [System.IO.MemoryStream]::new()
      $pending.Write($payload, 0, $length)
    } elseif ($type -eq 3 -or $type -eq 4) {
      if ($null -eq $pending) { $problems.Add("record continuation without a start at offset $pos") }
      else {
        $pending.Write($payload, 0, $length)
        if ($type -eq 4) { $records.Add($pending.ToArray()); $pending = $null }
      }
    } else {
      $problems.Add("unknown record type $type at offset $pos")
    }
    $pos += $script:LdbHeaderSize + $length
  }
  if ($null -ne $pending) { $problems.Add('the last record is unfinished') }
  [pscustomobject]@{ Records = $records; Problems = $problems; Length = $Bytes.Length }
}

function Read-LdbWriteBatch {
  param([byte[]]$Record)
  if ($Record.Length -lt 12) { throw 'A LevelDB write batch is shorter than its header.' }
  $sequence = [BitConverter]::ToUInt64($Record, 0)
  $count = [BitConverter]::ToUInt32($Record, 8)
  $entries = [System.Collections.Generic.List[object]]::new()
  $pos = 12
  for ($i = 0; $i -lt $count; $i++) {
    $type = $Record[$pos]
    $pos++
    $key = Read-LdbSlice $Record ([ref]$pos)
    $value = $null
    if ($type -eq 1) { $value = Read-LdbSlice $Record ([ref]$pos) }
    elseif ($type -ne 0) { throw "Unknown LevelDB write batch entry type $type." }
    $entries.Add([pscustomobject]@{ Sequence = $sequence + [uint64]$i; Deleted = ($type -eq 0); Key = $key; Value = $value })
  }
  if ($pos -ne $Record.Length) { throw 'A LevelDB write batch has bytes after its last entry.' }
  [pscustomobject]@{ Sequence = $sequence; Count = $count; Entries = $entries }
}

function Read-LdbManifest {
  param([string]$Directory)
  $current = [System.IO.File]::ReadAllText((Join-Path $Directory 'CURRENT')).Trim()
  if ($current -notmatch '^MANIFEST-\d+$') { throw "The database's CURRENT file does not name a manifest: $current" }
  $file = Get-Item -LiteralPath (Join-Path $Directory $current)
  $cacheKey = '{0}|{1}|{2}' -f $file.FullName, $file.Length, $file.LastWriteTimeUtc.Ticks
  if ($script:LdbManifestCache.ContainsKey($cacheKey)) { return $script:LdbManifestCache[$cacheKey] }

  $log = Read-LdbLogFile ([System.IO.File]::ReadAllBytes($file.FullName))
  if ($log.Problems.Count -gt 0) { throw ("The database manifest is damaged: " + ($log.Problems -join '; ')) }
  $state = [ordered]@{ Comparator = $null; LogNumber = [uint64]0; PrevLogNumber = [uint64]0; NextFileNumber = [uint64]0; LastSequence = [uint64]0 }
  $live = [System.Collections.Generic.HashSet[uint64]]::new()
  # Field layout of each manifest entry tag: v = number, s = length-prefixed bytes.
  $layouts = @{ 1 = 's'; 2 = 'v'; 3 = 'v'; 4 = 'v'; 5 = 'vs'; 6 = 'vv'; 7 = 'vvvss'; 9 = 'v' }
  $fields = [uint64[]]::new(5)
  foreach ($edit in $log.Records) {
    $end = $edit.Length
    $p = 0
    $tag = -1
    $layout = $null
    $field = -1
    while ($p -lt $end) {
      [uint64]$v = 0
      $shift = 0
      do {
        if ($p -ge $end -or $shift -gt 63) { throw 'The database manifest has a damaged entry.' }
        $b = $edit[$p]
        $p++
        $v = $v -bor ([uint64]($b -band 127) -shl $shift)
        $shift += 7
      } while (($b -band 128) -ne 0)
      if ($field -lt 0) {
        $tag = [int]$v
        $layout = $layouts[$tag]
        if ($null -eq $layout) { throw "The database manifest holds an entry this script does not know (tag $tag)." }
        $field = 0
        continue
      }
      if ($layout[$field] -eq 's') {
        if ($tag -eq 1) { $state.Comparator = [System.Text.Encoding]::UTF8.GetString($edit, $p, [int]$v) }
        $p += [int]$v
        if ($p -gt $end) { throw 'The database manifest has a damaged entry.' }
      }
      $fields[$field] = $v
      $field++
      if ($field -lt $layout.Length) { continue }
      if ($tag -eq 2) { $state.LogNumber = $fields[0] }
      elseif ($tag -eq 3) { $state.NextFileNumber = $fields[0] }
      elseif ($tag -eq 4) { $state.LastSequence = $fields[0] }
      elseif ($tag -eq 6) { [void]$live.Remove($fields[1]) }
      elseif ($tag -eq 7) { [void]$live.Add($fields[1]) }
      elseif ($tag -eq 9) { $state.PrevLogNumber = $fields[0] }
      $field = -1
    }
    if ($field -ge 0) { throw 'The database manifest has an unfinished entry.' }
  }
  $state.LiveTables = @($live | Sort-Object)
  $state.ManifestFile = $current
  $result = [pscustomobject]$state
  $script:LdbManifestCache[$cacheKey] = $result
  $result
}

function Compare-LdbBytes {
  param([byte[]]$A, [int]$ALength, [byte[]]$B, [int]$BLength)
  $n = [Math]::Min($ALength, $BLength)
  for ($i = 0; $i -lt $n; $i++) {
    if ($A[$i] -ne $B[$i]) { if ($A[$i] -lt $B[$i]) { return -1 } else { return 1 } }
  }
  if ($ALength -lt $BLength) { return -1 }
  if ($ALength -gt $BLength) { return 1 }
  return 0
}

function Compare-LdbInternalKey {
  param([byte[]]$A, [byte[]]$B)
  $byUser = Compare-LdbBytes $A ($A.Length - 8) $B ($B.Length - 8)
  if ($byUser -ne 0) { return $byUser }
  $trailerA = [BitConverter]::ToUInt64($A, $A.Length - 8)
  $trailerB = [BitConverter]::ToUInt64($B, $B.Length - 8)
  if ($trailerA -gt $trailerB) { return -1 }
  if ($trailerA -lt $trailerB) { return 1 }
  return 0
}

function Read-LdbTableBlock {
  param([byte[]]$File, [uint64]$Offset, [uint64]$Size)
  $start = [int]$Offset
  $length = [int]$Size
  if ($start + $length + 5 -gt $File.Length) { throw 'A table block points past the end of its file.' }
  $type = [int]$File[$start + $length]
  $stored = [uint64][BitConverter]::ToUInt32($File, $start + $length + 1)
  $crc = Get-LdbCrc32c -Data $File -Offset $start -Count ($length + 1)
  if ((Get-LdbMaskedCrc $crc) -ne $stored) { throw 'A table block failed its checksum.' }
  if ($type -eq 1) { return , (Expand-LdbSnappy $File $start $length) }
  if ($type -ne 0) { throw "A table block uses an unknown compression type ($type)." }
  $block = [byte[]]::new($length)
  [Array]::Copy($File, $start, $block, 0, $length)
  , $block
}

function Get-LdbBlockEntries {
  param([byte[]]$Block)
  $restarts = [int][BitConverter]::ToUInt32($Block, $Block.Length - 4)
  $limit = $Block.Length - 4 - 4 * $restarts
  $entries = [System.Collections.Generic.List[object]]::new()
  $lastKey = [byte[]]::new(0)
  $pos = 0
  while ($pos -lt $limit) {
    $shared = [int](Read-LdbVarint $Block ([ref]$pos))
    $unshared = [int](Read-LdbVarint $Block ([ref]$pos))
    $valueLength = [int](Read-LdbVarint $Block ([ref]$pos))
    $key = [byte[]]::new($shared + $unshared)
    [Array]::Copy($lastKey, 0, $key, 0, $shared)
    [Array]::Copy($Block, $pos, $key, $shared, $unshared)
    $pos += $unshared
    $value = [byte[]]::new($valueLength)
    [Array]::Copy($Block, $pos, $value, 0, $valueLength)
    $pos += $valueLength
    $entries.Add([pscustomobject]@{ Key = $key; Value = $value })
    $lastKey = $key
  }
  , $entries
}

function Find-LdbTableValue {
  param([string]$Path, [byte[]]$UserKey)
  $file = [System.IO.File]::ReadAllBytes($Path)
  if ($file.Length -lt 48) { throw "Table file is too short: $Path" }
  if ([BitConverter]::ToUInt64($file, $file.Length - 8) -ne $script:LdbTableMagic) { throw "Not a LevelDB table: $Path" }
  $footer = [byte[]]::new(40)
  [Array]::Copy($file, $file.Length - 48, $footer, 0, 40)
  $pos = 0
  [void](Read-LdbVarint $footer ([ref]$pos)); [void](Read-LdbVarint $footer ([ref]$pos))
  $indexOffset = Read-LdbVarint $footer ([ref]$pos)
  $indexSize = Read-LdbVarint $footer ([ref]$pos)
  $target = [byte[]]::new($UserKey.Length + 8)
  [Array]::Copy($UserKey, $target, $UserKey.Length)
  [Array]::Copy([BitConverter]::GetBytes([uint64]::MaxValue), 0, $target, $UserKey.Length, 8)
  $index = Get-LdbBlockEntries (Read-LdbTableBlock $file $indexOffset $indexSize)
  $startBlock = -1
  for ($i = 0; $i -lt $index.Count; $i++) {
    if ((Compare-LdbInternalKey $index[$i].Key $target) -ge 0) { $startBlock = $i; break }
  }
  if ($startBlock -lt 0) { return $null }
  for ($b = $startBlock; $b -lt $index.Count; $b++) {
    $hp = 0
    $blockOffset = Read-LdbVarint $index[$b].Value ([ref]$hp)
    $blockSize = Read-LdbVarint $index[$b].Value ([ref]$hp)
    foreach ($entry in (Get-LdbBlockEntries (Read-LdbTableBlock $file $blockOffset $blockSize))) {
      if ((Compare-LdbInternalKey $entry.Key $target) -lt 0) { continue }
      if ((Compare-LdbBytes $entry.Key ($entry.Key.Length - 8) $UserKey $UserKey.Length) -ne 0) { return $null }
      $trailer = [BitConverter]::ToUInt64($entry.Key, $entry.Key.Length - 8)
      return [pscustomobject]@{ Sequence = ($trailer -shr 8); Deleted = (($trailer -band [uint64]255) -eq 0); Value = $entry.Value; Source = (Split-Path -Leaf $Path) }
    }
  }
  return $null
}

function Get-LdbFileNumber {
  param([string]$Name)
  if ($Name -match '^(\d+)\.(log|ldb|sst)$') { return [uint64]$Matches[1] }
  return $null
}

function Get-LdbLiveTables {
  param($Manifest, $Files)
  foreach ($number in $Manifest.LiveTables) {
    $table = $Files | Where-Object { $_.Name -eq ('{0:D6}.ldb' -f $number) -or $_.Name -eq ('{0:D6}.sst' -f $number) } | Select-Object -First 1
    if (-not $table) { throw ('The database is missing table file {0:D6}.ldb.' -f $number) }
    $table
  }
}

# The manifest, the live log files checked record by record, their write batches and the
# highest sequence number in use. Nothing here depends on the database's key order.
function Get-LdbLogState {
  param([string]$Directory)
  $manifest = Read-LdbManifest $Directory
  $files = Get-ChildItem -LiteralPath $Directory -File
  $logs = @($files | Where-Object { $_.Name -like '*.log' } | ForEach-Object {
      $n = Get-LdbFileNumber $_.Name
      if ($null -ne $n -and ($n -ge $manifest.LogNumber -or $n -eq $manifest.PrevLogNumber)) {
        [pscustomobject]@{ Number = $n; File = $_ }
      }
    } | Sort-Object Number)
  $maxSequence = $manifest.LastSequence
  $logProblems = [System.Collections.Generic.List[string]]::new()
  $batches = [System.Collections.Generic.List[object]]::new()
  foreach ($log in $logs) {
    $parsed = Read-LdbLogFile ([System.IO.File]::ReadAllBytes($log.File.FullName))
    foreach ($problem in $parsed.Problems) { $logProblems.Add("$($log.File.Name): $problem") }
    foreach ($record in $parsed.Records) {
      $batch = Read-LdbWriteBatch $record
      $last = $batch.Sequence + [uint64]$batch.Count - [uint64]1
      if ($batch.Count -gt 0 -and $last -gt $maxSequence) { $maxSequence = $last }
      $batches.Add([pscustomobject]@{ Batch = $batch; Source = $log.File.Name })
    }
  }
  [pscustomobject]@{
    Manifest    = $manifest
    Files       = $files
    Logs        = $logs
    LogProblems = $logProblems
    MaxSequence = $maxSequence
    Batches     = $batches
  }
}

function Read-LdbState {
  param([string]$Directory, [byte[][]]$Keys)
  $logState = Get-LdbLogState $Directory
  $manifest = $logState.Manifest
  if ($manifest.Comparator -and $manifest.Comparator -ne 'leveldb.BytewiseComparator') {
    throw "The database uses a key order this script does not support ($($manifest.Comparator))."
  }
  $newest = @{}
  $consider = {
    param($index, $candidate)
    if ($null -eq $candidate) { return }
    $held = $newest[$index]
    if ($null -eq $held -or $candidate.Sequence -gt $held.Sequence) { $newest[$index] = $candidate }
  }
  foreach ($table in (Get-LdbLiveTables $manifest $logState.Files)) {
    for ($k = 0; $k -lt $Keys.Count; $k++) { & $consider $k (Find-LdbTableValue $table.FullName $Keys[$k]) }
  }
  foreach ($item in $logState.Batches) {
    foreach ($entry in $item.Batch.Entries) {
      for ($k = 0; $k -lt $Keys.Count; $k++) {
        if ((Compare-LdbBytes $entry.Key $entry.Key.Length $Keys[$k] $Keys[$k].Length) -eq 0) {
          & $consider $k ([pscustomobject]@{ Sequence = $entry.Sequence; Deleted = $entry.Deleted; Value = $entry.Value; Source = $item.Source })
        }
      }
    }
  }
  $values = [object[]]::new($Keys.Count)
  for ($k = 0; $k -lt $Keys.Count; $k++) {
    $v = $newest[$k]
    if ($null -ne $v -and -not $v.Deleted) { $values[$k] = $v }
  }
  [pscustomobject]@{
    Manifest    = $manifest
    Logs        = $logState.Logs
    LogProblems = $logState.LogProblems
    MaxSequence = $logState.MaxSequence
    Values      = $values
  }
}

function ConvertTo-LocalStorageKey {
  param([string]$Origin, [string]$Key)
  $stream = [System.IO.MemoryStream]::new()
  $prefix = [System.Text.Encoding]::ASCII.GetBytes('_' + $Origin)
  $stream.Write($prefix, 0, $prefix.Length)
  $stream.WriteByte(0)
  $encoded = ConvertTo-LocalStorageValue $Key
  $stream.Write($encoded, 0, $encoded.Length)
  , $stream.ToArray()
}

function ConvertFrom-LocalStorageValue {
  param([byte[]]$Bytes)
  if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return '' }
  if ($Bytes[0] -eq 0) { return [System.Text.Encoding]::Unicode.GetString($Bytes, 1, $Bytes.Length - 1) }
  if ($Bytes[0] -eq 1) { return $script:LdbLatin1.GetString($Bytes, 1, $Bytes.Length - 1) }
  throw "A browser-storage value has an unknown text format (first byte $($Bytes[0]))."
}

function ConvertTo-LocalStorageValue {
  param([string]$Text)
  $narrow = $true
  foreach ($ch in $Text.ToCharArray()) { if ([int]$ch -gt 255) { $narrow = $false; break } }
  if ($narrow) { $body = $script:LdbLatin1.GetBytes($Text); $format = [byte]1 }
  else { $body = [System.Text.Encoding]::Unicode.GetBytes($Text); $format = [byte]0 }
  $bytes = [byte[]]::new($body.Length + 1)
  $bytes[0] = $format
  [Array]::Copy($body, 0, $bytes, 1, $body.Length)
  , $bytes
}
