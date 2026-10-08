<#
  check-shared-textread.ps1 - checks that Read-TextFile in a tool folder's session-restore.ps1
  reads a file another program has open for writing, and leaves it free to be replaced: the app
  rewrites its settings file and its chat entries while it runs, and -Sidebar reads them then.

    powershell -NoProfile -ExecutionPolicy Bypass -File check-shared-textread.ps1 -Tool <tool folder>

  Its control, [System.IO.File]::ReadAllText, must fail the first case, or the check fails: a
  reader that does not share the file for writing cannot open it while a writer holds it.
  It works on a scratch file in the temp folder and removes it.
#>
param([Parameter(Mandatory = $true)][string]$Tool)
$ErrorActionPreference = 'Stop'
$source = [System.IO.File]::ReadAllText((Join-Path $Tool 'session-restore.ps1'))
$match = [regex]::Match($source, '(?ms)^function Read-TextFile\(.*?^\}')
if (-not $match.Success) { Write-Host '  FAIL the script has no function Read-TextFile'; exit 1 }
$utf8 = New-Object System.Text.UTF8Encoding($false)
Invoke-Expression $match.Value
$fails = 0
function Test-Case([bool]$Ok, [string]$Message) { if ($Ok) { Write-Host "  ok   $Message" } else { Write-Host "  FAIL $Message"; $script:fails++ } }

$file = Join-Path ([System.IO.Path]::GetTempPath()) ('check-shared-textread-' + [guid]::NewGuid().ToString('N') + '.json')
$text = '{"a":"' + [char]0x00E9 + '","b":[1,2,3]}'
[System.IO.File]::WriteAllText($file, $text, $utf8)
try {
  $writer = [System.IO.File]::Open($file, 'Open', 'ReadWrite', 'ReadWrite, Delete')
  try {
    $got = $null; $problem = $null
    try { $got = Read-TextFile $file } catch { $problem = $_.Exception.Message }
    Test-Case ($got -ceq $text) "Read-TextFile reads the file while another handle has it open for writing$(if ($problem) { ' (' + $problem + ')' })"
    $controlFailed = $false
    try { [void][System.IO.File]::ReadAllText($file) } catch { $controlFailed = $true }
    Test-Case $controlFailed 'control: ReadAllText cannot open it then'
  } finally { $writer.Dispose() }
  $other = $file + '.new'
  [System.IO.File]::WriteAllText($other, '{}', $utf8)
  [void](Read-TextFile $file)
  $replaced = $true
  try { [System.IO.File]::Replace($other, $file, [NullString]::Value) } catch { $replaced = $false }
  Test-Case ($replaced -and ((Read-TextFile $file) -ceq '{}')) 'after a read, the file can be replaced by another, as the app replaces its files'
  [System.IO.File]::WriteAllBytes($file, [byte[]](0xEF, 0xBB, 0xBF) + $utf8.GetBytes($text))
  Test-Case ((Read-TextFile $file) -ceq $text) 'a byte-order mark at the start of a file is not part of what is read'
} finally {
  foreach ($leftover in @($file, ($file + '.new'))) { if (Test-Path -LiteralPath $leftover) { [System.IO.File]::Delete($leftover) } }
}
if ($fails -eq 0) { Write-Host 'SHARED TEXT READ CHECK CLEAN'; exit 0 } else { Write-Host "SHARED TEXT READ CHECK FAILED: $fails"; exit 1 }
