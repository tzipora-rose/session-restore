<#
  JsJson.ps1 - read and write JSON the way JavaScript's JSON.stringify writes it.

  Windows PowerShell 5.1's ConvertFrom-Json rejects objects whose keys differ only in letter
  case, which the Claude app's files can legitimately contain (folder paths used as keys), and
  its ConvertTo-Json re-escapes and re-indents everything it writes. These functions parse with
  .NET's JavaScriptSerializer (case-sensitive keys, key order kept) and write the way
  JSON.stringify does, so a value that was not changed is written back byte for byte.
#>

Add-Type -AssemblyName System.Web.Extensions

function ConvertFrom-JsJson {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
  $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $serializer.MaxJsonLength = [int]::MaxValue
  $serializer.RecursionLimit = 1000
  , $serializer.DeserializeObject($Text)
}

function New-JsObject {
  , (New-Object 'System.Collections.Generic.Dictionary[string,object]')
}

function Test-JsKey {
  param([Parameter(Mandatory = $true)]$Object, [Parameter(Mandatory = $true)][string]$Key)
  if ($Object -is [System.Collections.Generic.IDictionary[string, object]]) { return $Object.ContainsKey($Key) }
  return $Object.Contains($Key)
}

function Get-JsMember {
  param([AllowNull()]$Object, [Parameter(Mandatory = $true)][string]$Key)
  if ($Object -is [System.Collections.IDictionary] -and (Test-JsKey $Object $Key)) { return , $Object[$Key] }
  return $null
}

# The items of a list member, one by one, so the caller's @(...) collects them. Get-JsMember
# hands a list back whole; wrapping that in @(...) would nest it inside a second list.
function Get-JsList {
  param([AllowNull()]$Object, [Parameter(Mandatory = $true)][string]$Key)
  $value = Get-JsMember $Object $Key
  if ($value -is [System.Collections.IList]) { foreach ($item in $value) { , $item } }
}

function ConvertTo-JsJson {
  param([AllowNull()]$Value, [int]$Indent = 0)
  $builder = New-Object System.Text.StringBuilder
  Add-JsJsonValue -Builder $builder -Value $Value -Indent $Indent -Level 0
  $builder.ToString()
}

function Add-JsJsonValue {
  param([System.Text.StringBuilder]$Builder, [AllowNull()]$Value, [int]$Indent, [int]$Level)
  if ($null -eq $Value) { [void]$Builder.Append('null'); return }
  if ($Value -is [string]) { Add-JsJsonString -Builder $Builder -Text $Value; return }
  if ($Value -is [bool]) { if ($Value) { [void]$Builder.Append('true') } else { [void]$Builder.Append('false') }; return }
  if ($Value -is [System.Collections.IDictionary]) {
    if ($Value.Count -eq 0) { [void]$Builder.Append('{}'); return }
    [void]$Builder.Append('{')
    $first = $true
    foreach ($key in @($Value.Keys)) {
      if (-not $first) { [void]$Builder.Append(',') }
      $first = $false
      if ($Indent -gt 0) { [void]$Builder.Append("`n").Append([char]32, $Indent * ($Level + 1)) }
      Add-JsJsonString -Builder $Builder -Text ([string]$key)
      if ($Indent -gt 0) { [void]$Builder.Append(': ') } else { [void]$Builder.Append(':') }
      Add-JsJsonValue -Builder $Builder -Value $Value[$key] -Indent $Indent -Level ($Level + 1)
    }
    if ($Indent -gt 0) { [void]$Builder.Append("`n").Append([char]32, $Indent * $Level) }
    [void]$Builder.Append('}')
    return
  }
  if ($Value -is [System.Collections.IList]) {
    if ($Value.Count -eq 0) { [void]$Builder.Append('[]'); return }
    [void]$Builder.Append('[')
    for ($i = 0; $i -lt $Value.Count; $i++) {
      if ($i -gt 0) { [void]$Builder.Append(',') }
      if ($Indent -gt 0) { [void]$Builder.Append("`n").Append([char]32, $Indent * ($Level + 1)) }
      Add-JsJsonValue -Builder $Builder -Value $Value[$i] -Indent $Indent -Level ($Level + 1)
    }
    if ($Indent -gt 0) { [void]$Builder.Append("`n").Append([char]32, $Indent * $Level) }
    [void]$Builder.Append(']')
    return
  }
  $invariant = [System.Globalization.CultureInfo]::InvariantCulture
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte] -or
      $Value -is [uint32] -or $Value -is [uint64] -or $Value -is [uint16] -or $Value -is [sbyte]) {
    [void]$Builder.Append($Value.ToString($invariant)); return
  }
  if ($Value -is [decimal]) { [void]$Builder.Append($Value.ToString('G29', $invariant)); return }
  if ($Value -is [double] -or $Value -is [single]) {
    if ([double]::IsNaN($Value) -or [double]::IsInfinity($Value)) { [void]$Builder.Append('null'); return }
    [void]$Builder.Append(([double]$Value).ToString('R', $invariant)); return
  }
  throw ("Cannot write a value of type {0} as JSON." -f $Value.GetType().FullName)
}

function Add-JsJsonString {
  param([System.Text.StringBuilder]$Builder, [string]$Text)
  [void]$Builder.Append('"')
  for ($i = 0; $i -lt $Text.Length; $i++) {
    $code = [int]$Text[$i]
    if ($code -eq 34) { [void]$Builder.Append('\"') }
    elseif ($code -eq 92) { [void]$Builder.Append('\\') }
    elseif ($code -eq 8) { [void]$Builder.Append('\b') }
    elseif ($code -eq 9) { [void]$Builder.Append('\t') }
    elseif ($code -eq 10) { [void]$Builder.Append('\n') }
    elseif ($code -eq 12) { [void]$Builder.Append('\f') }
    elseif ($code -eq 13) { [void]$Builder.Append('\r') }
    elseif ($code -lt 32) { [void]$Builder.Append('\u').Append($code.ToString('x4')) }
    elseif ($code -ge 0xD800 -and $code -le 0xDBFF -and ($i + 1) -lt $Text.Length -and
            [int]$Text[$i + 1] -ge 0xDC00 -and [int]$Text[$i + 1] -le 0xDFFF) {
      [void]$Builder.Append($Text[$i]).Append($Text[$i + 1]); $i++
    }
    elseif ($code -ge 0xD800 -and $code -le 0xDFFF) { [void]$Builder.Append('\u').Append($code.ToString('x4')) }
    else { [void]$Builder.Append($Text[$i]) }
  }
  [void]$Builder.Append('"')
}

function Copy-JsValue {
  param([AllowNull()]$Value)
  if ($null -eq $Value) { return $null }
  , (ConvertFrom-JsJson (ConvertTo-JsJson $Value))
}

function Get-JsPath {
  param([string]$Parent, [string]$Key)
  $Parent + '[' + (ConvertTo-JsJson $Key) + ']'
}

function Compare-JsJson {
  param([AllowNull()]$Left, [AllowNull()]$Right, [string]$Path = '$')
  $differences = New-Object System.Collections.Generic.List[string]
  Add-JsJsonDifference -Left $Left -Right $Right -Path $Path -Differences $differences
  , $differences.ToArray()
}

function Add-JsJsonDifference {
  param([AllowNull()]$Left, [AllowNull()]$Right, [string]$Path, [System.Collections.Generic.List[string]]$Differences)
  if ($null -eq $Left -and $null -eq $Right) { return }
  if ($null -eq $Left -or $null -eq $Right) { $Differences.Add($Path); return }
  $leftIsObject = $Left -is [System.Collections.IDictionary]
  $rightIsObject = $Right -is [System.Collections.IDictionary]
  if ($leftIsObject -or $rightIsObject) {
    if (-not ($leftIsObject -and $rightIsObject)) { $Differences.Add($Path); return }
    foreach ($key in @($Left.Keys)) {
      $child = Get-JsPath $Path ([string]$key)
      if (-not (Test-JsKey $Right ([string]$key))) { $Differences.Add($child); continue }
      Add-JsJsonDifference -Left $Left[$key] -Right $Right[$key] -Path $child -Differences $Differences
    }
    foreach ($key in @($Right.Keys)) {
      if (-not (Test-JsKey $Left ([string]$key))) { $Differences.Add((Get-JsPath $Path ([string]$key))) }
    }
    return
  }
  $leftIsText = $Left -is [string]
  $rightIsText = $Right -is [string]
  if ($leftIsText -or $rightIsText) {
    if (-not ($leftIsText -and $rightIsText) -or -not [string]::Equals($Left, $Right, [System.StringComparison]::Ordinal)) { $Differences.Add($Path) }
    return
  }
  $leftIsList = $Left -is [System.Collections.IList]
  $rightIsList = $Right -is [System.Collections.IList]
  if ($leftIsList -or $rightIsList) {
    if (-not ($leftIsList -and $rightIsList) -or $Left.Count -ne $Right.Count) { $Differences.Add($Path); return }
    for ($i = 0; $i -lt $Left.Count; $i++) {
      Add-JsJsonDifference -Left $Left[$i] -Right $Right[$i] -Path ('{0}[{1}]' -f $Path, $i) -Differences $Differences
    }
    return
  }
  if ($Left -is [bool] -or $Right -is [bool]) {
    if (-not ($Left -is [bool] -and $Right -is [bool]) -or $Left -ne $Right) { $Differences.Add($Path) }
    return
  }
  try { $same = ([decimal]$Left -eq [decimal]$Right) } catch { $same = ([double]$Left -eq [double]$Right) }
  if (-not $same) { $Differences.Add($Path) }
}

function Test-JsChangeConfined {
  param([AllowNull()]$Before, [AllowNull()]$After, [string[]]$AllowedPaths, [ref]$Unexpected)
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($difference in (Compare-JsJson -Left $Before -Right $After)) {
    $allowed = $false
    foreach ($root in $AllowedPaths) {
      if ($difference -eq $root -or $difference.StartsWith($root + '[')) { $allowed = $true; break }
    }
    if (-not $allowed) { $found.Add($difference) }
  }
  if ($Unexpected) { $Unexpected.Value = $found.ToArray() }
  return ($found.Count -eq 0)
}
