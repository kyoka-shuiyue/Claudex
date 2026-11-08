param(
    [ValidateRange(1, 65535)]
    [int]$Port = 4317,
    [switch]$PassThru
)

$ErrorActionPreference = 'Stop'

function Find-EgoBrowser {
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    $command = Get-Command ego-browser -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
        $directory = Get-Item -LiteralPath (Split-Path -Parent $command.Source) -Force
        if ($directory.Target) {
            $versionDirectory = @($directory.Target)[0]
            [void]$candidates.Add((Join-Path (Split-Path -Parent $versionDirectory) 'ego.exe'))
        }
        [void]$candidates.Add((Join-Path (Split-Path -Parent $directory.FullName) 'ego.exe'))
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if (-not [string]::IsNullOrWhiteSpace($base)) {
            [void]$candidates.Add((Join-Path $base 'Citro Labs\ego lite\Application\ego.exe'))
        }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw '没有找到 Ego Lite 浏览器。请先安装 Ego Lite，再启动 Claudex。'
}

$browser = Find-EgoBrowser
$token = [Guid]::NewGuid().ToString('N')
$expectedTitle = "Claudex [$token]"
Start-Process -FilePath $browser -ArgumentList "--app=http://127.0.0.1:$Port/#launch-$token" | Out-Null

# Sizing is best effort: the page must remain usable if Windows or Ego cannot
# expose its window. Only the unpredictable, exact title identifies this launch.
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClaudexEgoWindowFit {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr FindWindow(string cls, string title);
    public static IntPtr FindByTitle(string title) { return FindWindow(null, title); }
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
    try { [void][ClaudexEgoWindowFit]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { [void][ClaudexEgoWindowFit]::SetProcessDPIAware() }
    Add-Type -AssemblyName System.Windows.Forms
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $hwnd = [IntPtr]::Zero
    while ([DateTime]::UtcNow -lt $deadline) {
        $hwnd = [ClaudexEgoWindowFit]::FindByTitle($expectedTitle)
        if ($hwnd -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($hwnd -eq [IntPtr]::Zero) {
        if ($PassThru) { [pscustomobject]@{ Handle = 0; Token = $token; Error = '未找到启动窗口。' } }
        return
    }
    $windowPid = [uint32]0
    [void][ClaudexEgoWindowFit]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
    $windowProcess = Get-Process -Id $windowPid -ErrorAction Stop
    if (-not [string]::Equals([IO.Path]::GetFullPath($windowProcess.Path), [IO.Path]::GetFullPath($browser), [StringComparison]::OrdinalIgnoreCase)) {
        if ($PassThru) { [pscustomobject]@{ Handle = 0; Token = $token; Error = '窗口进程与 Ego 不匹配。' } }
        return
    }
    $area = [Windows.Forms.Screen]::FromHandle($hwnd).WorkingArea
    try { $dpi = [ClaudexEgoWindowFit]::GetDpiForWindow($hwnd) } catch { $dpi = 96 }
    if ($dpi -lt 48) { $dpi = 96 }
    $targetWidth = [int][Math]::Round(1680 * $dpi / 96.0)
    $targetHeight = [int][Math]::Round(1080 * $dpi / 96.0)
    $width = [Math]::Min($targetWidth, $area.Width)
    $height = [Math]::Min($targetHeight, $area.Height)
    $left = $area.Left + [int][Math]::Floor(($area.Width - $width) / 2.0)
    $top = $area.Top + [int][Math]::Floor(($area.Height - $height) / 2.0)
    $method = 'position'
    if ($area.Width -le $targetWidth -and $area.Height -le $targetHeight -and [ClaudexEgoWindowFit]::GetForegroundWindow() -eq $hwnd) {
        # SW_MAXIMIZE activates its target, so use it only if already active.
        [void][ClaudexEgoWindowFit]::ShowWindow($hwnd, 3)
        $method = 'maximize'
    } else {
        # SWP_NOZORDER | SWP_NOACTIVATE
        if (-not [ClaudexEgoWindowFit]::SetWindowPos($hwnd, [IntPtr]::Zero, $left, $top, $width, $height, 0x14)) { return }
    }
    if ($PassThru) {
        [pscustomobject]@{ Handle = $hwnd.ToInt64(); Token = $token; Method = $method; Dpi = $dpi; WorkWidth = $area.Width; WorkHeight = $area.Height; TargetWidth = $width; TargetHeight = $height }
    }
} catch {
    # Never close the newly opened app when optional window fitting fails.
    if ($PassThru) { [pscustomobject]@{ Handle = 0; Token = $token; Error = $_.Exception.Message } }
}
