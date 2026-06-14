param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$Changelog = ""
)

$ErrorActionPreference = 'Stop'

$Server    = "root@101.132.61.21"
$RemoteDir = "~/store_scan/bundles"
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
if ($Changelog) {
    $escaped = $Changelog -replace '"', '\"' -replace "'", "'\''"
    $json = "{""version"":""$Version"",""url"":""$BundleUrl"",""changelog"":""$escaped""}"
} else {
    $json = "{""version"":""$Version"",""url"":""$BundleUrl""}"
}
ssh $Server "echo '$json' > $RemoteDir/version.json"

Remove-Item $ZipPath
Write-Host "==> Done! v$Version deployed."
