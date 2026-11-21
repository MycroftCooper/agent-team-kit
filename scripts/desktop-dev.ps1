$ErrorActionPreference = 'Stop'

function Get-CheckedFile($Url, $Destination, $Algorithm, $Expected) {
    $atkPartial = "$Destination.tmp"
    & curl.exe --location --fail --silent --show-error --connect-timeout 20 --max-time 180 --output $atkPartial $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    if ((Get-FileHash -LiteralPath $atkPartial -Algorithm $Algorithm).Hash -ne $Expected) {
        throw "Checksum mismatch: $Url"
    }
    Move-Item -LiteralPath $atkPartial -Destination $Destination -Force
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
    $atkRoot = Split-Path -Parent $PSScriptRoot
    $atkDesktop = Join-Path $atkRoot 'apps\desktop'
    $atkElectronPackage = Join-Path $atkDesktop 'node_modules\electron'
    $atkElectron = Join-Path $atkElectronPackage 'dist\electron.exe'
    $atkVite = Join-Path $atkRoot 'apps\web\node_modules\vite\package.json'
    $atkLockHash = (Get-FileHash -LiteralPath (Join-Path $atkRoot 'pnpm-lock.yaml')).Hash
    $atkTools = Join-Path $atkRoot 'artifacts\desktop-dev\toolchain'
    $atkStamp = Join-Path $atkTools 'workspace.sha256'
    [void][System.IO.Directory]::CreateDirectory($atkTools)

    $atkCurrent = if (Test-Path -LiteralPath $atkStamp) { (Get-Content -LiteralPath $atkStamp -Raw).Trim() } else { '' }
    if ($atkCurrent -ne $atkLockHash -or -not (Test-Path -LiteralPath $atkElectron) -or -not (Test-Path -LiteralPath $atkVite)) {
        $atkBootstrap = [System.IO.File]::Open((Join-Path $atkTools 'bootstrap.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
        try {
            # A portable toolchain is only used to install workspace dependencies.
            # Electron supplies Node.js for the desktop app and its backend.
            $atkNodeDir = Join-Path $atkTools 'node-v24.22.2'
            $atkNode = Join-Path $atkNodeDir 'node.exe'
            if (-not (Test-Path -LiteralPath $atkNode)) {
                Write-Host 'Preparing portable Node.js for dependency installation...'
                [void][System.IO.Directory]::CreateDirectory($atkNodeDir)
                Get-CheckedFile 'https://nodejs.org/dist/v24.22.2/win-x64/node.exe' $atkNode 'SHA256' '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9'
            }
            $atkPnpmDir = Join-Path $atkTools 'pnpm-11.6.0'
            $atkPnpm = Join-Path $atkPnpmDir 'package\bin\pnpm.cjs'
            if (-not (Test-Path -LiteralPath $atkPnpm)) {
                [void][System.IO.Directory]::CreateDirectory($atkPnpmDir)
                $atkTarball = Join-Path $atkPnpmDir 'pnpm.tgz'
                $atkIntegrity = 'mjZRgiQIDG/lFlr9z+eb+hGMKb5wPz9GKx4y7+HpjkfodQsUjggoYlCq1BE8x5k8pBPE4s1Ed1JwjC7ldRvJXw=='
                $atkHash = [BitConverter]::ToString([Convert]::FromBase64String($atkIntegrity)).Replace('-', '')
                Get-CheckedFile 'https://registry.npmjs.org/pnpm/-/pnpm-11.6.0.tgz' $atkTarball 'SHA512' $atkHash
                & tar.exe -xzf $atkTarball -C $atkPnpmDir
                if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $atkPnpm)) { throw 'Could not unpack pnpm.' }
            }
            $atkOriginalPath = $env:Path
            Push-Location -LiteralPath $atkRoot
            try {
                $env:Path = "$atkNodeDir;$atkOriginalPath"
                & $atkNode $atkPnpm install --frozen-lockfile
                if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
                if (-not (Test-Path -LiteralPath $atkElectron)) {
                    & $atkNode (Join-Path $atkElectronPackage 'install.js')
                    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $atkElectron)) { throw 'Electron download failed.' }
                }
                Set-Content -LiteralPath $atkStamp -Value $atkLockHash -Encoding Ascii
            } finally {
                $env:Path = $atkOriginalPath
                Pop-Location
            }
        } finally {
            $atkBootstrap.Dispose()
        }
    }

    $atkApp = Start-Process -FilePath $atkElectron -ArgumentList ('"{0}"' -f $atkDesktop) -WorkingDirectory $atkRoot -NoNewWindow -Wait -PassThru
    exit $atkApp.ExitCode
} catch {
    [Console]::Error.WriteLine("ATK desktop: $($_.Exception.Message)")
    exit 1
}
