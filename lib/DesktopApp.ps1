<#
  DesktopApp.ps1 - where the Claude desktop app keeps its data, whether it is running, and whether
  this script was started from Explorer.

  The app is installed in one of two ways, and keeps its data accordingly:
    - the packaged (MSIX) app: in its package folder,
      AppData\Local\Packages\Claude_<suffix>\LocalCache\Roaming\Claude. A program outside the app
      cannot reach it as AppData\Roaming\Claude: that path is an alias only the app's own
      programs see.
    - an unpackaged (Squirrel) install, its program in AppData\Local\AnthropicClaude\app-<version>:
      in AppData\Roaming\Claude itself. So does a packaged app installed over one: its package
      folder then has no LocalCache\Roaming\Claude, and the app logs "likely Squirrel upgrade".
  Read in the app's own code, desktop app 2.26454.2.0.
#>

# The folder the app's Code sessions are in, decided as the app decides it: a package folder's
# LocalCache\Roaming\Claude when one exists, else AppData\Roaming\Claude. Gives the folder (Root),
# the names of the app's package folders, which are its package family names (for telling whether
# it is running), and, when there is no folder to use, why (Problem).
function Find-AppData([string]$UserProfile) {
  $result = [pscustomobject]@{ Root = $null; PackageFamilies = @(); Problem = $null }
  $packages = @(Get-ChildItem -LiteralPath (Join-Path $UserProfile 'AppData\Local\Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue | Sort-Object Name)
  $result.PackageFamilies = [string[]]@($packages | ForEach-Object { $_.Name })
  $packaged = @($packages | ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Claude' } | Where-Object { Test-Path -LiteralPath $_ -PathType Container })
  $roaming = Join-Path $UserProfile 'AppData\Roaming\Claude'
  foreach ($folder in $packaged) {
    if (Test-Path -LiteralPath (Join-Path $folder 'claude-code-sessions') -PathType Container) { $result.Root = $folder; return $result }
  }
  $roamingHasSessions = Test-Path -LiteralPath (Join-Path $roaming 'claude-code-sessions') -PathType Container
  if ($packaged.Count -gt 0) {
    # the packaged app uses its own folder, so a folder an unpackaged install left is not its data
    $result.Problem = ('the packaged app''s data folder, {0}, holds no claude-code-sessions folder, so the app has not run a session in its Code tab.' -f $packaged[0])
    if ($roamingHasSessions) { $result.Problem += (' {0} holds the Code sessions of an unpackaged install, which this script does not use while the packaged app has a data folder of its own.' -f $roaming) }
    return $result
  }
  if ($roamingHasSessions) { $result.Root = $roaming; return $result }
  $result.Problem = ('neither the packaged app''s data folder (AppData\Local\Packages\Claude_<suffix>\LocalCache\Roaming\Claude) nor an unpackaged install''s ({0}) holds a claude-code-sessions folder. Is the desktop app installed, and has it run a session in its Code tab?' -f $roaming)
  $result
}

# Reads the program a process runs with QueryFullProcessImageName, which asks only for
# PROCESS_QUERY_LIMITED_INFORMATION: Windows grants that across integrity levels, so a console
# that is not elevated can read the program of an app that is. Process.Path cannot: it reads the
# process's modules, which needs more. Compiled the first time it is needed; $false when that is
# not allowed here.
function Initialize-ProgramPath {
  if ('SessionRestore.ProgramPath' -as [type]) { return $true }
  $source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace SessionRestore {
  public static class ProgramPath {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    public static string Of(int processId) {
      IntPtr process = OpenProcess(0x1000, false, processId);
      if (process == IntPtr.Zero) return null;
      try {
        StringBuilder name = new StringBuilder(32768);
        int size = name.Capacity;
        return QueryFullProcessImageName(process, 0, name, ref size) ? name.ToString(0, size) : null;
      } finally { CloseHandle(process); }
    }
  }
}
'@
  try { Add-Type -TypeDefinition $source -ErrorAction Stop; return $true } catch { return $false }
}

# The folders the app's programs run from: each installed package's install folder, for the
# given package families, and an unpackaged install's folder.
function Get-AppProgramRoots([string[]]$PackageFamilies, [string]$UnpackagedInstall) {
  $roots = New-Object System.Collections.Generic.List[string]
  if (@($PackageFamilies).Count -gt 0) {
    try {
      foreach ($package in @(Get-AppxPackage -ErrorAction Stop | Where-Object { $PackageFamilies -contains $_.PackageFamilyName })) {
        if ($package.InstallLocation) { $roots.Add([string]$package.InstallLocation) }
      }
    } catch { }
  }
  if ($UnpackagedInstall) { $roots.Add($UnpackagedInstall) }
  , $roots.ToArray()
}

# The app's processes in this Windows session: those whose program is in one of the given
# folders. Other sessions' processes are left out, and with them the packaged app's
# CoworkVMService, which runs from its install folder all the time, in session 0, whether the app
# is open or not. Where QueryFullProcessImageName cannot be compiled, Process.Path is used, which
# does not see an app that runs with more rights than this script.
function Get-AppProcesses([string[]]$Roots) {
  $found = New-Object System.Collections.Generic.List[object]
  $prefixes = @($Roots | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') + '\' })
  if ($prefixes.Count -eq 0) { return , $found.ToArray() }
  $limited = Initialize-ProgramPath
  $session = (Get-Process -Id $PID).SessionId
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    if ($process.SessionId -ne $session) { continue }
    $program = $null
    if ($limited) { $program = [SessionRestore.ProgramPath]::Of($process.Id) }
    else { try { $program = $process.Path } catch { } }
    if (-not $program) { continue }
    foreach ($prefix in $prefixes) {
      if ($program.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $found.Add([pscustomobject]@{ Id = $process.Id; Program = $program })
        break
      }
    }
  }
  , $found.ToArray()
}

# Why the app counts as running, or nothing: its processes in this Windows session, and each
# storage folder whose lock file another program holds open, as the app does while it runs.
function Get-AppActivity([string[]]$Roots, [string[]]$StorageDirs) {
  $reasons = New-Object System.Collections.Generic.List[string]
  # (assigned, not wrapped in @(...): the function hands back one array, which @(...) would nest)
  $running = Get-AppProcesses $Roots
  if ($running.Count -gt 0) { $reasons.Add(('{0} of its processes are running' -f $running.Count)) }
  foreach ($dir in $StorageDirs) {
    $lock = Join-Path $dir 'LOCK'
    if (Test-Path -LiteralPath $lock) {
      try { $handle = [System.IO.File]::Open($lock, 'Open', 'ReadWrite', 'None'); $handle.Dispose() }
      catch { $reasons.Add(('its storage folder {0} is in use' -f (Split-Path -Leaf (Split-Path -Parent $lock)))) }
    }
  }
  , $reasons.ToArray()
}

# Whether this PowerShell was started to run the script and ends with it: its command line names
# the script's file and carries no -NoExit, which PowerShell takes in any abbreviation down to
# -noe, with or without quotes around it. A PowerShell window opened from the Start menu or the
# taskbar has a command line naming no script, even when a script is then typed into it.
function Test-LaunchedForScript([string]$CommandLine, [string]$ScriptName) {
  if (-not $CommandLine -or -not $ScriptName) { return $false }
  if ($CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  return -not ($CommandLine -match '(?i)(^|\s)"?[-/]noe(x(i(t)?)?)?"?(\s|$)')
}

# The name of the process that started this one, such as "explorer", or $null when it cannot be
# read or is no longer the process that started this one.
function Get-ParentProcessName {
  try {
    $self = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $PID) -ErrorAction Stop
    $parent = Get-Process -Id ([int]$self.ParentProcessId) -ErrorAction Stop
    if ($parent.StartTime -gt (Get-Process -Id $PID).StartTime) { return $null }
    return $parent.ProcessName
  } catch { return $null }
}
