# 热更新发布脚本
# 用法: .\scripts\release.ps1 <版本号>
# 示例: .\scripts\release.ps1 1.0.1
#
# 前提: 已配置 SSH 免密登录到服务器，或会提示输入密码

param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$Server   = "root@101.132.61.21"
$RemoteDir = "~/store_scan/bundles"
$BundleUrl = "http://101.132.61.21/bundles/latest.zip"
$ZipPath   = "bundle-$Version.zip"

Write-Host "==> 构建 v$Version ..."
npm run build

Write-Host "==> 打包 dist/ ..."
if (Test-Path $ZipPath) { Remove-Item $ZipPath }
# 将 dist 内容（不是 dist 文件夹本身）压缩
Push-Location dist
Compress-Archive -Path * -DestinationPath "..\$ZipPath"
Pop-Location

Write-Host "==> 上传到服务器 ..."
scp $ZipPath "${Server}:${RemoteDir}/latest.zip"

Write-Host "==> 更新 version.json ..."
$json = "{`"version`":`"$Version`",`"url`":`"$BundleUrl`"}"
ssh $Server "echo '$json' > $RemoteDir/version.json"

Remove-Item $ZipPath
Write-Host "==> 完成！v$Version 已发布，App 下次启动时自动更新。"
