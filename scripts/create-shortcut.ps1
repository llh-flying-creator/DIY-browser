<#
.SYNOPSIS
    创建 / 更新「DeepSeek 浏览器」桌面快捷方式（可用 -StartMenu 同时加入开始菜单）。

.DESCRIPTION
    目标自动选择：
      1. 若存在 electron-builder 打包产物 release\win-unpacked\*.exe，则指向该 exe；
      2. 否则指向 node_modules\electron\dist\electron.exe 并把项目目录作为参数（开发模式一键启动，无控制台窗口）。
    图标统一使用 build\icon.ico（若不存在则退回 exe 自带图标）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -StartMenu
#>

param(
    [switch]$StartMenu
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$name = 'DeepSeek 浏览器.lnk'
$ico = Join-Path $root 'build\icon.ico'
$description = 'DeepSeek 浏览器 - 秒开 DeepSeek 对话官网'

# ---------- 1. 选择启动目标 ----------
$packed = Get-ChildItem -Path (Join-Path $root 'release\win-unpacked') -Filter *.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1

if ($packed) {
    $target = $packed.FullName
    $arguments = ''
    $workDir = $packed.DirectoryName
    $mode = '打包产物'
} else {
    $target = Join-Path $root 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path $target)) {
        Write-Host "[shortcut] 未找到 $target" -ForegroundColor Red
        Write-Host "[shortcut] 请先执行：npm install" -ForegroundColor Yellow
        exit 1
    }
    $arguments = '"' + $root + '"'
    $workDir = $root
    $mode = '开发模式（Electron 运行时 + 项目目录）'
}

# ---------- 2. 确定快捷方式位置 ----------
# 通过系统 API 获取，兼容 OneDrive / 自定义重定向的桌面与开始菜单
$targets = @([Environment]::GetFolderPath('Desktop'))
if ($StartMenu) {
    $targets += Join-Path ([Environment]::GetFolderPath('Programs')) 'DeepSeek 浏览器'
}

$shell = New-Object -ComObject WScript.Shell

foreach ($dir in $targets) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    $linkPath = Join-Path $dir $name
    $link = $shell.CreateShortcut($linkPath)
    $link.TargetPath = $target
    $link.Arguments = $arguments
    $link.WorkingDirectory = $workDir
    $link.Description = $description
    $link.WindowStyle = 1
    if (Test-Path $ico) { $link.IconLocation = "$ico,0" }
    $link.Save()

    Write-Host "[shortcut] 已创建：$linkPath" -ForegroundColor Green
}

# ---------- 3. 清理历史遗留的旧命名快捷方式 ----------
foreach ($legacyName in @('DIY Browser.lnk')) {
    $legacy = Join-Path ([Environment]::GetFolderPath('Desktop')) $legacyName
    if (Test-Path $legacy) {
        Remove-Item $legacy -Force
        Write-Host "[shortcut] 已删除旧快捷方式：$legacy" -ForegroundColor Yellow
    }
}

Write-Host "[shortcut] 启动方式：$mode"
Write-Host "[shortcut] 目标    ：$target"
if ($arguments) { Write-Host "[shortcut] 参数    ：$arguments" }
Write-Host "[shortcut] 图标    ：$(if (Test-Path $ico) { $ico } else { '（缺省，使用 exe 自带图标）' })"
