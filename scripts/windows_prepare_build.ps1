$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$toolDir = "C:\shiyibao-toolchain"
New-Item -ItemType Directory -Force -Path $toolDir | Out-Null

function Invoke-Installer {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FilePath,
        [Parameter(Mandatory = $true)]
        [string[]] $ArgumentList
    )

    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -Wait `
        -PassThru
    if ($process.ExitCode -notin @(0, 3010)) {
        throw "$FilePath failed with exit code $($process.ExitCode)"
    }
}

function Add-MachinePathEntry {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Entry
    )

    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $entries = $machinePath.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)
    if ($entries -notcontains $Entry) {
        [Environment]::SetEnvironmentVariable(
            "Path",
            ($entries + $Entry) -join ";",
            "Machine"
        )
    }
}

function Invoke-WebRequestWithRetry {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Uri,
        [string] $OutFile = ""
    )

    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            if ($OutFile) {
                Invoke-WebRequest $Uri -OutFile $OutFile -UseBasicParsing
                return
            }
            return Invoke-WebRequest $Uri -UseBasicParsing
        }
        catch {
            if ($attempt -eq 4) {
                throw
            }
            Write-Host "Download attempt $attempt failed for $Uri; retrying..."
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}

$python = "C:\Python312\python.exe"
$pythonInstaller = Join-Path $toolDir "python-3.12.10-amd64.exe"
$pythonReady = $false
if (Test-Path $python) {
    & $python -c "import encodings, pip" 2>$null
    $pythonReady = $LASTEXITCODE -eq 0
}
if (-not $pythonReady) {
    if (Test-Path $python) {
        Write-Output "Removing incomplete Python 3.12 installation"
        Invoke-Installer $pythonInstaller @("/uninstall", "/quiet")
    }
    Write-Output "Installing Python 3.12 x64"
    if (-not (Test-Path $pythonInstaller)) {
        Invoke-WebRequestWithRetry `
            -Uri "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" `
            -OutFile $pythonInstaller
    }
    Invoke-Installer $pythonInstaller @(
        "/quiet",
        "InstallAllUsers=1",
        "TargetDir=C:\Python312",
        "Include_exe=1",
        "Include_lib=1",
        "Include_pip=1",
        "Include_dev=1",
        "Include_tools=1",
        "PrependPath=1",
        "Include_test=0",
        "Include_tcltk=0",
        "Include_launcher=1",
        "InstallLauncherAllUsers=1",
        "AssociateFiles=0",
        "Shortcuts=0"
    )
}

$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) {
    Write-Output "Installing Node.js 22 x64"
    $nodeIndex = (
        Invoke-WebRequestWithRetry -Uri "https://nodejs.org/dist/latest-v22.x/"
    ).Content
    $nodeName = [regex]::Match(
        $nodeIndex,
        "node-v[0-9.]+-x64\.msi"
    ).Value
    if (-not $nodeName) {
        throw "Node.js 22 x64 MSI was not found"
    }
    $nodeInstaller = Join-Path $toolDir $nodeName
    Invoke-WebRequestWithRetry `
        -Uri ("https://nodejs.org/dist/latest-v22.x/" + $nodeName) `
        -OutFile $nodeInstaller
    Invoke-Installer "msiexec.exe" @(
        "/i",
        $nodeInstaller,
        "/qn",
        "/norestart"
    )
}

$vcVars = "C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcVars)) {
    Write-Output "Installing Visual Studio 2022 C++ Build Tools"
    $vsInstaller = Join-Path $toolDir "vs_BuildTools.exe"
    Invoke-WebRequestWithRetry `
        -Uri "https://aka.ms/vs/17/release/vs_BuildTools.exe" `
        -OutFile $vsInstaller
    Invoke-Installer $vsInstaller @(
        "--quiet",
        "--wait",
        "--norestart",
        "--nocache",
        "--installPath",
        "C:\BuildTools",
        "--add",
        "Microsoft.VisualStudio.Workload.VCTools",
        "--includeRecommended"
    )
}

$cargoHome = "C:\Rust\.cargo"
$rustupHome = "C:\Rust\.rustup"
$rustc = Join-Path $cargoHome "bin\rustc.exe"
if (-not (Test-Path $rustc)) {
    Write-Output "Installing Rust x64 MSVC toolchain"
    $rustup = Join-Path $toolDir "rustup-init-x64.exe"
    Invoke-WebRequestWithRetry `
        -Uri "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" `
        -OutFile $rustup
    $env:CARGO_HOME = $cargoHome
    $env:RUSTUP_HOME = $rustupHome
    Invoke-Installer $rustup @(
        "-y",
        "--default-host",
        "x86_64-pc-windows-msvc",
        "--profile",
        "minimal"
    )
}
[Environment]::SetEnvironmentVariable("CARGO_HOME", $cargoHome, "Machine")
[Environment]::SetEnvironmentVariable("RUSTUP_HOME", $rustupHome, "Machine")
Add-MachinePathEntry (Join-Path $cargoHome "bin")

$ffmpeg = "C:\Program Files\ffmpeg\bin\ffmpeg.exe"
if (-not (Test-Path $ffmpeg)) {
    Write-Output "Installing FFmpeg x64"
    $ffmpegZip = Join-Path $toolDir "ffmpeg.zip"
    Invoke-WebRequestWithRetry `
        -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" `
        -OutFile $ffmpegZip
    $ffmpegExtract = Join-Path $toolDir "ffmpeg-extract"
    Expand-Archive `
        -Path $ffmpegZip `
        -DestinationPath $ffmpegExtract `
        -Force
    $ffmpegBin = Get-ChildItem $ffmpegExtract -Directory |
        Select-Object -First 1 |
        ForEach-Object { Join-Path $_.FullName "bin" }
    if (-not (Test-Path (Join-Path $ffmpegBin "ffmpeg.exe"))) {
        throw "FFmpeg executable was not found after extraction"
    }
    $ffmpegInstall = Split-Path $ffmpeg -Parent
    New-Item -ItemType Directory -Force -Path $ffmpegInstall | Out-Null
    Copy-Item (Join-Path $ffmpegBin "*.exe") $ffmpegInstall -Force
}
Add-MachinePathEntry (Split-Path $ffmpeg -Parent)

Write-Output "TOOLCHAIN_INSTALL=complete"
