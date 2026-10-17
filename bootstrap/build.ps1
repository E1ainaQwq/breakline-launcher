param(
  [Parameter(Mandatory=$true)][string]$Libraries,
  [string]$Jdk = $env:JAVA_HOME,
  [string]$ForgeVersion = '1.20.1-47.4.13',
  [string]$Artwork = ''
)
$ErrorActionPreference='Stop'
if (-not $Artwork) { $Artwork = Join-Path $PSScriptRoot 'assets\delta-loading.png' }
if (-not $Jdk) { throw 'Set JAVA_HOME or pass -Jdk for Java 17 JDK' }
$taskRoot=Split-Path $PSScriptRoot -Parent
$gpu=Get-ChildItem (Join-Path $Libraries 'org\lwjgl') -Recurse -Filter '*.jar' | Where-Object {$_.Name -match '^lwjgl(-opengl)?-3\.3\.1\.jar$'}
$classpath=(@($gpu.FullName)+@(Join-Path $Libraries "net\minecraftforge\fmlloader\$ForgeVersion\fmlloader-$ForgeVersion.jar")+@(Join-Path $Libraries "net\minecraftforge\fmlearlydisplay\$ForgeVersion\fmlearlydisplay-$ForgeVersion.jar")) -join ';'
$classes=Join-Path $PSScriptRoot 'build/classes'
New-Item -ItemType Directory -Force "$classes/META-INF/services" | Out-Null
& "$Jdk/bin/javac.exe" -encoding UTF-8 -cp $classpath -d $classes "$PSScriptRoot/src/cn/delta/bootstrap/DeltaEarlyWindow.java" "$PSScriptRoot/src/cn/delta/bootstrap/DeltaEarlyArt.java"
if($LASTEXITCODE -ne 0){throw 'Bootstrap compilation failed'}
$utf8=New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText("$classes/META-INF/services/net.minecraftforge.fml.loading.ImmediateWindowProvider","cn.delta.bootstrap.DeltaEarlyWindow`n",$utf8)
Copy-Item -LiteralPath $Artwork -Destination "$classes/delta-loading.png"
$manifest=Join-Path $PSScriptRoot 'build/MANIFEST.MF'
[IO.File]::WriteAllText($manifest,"Manifest-Version: 1.0`nAutomatic-Module-Name: cn.delta.earlywindow`n`n",$utf8)
& "$Jdk/bin/jar.exe" --create --file "$taskRoot/config/delta-early-window.jar" --manifest $manifest -C $classes .
if($LASTEXITCODE -ne 0){throw 'Bootstrap packaging failed'}
Get-FileHash "$taskRoot/config/delta-early-window.jar" -Algorithm SHA256
