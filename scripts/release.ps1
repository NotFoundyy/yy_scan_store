param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$Changelog = "",

    # 部署目标，可用环境变量 RELEASE_* 覆盖，便于换服务器/域名而不改脚本
    [string]$ServerHost = $(if ($env:RELEASE_HOST) { $env:RELEASE_HOST } else { "101.132.61.21" }),
    [string]$ServerUser = $(if ($env:RELEASE_USER) { $env:RELEASE_USER } else { "root" }),
    [string]$RemoteDir  = $(if ($env:RELEASE_REMOTE_DIR) { $env:RELEASE_REMOTE_DIR } else { "~/yy_scan_store/bundles" }),
    [string]$BaseUrl    = $(if ($env:RELEASE_BASE_URL) { $env:RELEASE_BASE_URL } else { "http://101.132.61.21" })
)

$ErrorActionPreference = 'Stop'

$Server    = "${ServerUser}@${ServerHost}"
$BundleUrl = "$($BaseUrl.TrimEnd('/'))/bundles/latest.zip"
$ZipPath   = "bundle-$Version.zip"

Write-Host "==> Building v$Version ..."
npm run build

Write-Host "==> Zipping dist/ (forward-slash paths) ..."
if (Test-Path $ZipPath) { Remove-Item $ZipPath }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$srcDir = (Resolve-Path "dist").Path
$absZip = Join-Path (Get-Location).Path $ZipPath
$zip = [System.IO.Compression.ZipFile]::Open($absZip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -Path $srcDir -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($srcDir.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
    }
} finally {
    $zip.Dispose()
}

Write-Host "==> Uploading to server ..."
scp $ZipPath "${Server}:${RemoteDir}/latest.zip"

Write-Host "==> Updating version.json ..."
$obj = if ($Changelog) {
    [ordered]@{ version = $Version; url = $BundleUrl; changelog = $Changelog }
} else {
    [ordered]@{ version = $Version; url = $BundleUrl }
}
$jsonStr = $obj | ConvertTo-Json -Compress
$tmpJson = Join-Path $PSScriptRoot "bundle-version.json"
[System.IO.File]::WriteAllText($tmpJson, $jsonStr, (New-Object System.Text.UTF8Encoding $false))
scp $tmpJson "${Server}:${RemoteDir}/version.json"
Remove-Item $tmpJson

Remove-Item $ZipPath
Write-Host "==> Done! v$Version deployed."
