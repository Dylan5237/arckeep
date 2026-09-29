<#
Arckeep Issue #4 独立验收 - Windows 原生输入/窗口辅助脚本。
只读操作 + 真实 SendInput / RegisterHotKey，不调用被测应用内部函数。

用法（每次调用一个 Action）：
  pwsh -File win.ps1 -Action SendHotkey -Combo "Ctrl+Alt+Space"
  pwsh -File win.ps1 -Action SendKey -Key "Return"       # Enter / Escape / Tab ...
  pwsh -File win.ps1 -Action SendText -Text "hello 你好"  # 经 SendInput KEYEVENTF_UNICODE 逐字符发送
  pwsh -File win.ps1 -Action Foreground                   # 输出当前前台窗口 JSON
  pwsh -File win.ps1 -Action Screenshot -Path C:\out.png  # 全屏截图
  pwsh -File win.ps1 -Action Occupy -Combo "Ctrl+Alt+Space" -StopFile C:\stop.flag
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('SendHotkey','SendKey','SendText','Foreground','Screenshot','Occupy','ClickAt')]
  [string]$Action,
  [string]$Combo,
  [string]$Key,
  [string]$Text,
  [string]$Path,
  [string]$StopFile,
  [int]$X,
  [int]$Y,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ArckeepVerify {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public const uint INPUT_KEYBOARD = 1;
    public const uint INPUT_MOUSE = 0;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint KEYEVENTF_SCANCODE = 0x0008;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
  }
}
'@

function Send-KeyEvent([int]$vk, [bool]$up) {
  $evt = New-Object ArckeepVerify.Native+INPUT
  $evt.type = [ArckeepVerify.Native]::INPUT_KEYBOARD
  $evt.U.ki = New-Object ArckeepVerify.Native+KEYBDINPUT
  $evt.U.ki.wVk = $vk
  $evt.U.ki.wScan = 0
  $evt.U.ki.dwFlags = if ($up) { [ArckeepVerify.Native]::KEYEVENTF_KEYUP } else { 0 }
  $evt.U.ki.time = 0
  $evt.U.ki.dwExtraInfo = [IntPtr]::Zero
  $arr = [ArckeepVerify.Native+INPUT[]]@($evt)
  [ArckeepVerify.Native]::SendInput(1, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([type][ArckeepVerify.Native+INPUT])) | Out-Null
}

function Send-UnicodeChar([char]$ch, [bool]$up) {
  $evt = New-Object ArckeepVerify.Native+INPUT
  $evt.type = [ArckeepVerify.Native]::INPUT_KEYBOARD
  $evt.U.ki = New-Object ArckeepVerify.Native+KEYBDINPUT
  $evt.U.ki.wVk = 0
  $evt.U.ki.wScan = [uint16][int]$ch
  $flags = [ArckeepVerify.Native]::KEYEVENTF_UNICODE
  if ($up) { $flags = $flags -bor [ArckeepVerify.Native]::KEYEVENTF_KEYUP }
  $evt.U.ki.dwFlags = $flags
  $evt.U.ki.time = 0
  $evt.U.ki.dwExtraInfo = [IntPtr]::Zero
  $arr = [ArckeepVerify.Native+INPUT[]]@($evt)
  [ArckeepVerify.Native]::SendInput(1, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([type][ArckeepVerify.Native+INPUT])) | Out-Null
}

$VK = @{
  'Ctrl' = 0x11; 'Control' = 0x11
  'Alt' = 0x12
  'Shift' = 0x10
  'Win' = 0x5B
  'Space' = 0x20
  'Return' = 0x0D; 'Enter' = 0x0D
  'Escape' = 0x1B; 'Esc' = 0x1B
  'Tab' = 0x09
  'Backspace' = 0x08
  'Delete' = 0x2E
}

function Get-Vk([string]$name) {
  if ($VK.ContainsKey($name)) { return $VK[$name] }
  if ($name.Length -eq 1) { return [byte][char]$name.ToUpper() }
  if ($name -match '^[Ff]([1-9]|1[0-9]|2[0-4])$') {
    $n = [int]$Matches[1]
    return 0x70 + ($n - 1)
  }
  throw "Unknown key name: $name"
}

function Send-Combo([string]$combo) {
  $parts = $combo.Split('+') | ForEach-Object { $_.Trim() }
  $vks = $parts | ForEach-Object { Get-Vk $_ }
  foreach ($vk in $vks) { Send-KeyEvent $vk $false; Start-Sleep -Milliseconds 40 }
  Start-Sleep -Milliseconds 60
  for ($i = $vks.Count - 1; $i -ge 0; $i--) { Send-KeyEvent $vks[$i] $true; Start-Sleep -Milliseconds 40 }
}

switch ($Action) {
  'SendHotkey' {
    if (-not $Combo) { throw '-Combo is required' }
    Send-Combo $Combo
    Write-Output (@{ ok = $true; combo = $Combo } | ConvertTo-Json -Compress)
  }
  'SendKey' {
    if (-not $Key) { throw '-Key is required' }
    $vk = Get-Vk $Key
    Send-KeyEvent $vk $false
    Start-Sleep -Milliseconds 40
    Send-KeyEvent $vk $true
    Write-Output (@{ ok = $true; key = $Key } | ConvertTo-Json -Compress)
  }
  'SendText' {
    if ($null -eq $Text) { throw '-Text is required' }
    foreach ($ch in $Text.ToCharArray()) {
      Send-UnicodeChar $ch $false
      Start-Sleep -Milliseconds 12
      Send-UnicodeChar $ch $true
      Start-Sleep -Milliseconds 12
    }
    Write-Output (@{ ok = $true; length = $Text.Length } | ConvertTo-Json -Compress)
  }
  'Foreground' {
    $hwnd = [ArckeepVerify.Native]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [ArckeepVerify.Native]::GetWindowText($hwnd, $sb, 512) | Out-Null
    $pid = 0
    [ArckeepVerify.Native]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
    $procName = 'unknown'
    try { $procName = (Get-Process -Id $pid).ProcessName } catch {}
    $rect = New-Object ArckeepVerify.Native+RECT
    [ArckeepVerify.Native]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    Write-Output (@{
      hwnd = $hwnd.ToInt64()
      title = $sb.ToString()
      processId = $pid
      processName = $procName
      rect = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
    } | ConvertTo-Json -Compress)
  }
  'Screenshot' {
    if (-not $Path) { throw '-Path is required' }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bmp.Dispose()
    Write-Output (@{ ok = $true; path = $Path; width = $bounds.Width; height = $bounds.Height } | ConvertTo-Json -Compress)
  }
  'ClickAt' {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)
    Start-Sleep -Milliseconds 30
    $down = New-Object ArckeepVerify.Native+INPUT
    $down.type = [ArckeepVerify.Native]::INPUT_MOUSE
    $down.U.mi = New-Object ArckeepVerify.Native+MOUSEINPUT
    $down.U.mi.dwFlags = [ArckeepVerify.Native]::MOUSEEVENTF_LEFTDOWN
    $up = New-Object ArckeepVerify.Native+INPUT
    $up.type = [ArckeepVerify.Native]::INPUT_MOUSE
    $up.U.mi = New-Object ArckeepVerify.Native+MOUSEINPUT
    $up.U.mi.dwFlags = [ArckeepVerify.Native]::MOUSEEVENTF_LEFTUP
    $arr = [ArckeepVerify.Native+INPUT[]]@($down)
    [ArckeepVerify.Native]::SendInput(1, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([type][ArckeepVerify.Native+INPUT])) | Out-Null
    Start-Sleep -Milliseconds 30
    $arr2 = [ArckeepVerify.Native+INPUT[]]@($up)
    [ArckeepVerify.Native]::SendInput(1, $arr2, [System.Runtime.InteropServices.Marshal]::SizeOf([type][ArckeepVerify.Native+INPUT])) | Out-Null
    Write-Output (@{ ok = $true; x = $X; y = $Y } | ConvertTo-Json -Compress)
  }
  'Occupy' {
    if (-not $Combo) { throw '-Combo is required' }
    if (-not $StopFile) { throw '-StopFile is required' }
    $parts = $Combo.Split('+') | ForEach-Object { $_.Trim() }
    $modParts = $parts[0..($parts.Count - 2)]
    $keyPart = $parts[$parts.Count - 1]
    $MOD = @{ 'Ctrl' = 0x0002; 'Control' = 0x0002; 'Alt' = 0x0001; 'Shift' = 0x0004; 'Win' = 0x0008 }
    $fsModifiers = 0
    foreach ($m in $modParts) { $fsModifiers = $fsModifiers -bor $MOD[$m] }
    $vk = Get-Vk $keyPart
    $ok = [ArckeepVerify.Native]::RegisterHotKey([IntPtr]::Zero, 1, $fsModifiers, $vk)
    if (-not $ok) {
      Write-Output (@{ ok = $false; error = 'RegisterHotKey failed'; win32Error = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() } | ConvertTo-Json -Compress)
      exit 1
    }
    Write-Output (@{ ok = $true; registered = $Combo; pid = $PID } | ConvertTo-Json -Compress)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
      if (Test-Path -LiteralPath $StopFile) { break }
      Start-Sleep -Milliseconds 300
    }
    [ArckeepVerify.Native]::UnregisterHotKey([IntPtr]::Zero, 1) | Out-Null
  }
}
