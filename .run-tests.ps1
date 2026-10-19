# kwd-board: build preview + sync server + full playwright run with installed Chrome. Output -> %TEMP%\kwd-test.log
param([string]$Dir = 'C:\KWD\work\kwd-board', [string]$Log = "$env:TEMP\kwd-test.log", [string]$Grep = '')
$ErrorActionPreference = 'Continue'
Set-Location $Dir
$log = $Log
"start $(Get-Date -Format s)" | Out-File $log -Encoding utf8
$cfg = @"
import base from './playwright.config';
export default { ...base, projects: [{ name: 'chrome', use: { ...(base.projects?.[0]?.use || {}), channel: 'chrome' } }] };
"@
[IO.File]::WriteAllText("$PWD\pw.chrome.config.ts", $cfg)
$prev = Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory $Dir cmd.exe -ArgumentList '/c','npm run build > %TEMP%\kwd-build.log 2>&1 && npx vite preview --port 4173 --strictPort > %TEMP%\kwd-prev.log 2>&1'
$env:TEACHER_TOKEN = 'testtoken'
$env:NODE_OPTIONS = '--import file:///' + ($Dir -replace '\\','/') + '/.pw-chrome.mjs'
$srv = Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory $Dir cmd.exe -ArgumentList '/c','npm run server > %TEMP%\kwd-srv.log 2>&1'
Start-Sleep 15
$g = if ($Grep) { "-g `"$Grep`"" } else { "" }
cmd /c "npx playwright test -c pw.chrome.config.ts --reporter=line $g >> `"$log`" 2>&1"
"exit $LASTEXITCODE end $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
foreach ($p in @($prev, $srv)) { cmd /c "taskkill /T /F /PID $($p.Id) >nul 2>&1" }
Remove-Item "$PWD\pw.chrome.config.ts" -ErrorAction SilentlyContinue
"done" | Out-File $log -Append -Encoding utf8
