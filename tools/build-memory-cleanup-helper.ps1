$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw "Built-in .NET Framework compiler missing: $compiler" }
$out = Join-Path $root 'resources\memory-cleanup-helper.exe'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null
& $compiler /nologo /target:exe /optimize+ "/out:$out" "/win32manifest:$(Join-Path $root 'build\memory-cleanup\MemoryCleanup.manifest')" (Join-Path $root 'build\memory-cleanup\MemoryCleanup.cs')
if ($LASTEXITCODE -ne 0) { throw "Helper compile failed with code $LASTEXITCODE" }
Get-Item -LiteralPath $out | Select-Object FullName, Length
