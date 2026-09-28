# verify/hold-hotkey.ps1
# Read-only verification helper (not part of the Arckeep product).
# Registers Ctrl+Alt+K globally on this process so Arckeep's own registration
# attempt for the same combination is guaranteed to conflict (AC9).
param(
  [string]$EvidenceDir = "evidence"
)

Add-Type 'using System;using System.Runtime.InteropServices;public static class HK{[DllImport("user32.dll")]public static extern bool RegisterHotKey(IntPtr h,int id,uint m,uint vk);}'
# MOD_ALT(0x0001) | MOD_CONTROL(0x0002) | MOD_NOREPEAT(0x4000), VK 'K' = 0x4B
$ok = [HK]::RegisterHotKey([IntPtr]::Zero, 1, 0x0001 -bor 0x0002 -bor 0x4000, 0x4B)
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
"registered=$ok" | Out-File (Join-Path $EvidenceDir 'hotkey-holder.txt')
Start-Sleep -Seconds 1200
