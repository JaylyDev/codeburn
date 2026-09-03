; Uninstalling CodeBurn Desktop removes the tray app only when this app is what
; put it there. src/menubar-installer.ts writes the marker at install time and
; credits whoever got there first, so a tray app someone installed by hand with
; `codeburn menubar` survives, and the one the desktop app installed goes with it.
;
; PowerShell does the reading: the marker is JSON, and the product code lives
; inside the uninstall string Windows Installer wrote. `$$` is a literal dollar
; for NSIS, so every `$$` below is a PowerShell variable, and every string inside
; the command is single-quoted so nothing needs escaping through two parsers.

!macro customUnInstall
  DetailPrint "Checking whether CodeBurn installed the tray app..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$marker = Join-Path $$env:LOCALAPPDATA (Join-Path ''codeburn-menubar'' ''installed-by.json''); if (Test-Path $$marker) { $$record = Get-Content -Raw $$marker | ConvertFrom-Json; if ($$record.installedBy -eq ''desktop'') { Get-Process -Name ''codeburn-menubar'' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; if ($$record.uninstallString -match ''\{[0-9A-Fa-f-]{36}\}'') { Start-Process -Wait -FilePath ''msiexec.exe'' -ArgumentList ''/x'', $$Matches[0], ''/passive'', ''/norestart'' }; Remove-Item -Force -ErrorAction SilentlyContinue $$marker } }"'
  Pop $0

  ; The launcher this app writes so the tray app has a CLI to run at all
  ; (app/electron/menubar.ts). It names this app's own executable, which is about
  ; to be gone, and unlike the tray app itself there is no copy of it anybody
  ; else could have put there, so it goes unconditionally. The directory follows
  ; only if the tray app left nothing else in it.
  Delete "$LOCALAPPDATA\codeburn-menubar\codeburn-cli.cmd"
  RMDir "$LOCALAPPDATA\codeburn-menubar"
!macroend
