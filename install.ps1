param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\Claudex'),
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if ($source -eq $destination -or $destination -eq [IO.Path]::GetPathRoot($destination).TrimEnd('\')) {
    throw '请选择与解压目录不同的应用安装目录。'
}
if (-not (Test-Path -LiteralPath (Join-Path $source 'runtime\node.exe'))) {
    throw '请使用完整的 Windows 发布包安装。源码请先执行 launch\build.ps1。'
}
$parent = Split-Path -Parent $destination
$leaf = Split-Path -Leaf $destination
if (Test-Path -LiteralPath $destination) {
    if ((Get-Item -LiteralPath $destination).LinkType -or
        -not (Test-Path -LiteralPath (Join-Path $destination 'claudex-install.json'))) {
        throw '目标目录已有其他文件，请选择空目录。'
    }
}
$mutex = New-Object Threading.Mutex($false, 'Local\ClaudexInstaller')
$locked = $false
$stage = Join-Path $parent ($leaf + '.install-' + [Guid]::NewGuid().ToString('N'))
$previous = Join-Path $parent ($leaf + '.previous-' + [Guid]::NewGuid().ToString('N'))
$installed = $false
$replaced = $false
try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { throw '另一个 Claudex 安装过程正在运行。' }
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    if ((Get-Item -LiteralPath $parent).LinkType) { throw '安装父目录包含文件系统链接。' }
    New-Item -ItemType Directory -Path $stage | Out-Null
    $entries = @('app','server','runtime','launch','Claudex.exe','Claudex.cmd','启动Claudex.vbs','停止Claudex.cmd','安装Claudex.cmd','README.md','package.json','LICENSE','THIRD_PARTY_NOTICES.md')
    if (Test-Path -LiteralPath (Join-Path $source 'assets')) { $entries += 'assets' }
    foreach ($entry in $entries) {
        $origin = Join-Path $source $entry
        if ((Get-Item -LiteralPath $origin).LinkType) { throw '发布文件含文件系统链接。' }
        Copy-Item -LiteralPath $origin -Destination (Join-Path $stage $entry) -Recurse
    }
    foreach ($file in (Get-ChildItem -LiteralPath $stage -Recurse -File)) {
        if ($file.LinkType) { throw '发布文件含文件系统链接。' }
        $relative = $file.FullName.Substring($stage.Length + 1)
        if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath (Join-Path $source $relative)).Hash) {
            throw ('安装文件校验失败 ' + $relative)
        }
    }
    $health = $null
    try { $health = Invoke-RestMethod 'http://127.0.0.1:4317/api/health' -TimeoutSec 2 } catch { }
    if ($health) {
        if ($health.app -ne 'Claudex' -or $health.root -ne $destination) {
            throw '请先停止另一目录正在运行的 Claudex，再安装。'
        }
        $stop = Join-Path $destination 'launch\stop.ps1'
        $child = Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $stop + '"') -WindowStyle Hidden -PassThru -Wait
        if ($child.ExitCode -ne 0) { throw '旧版本后台未能停止。' }
    }
    $version = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $stage 'package.json') | ConvertFrom-Json).version
    @{app='Claudex';version=$version;installedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $stage 'claudex-install.json')
    # Both moves stay in the validated parent directory. Keep the prior version for recovery.
    if (Test-Path -LiteralPath $destination) {
        Move-Item -LiteralPath $destination -Destination $previous
        $replaced = $true
    }
    Move-Item -LiteralPath $stage -Destination $destination
    $installed = $true
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claudex.lnk'))
    $link.TargetPath = Join-Path $destination 'Claudex.exe'
    $link.WorkingDirectory = $destination
    $link.Arguments = ''
    $link.Description = '打开 Claudex'
    $link.IconLocation = (Join-Path $destination 'app\icon-hourglass.ico') + ',0'
    $link.Save()
    if (-not $NoOpen) { Start-Process -FilePath (Join-Path $destination 'Claudex.exe') -WorkingDirectory $destination }
    Write-Output ('Claudex ' + $version + ' 已安装到 ' + $destination)
} catch {
    if ($installed -and $replaced) {
        # Preserve the failed new version and restore the previous installation.
        Move-Item -LiteralPath $destination -Destination $stage
        Move-Item -LiteralPath $previous -Destination $destination
    } elseif ($replaced -and -not (Test-Path -LiteralPath $destination)) {
        Move-Item -LiteralPath $previous -Destination $destination
    }
    throw
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

