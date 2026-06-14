param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$Changelog = ""
)

$ErrorActionPreference = 'Stop'

$Server    = "root@101.132.61.21"
$RemoteDir = "~/yy_scan_store/bundles"
$BundleUrl = "http://101.132.61.21/bundles/latest.zip"
$ZipPath   = "bundle-$Version.zip"

Write-Host "==> Building v$Version ..."
npm run build

Write-Host "==> Zipping dist/ ..."
if (Test-Path $ZipPath) { Remove-Item $ZipPath }
Push-Location dist
Compress-Archive -Path * -DestinationPath "..\$ZipPath"
Pop-Location

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
