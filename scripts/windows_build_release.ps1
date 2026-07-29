$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$sourceRoot = Split-Path $PSScriptRoot -Parent
$buildRoot = "C:\shiyibao-build"
$python = "C:\Python312\python.exe"
$nodeDir = "C:\Program Files\nodejs"
$cargoBin = "C:\Rust\.cargo\bin"
$ffmpegBin = "C:\Program Files\ffmpeg\bin"
$vcVars = "C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

foreach ($path in @($sourceRoot, $python, $nodeDir, $cargoBin, $ffmpegBin, $vcVars)) {
    if (-not (Test-Path $path)) {
        throw "Required build path is missing: $path"
    }
}

Write-Output "STAGE=copy-source"
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
& robocopy.exe `
    $sourceRoot `
    $buildRoot `
    /E `
    /COPY:DAT `
    /DCOPY:DAT `
    /R:2 `
    /W:2 `
    /NFL `
    /NDL `
    /NJH `
    /NJS `
    /NP `
    /XD `
    ".git" `
    ".venv" `
    ".cursor" `
    "node_modules" `
    "target" `
    "build" `
    "workspace" `
    "dist" `
    "dist-desktop" `
    /XF `
    ".env" `
    "*.dmg"
$robocopyExit = $LASTEXITCODE
if ($robocopyExit -ge 8) {
    throw "robocopy failed with exit code $robocopyExit"
}

$vcEnvironment = cmd.exe /d /s /c ('"' + $vcVars + '" >nul && set')
foreach ($line in $vcEnvironment) {
    if ($line -match "^([^=]+)=(.*)$") {
        Set-Item -Path ("Env:" + $matches[1]) -Value $matches[2]
    }
}
$env:CARGO_HOME = "C:\Rust\.cargo"
$env:RUSTUP_HOME = "C:\Rust\.rustup"
$env:CARGO_NET_RETRY = "10"
$env:CARGO_HTTP_TIMEOUT = "120"
$env:CARGO_REGISTRIES_CRATES_IO_PROTOCOL = "sparse"
$env:PATH = @(
    "C:\Python312",
    "C:\Python312\Scripts",
    $nodeDir,
    $cargoBin,
    $ffmpegBin,
    $env:PATH
) -join ";"
$env:CI = "true"
# Python 在 Windows 上按当前代码页编码 stdout，脚本与 pytest 的中文输出会抛
# UnicodeEncodeError，把真实错误盖掉。
$env:PYTHONUTF8 = "1"

Set-Location $buildRoot

Write-Output "STAGE=install-python-dependencies"
& $python -m pip install `
    --disable-pip-version-check `
    -r requirements-build.txt `
    -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) {
    throw "Python dependency installation failed"
}

Write-Output "STAGE=install-node-dependencies"
& (Join-Path $nodeDir "npm.cmd") ci
if ($LASTEXITCODE -ne 0) {
    throw "Desktop npm ci failed"
}
& (Join-Path $nodeDir "npm.cmd") ci --prefix app
if ($LASTEXITCODE -ne 0) {
    throw "Frontend npm ci failed"
}

Write-Output "STAGE=verify-source"
& $python -m pytest -q
if ($LASTEXITCODE -ne 0) {
    throw "Python tests failed"
}
& (Join-Path $nodeDir "npm.cmd") --prefix app run lint
if ($LASTEXITCODE -ne 0) {
    throw "Frontend lint failed"
}
& (Join-Path $nodeDir "npm.cmd") --prefix app run build
if ($LASTEXITCODE -ne 0) {
    throw "Frontend build failed"
}

Write-Output "STAGE=build-sidecar"
& $python scripts\build_sidecar.py
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller sidecar build failed"
}
$targetTriple = (& (Join-Path $cargoBin "rustc.exe") --print host-tuple).Trim()
$sidecar = Join-Path `
    $buildRoot `
    "src-tauri\binaries\shiyibao-backend-$targetTriple.exe"
& $python scripts\test_packaged_sidecar.py --sidecar $sidecar
if ($LASTEXITCODE -ne 0) {
    throw "Packaged sidecar verification failed"
}

Write-Output "STAGE=check-rust-shell"
& (Join-Path $cargoBin "cargo.exe") check `
    --manifest-path src-tauri\Cargo.toml `
    --locked
if ($LASTEXITCODE -ne 0) {
    throw "Rust desktop check failed"
}

Write-Output "STAGE=build-nsis"
# buildRoot 长期复用，robocopy 没带 /PURGE，bundle\nsis 会累积历次构建的安装包。
# 不先清空就可能在下面挑中上一个版本的 exe，让冒烟验证、SHA256 与交付全部用错文件。
$nsisBundleDir = Join-Path $buildRoot "src-tauri\target\release\bundle\nsis"
if (Test-Path $nsisBundleDir) {
    Remove-Item -Path $nsisBundleDir -Recurse -Force
}
$offlineToolsRoot = Join-Path $sourceRoot "build\offline-tools"
$offlineNsisZip = Join-Path $offlineToolsRoot "nsis-3.11.zip"
$offlineTauriPlugin = Join-Path $offlineToolsRoot "nsis_tauri_utils.dll"
if ((Test-Path $offlineNsisZip) -and (Test-Path $offlineTauriPlugin)) {
    $tauriToolsRoot = Join-Path $env:LOCALAPPDATA "tauri"
    $nsisRoot = Join-Path $tauriToolsRoot "NSIS"
    $makensis = Join-Path $nsisRoot "makensis.exe"
    if (-not (Test-Path $makensis)) {
        New-Item `
            -ItemType Directory `
            -Force `
            -Path $tauriToolsRoot |
            Out-Null
        Expand-Archive `
            -Path $offlineNsisZip `
            -DestinationPath $tauriToolsRoot `
            -Force
        Move-Item `
            (Join-Path $tauriToolsRoot "nsis-3.11") `
            $nsisRoot
    }
    $tauriPluginDir = Join-Path `
        $nsisRoot `
        "Plugins\x86-unicode\additional"
    New-Item -ItemType Directory -Force -Path $tauriPluginDir | Out-Null
    Copy-Item `
        $offlineTauriPlugin `
        (Join-Path $tauriPluginDir "nsis_tauri_utils.dll") `
        -Force

    # 官方 2.5 KB i386 启动器会启动 Bin\makensis.exe。在 Windows 11 ARM x64
    # 模拟环境中，即使子进程存在，它仍可能因 CreateProcess 错误 0x2 而失败。
    # 将编译器放在 NSIS 根目录时可正常运行，并能正确解析 Include/Plugins/Stubs 目录。
    Copy-Item `
        (Join-Path $nsisRoot "Bin\makensis.exe") `
        $makensis `
        -Force
    Write-Output "NSIS_SOURCE=offline-verified"
}
& (Join-Path $nodeDir "npm.cmd") run tauri -- build --bundles nsis
if ($LASTEXITCODE -ne 0) {
    throw "Tauri NSIS build failed"
}

# 按修改时间取最新的一个：Get-ChildItem 默认按文件名排序，目录里只要还有旧版本
# 安装包就会挑到它而不是本轮产物。
$installers = @(
    Get-ChildItem $nsisBundleDir -Filter "*.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
)
if ($installers.Count -eq 0) {
    throw "NSIS installer was not generated"
}
if ($installers.Count -gt 1) {
    $candidates = ($installers | ForEach-Object { $_.Name }) -join ", "
    Write-Output "NSIS_INSTALLER_CANDIDATES=$candidates"
}
$installer = $installers[0]

Write-Output "STAGE=install-and-smoke-test"
$installDir = Join-Path `
    "C:\" `
    ("shiyibao-install-smoke-" + (Get-Date -Format "yyyyMMddHHmmss"))
try {
    $install = Start-Process `
        -FilePath $installer.FullName `
        -ArgumentList @("/S", "/D=$installDir") `
        -Wait `
        -PassThru
    if ($install.ExitCode -ne 0) {
        throw "NSIS installer exited with $($install.ExitCode)"
    }
    $installedApp = Join-Path $installDir "shiyibao.exe"
    if (-not (Test-Path $installedApp)) {
        throw "Installed desktop executable is missing: $installedApp"
    }
    & $python scripts\test_packaged_desktop.py --app $installedApp
    if ($LASTEXITCODE -ne 0) {
        throw "Installed desktop app smoke test failed"
    }
    $residualProcesses = Get-CimInstance Win32_Process |
        Where-Object {
            $_.ExecutablePath -and
            $_.ExecutablePath.StartsWith(
                $installDir,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }
    if ($residualProcesses) {
        $details = $residualProcesses |
            ForEach-Object { "$($_.ProcessId):$($_.ExecutablePath)" }
        throw "Installed desktop app left residual processes: $($details -join ', ')"
    }
} catch {
    # 失败时保留安装现场供排查，把路径打进输出免得找不到。
    Write-Output "SMOKE_INSTALL_DIR_KEPT=$installDir"
    throw
}

# 目录名带时间戳，每轮构建都是新目录，不清理会在 C 盘堆积。
Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $installDir) {
    Write-Output "SMOKE_INSTALL_DIR_KEPT=$installDir"
}

Write-Output "STAGE=copy-artifact"
$artifactDir = Join-Path $sourceRoot "dist-desktop\windows"
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$artifactPath = Join-Path $artifactDir $installer.Name
Copy-Item $installer.FullName $artifactPath -Force
$artifactHash = (Get-FileHash $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
$artifactSize = (Get-Item $artifactPath).Length

Write-Output "WINDOWS_BUILD=ok"
Write-Output "WINDOWS_INSTALLER=$artifactPath"
Write-Output "WINDOWS_INSTALLER_SIZE=$artifactSize"
Write-Output "WINDOWS_INSTALLER_SHA256=$artifactHash"
