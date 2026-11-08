param([string]$NodeDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($NodeDirectory)) { $NodeDirectory = Join-Path $root 'runtime' }
$node = Join-Path $NodeDirectory 'node.exe'
$license = Join-Path $NodeDirectory 'LICENSE'
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $license)) {
    throw '请用 -NodeDirectory 指定同时含 node.exe 和 LICENSE 的官方 Node.js Windows 解压目录。'
}
$version = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw '需要 Node.js 22 或更高版本。' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '没有找到 Windows .NET Framework C# 编译器。' }
$package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json
$dist = Join-Path $root 'dist'
$stageParent = Join-Path $dist ('stage-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $stageParent 'Claudex'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$entries = @('app','server','launch','Claudex.cmd','启动Claudex.vbs','停止Claudex.cmd','安装Claudex.cmd','README.md','package.json','LICENSE','THIRD_PARTY_NOTICES.md')
if (Test-Path -LiteralPath (Join-Path $root 'assets')) { $entries += 'assets' }
foreach ($entry in $entries) { Copy-Item -LiteralPath (Join-Path $root $entry) -Destination (Join-Path $stage $entry) -Recurse }
New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $stage 'runtime\node.exe')
Copy-Item -LiteralPath $license -Destination (Join-Path $stage 'runtime\LICENSE')
Push-Location $stage
try {
    & $compiler /nologo /target:winexe /utf8output /codepage:65001 /optimize+ /reference:System.Windows.Forms.dll /win32icon:app\icon-hourglass.ico /out:Claudex.exe launch\Claudex.cs
    if ($LASTEXITCODE -ne 0) { throw 'Claudex.exe 编译失败。' }
} finally { Pop-Location }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$name = 'Claudex-Windows-' + $package.version + '.zip'
$temporaryZip = Join-Path $stageParent $name
$zip = Join-Path $dist $name
[IO.Compression.ZipFile]::CreateFromDirectory($stage,$temporaryZip,[IO.Compression.CompressionLevel]::Optimal,$true)
Move-Item -LiteralPath $temporaryZip -Destination $zip -Force
$resolvedStage = (Resolve-Path -LiteralPath $stageParent).Path
$resolvedDist = (Resolve-Path -LiteralPath $dist).Path
if ($resolvedStage.StartsWith($resolvedDist + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path -Leaf $resolvedStage).StartsWith('stage-')) {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
[pscustomobject]@{Zip=$zip;SHA256=(Get-FileHash -LiteralPath $zip).Hash;Node=$version} | ConvertTo-Json

