$ErrorActionPreference = "Stop"

$python = "C:\Python312\python.exe"
$node = "C:\Program Files\nodejs\node.exe"
$rustc = "C:\Rust\.cargo\bin\rustc.exe"
$ffmpeg = "C:\Program Files\ffmpeg\bin\ffmpeg.exe"
$vcVars = "C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

function Get-PeMachine {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    return "{0:X4}" -f [BitConverter]::ToUInt16($bytes, $peOffset + 4)
}

foreach ($path in @($python, $node, $rustc, $ffmpeg, $vcVars)) {
    if (-not (Test-Path $path)) {
        throw "Required tool is missing: $path"
    }
}

$pythonInfo = & $python -c @"
import platform
import struct
import encodings
import pip
print('PYTHON=' + platform.python_version() + ';BITS=' + str(struct.calcsize('P') * 8) + ';MACHINE=' + platform.machine())
"@
if ($LASTEXITCODE -ne 0 -or $pythonInfo -notmatch "BITS=64") {
    throw "Python x64 validation failed: $pythonInfo"
}
$pythonMachine = Get-PeMachine $python
if ($pythonMachine -ne "8664") {
    throw "Python executable is not x64 PE (machine=$pythonMachine)"
}
Write-Output "$pythonInfo;PE_MACHINE=$pythonMachine"

$nodeInfo = & $node -p "'NODE=' + process.version + ';ARCH=' + process.arch"
if ($LASTEXITCODE -ne 0 -or $nodeInfo -notmatch "ARCH=x64") {
    throw "Node.js x64 validation failed: $nodeInfo"
}
$nodeMachine = Get-PeMachine $node
if ($nodeMachine -ne "8664") {
    throw "Node.js executable is not x64 PE (machine=$nodeMachine)"
}
Write-Output "$nodeInfo;PE_MACHINE=$nodeMachine"

$rustInfo = & $rustc -vV
$rustText = $rustInfo -join "`n"
if ($LASTEXITCODE -ne 0 -or $rustText -notmatch "host: x86_64-pc-windows-msvc") {
    throw "Rust x64 MSVC validation failed: $rustInfo"
}
$rustMachine = Get-PeMachine $rustc
if ($rustMachine -ne "8664") {
    throw "rustc executable is not x64 PE (machine=$rustMachine)"
}
$rustInfo | Select-String "rustc |host:"
Write-Output "RUST_PE_MACHINE=$rustMachine"

$ffmpegInfo = & $ffmpeg -version 2>&1 | Select-Object -First 1
if ($LASTEXITCODE -ne 0 -or $ffmpegInfo -notmatch "^ffmpeg version") {
    throw "FFmpeg validation failed: $ffmpegInfo"
}
$ffmpegMachine = Get-PeMachine $ffmpeg
if ($ffmpegMachine -ne "8664") {
    throw "FFmpeg executable is not x64 PE (machine=$ffmpegMachine)"
}
Write-Output "$ffmpegInfo;PE_MACHINE=$ffmpegMachine"

$msvcInfo = cmd.exe /d /s /c (
    '"' + $vcVars + '" >nul && cl 2>&1'
)
$msvcText = $msvcInfo -join "`n"
if ($LASTEXITCODE -ne 0 -or $msvcText -notmatch "x64") {
    throw "MSVC x64 validation failed: $msvcInfo"
}
$msvcInfo | Select-Object -First 3

Write-Output "TOOLCHAIN_VALIDATION=ok"
