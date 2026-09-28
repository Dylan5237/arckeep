# verify/hold-hotkey-space.ps1
# Read-only verification helper (not part of the Arckeep product).
# Occupies Ctrl+Alt+Space (Arckeep's default hotkey) before a cold start,
# for the bonus check described in the verification brief (does not affect the AC9 verdict).
param(
  [string]$EvidenceDir = "evidence"
)

Add-Type 'using System;using System.Runtime.InteropServices;public static class HKS{[DllImport("user32.dll")]public static extern bool RegisterHotKey(IntPtr h,int id,uint m,uint vk);}'
# MOD_ALT(0x0001) | MOD_CONTROL(0x0002) | MOD_NOREPEAT(0x4000), VK_SPACE = 0x20
$ok = [HKS]::RegisterHotKey([IntPtr]::Zero, 2, 0x0001 -bor 0x0002 -bor 0x4000, 0x20)
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
"registered=$ok" | Out-File (Join-Path $EvidenceDir 'hotkey-holder-space.txt')
Start-Sleep -Seconds 300
