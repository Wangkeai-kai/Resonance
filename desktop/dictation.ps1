param([int]$ExpectedProcess)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GongmingVoiceKeys {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static bool Open(uint expected) {
    var foreground = GetForegroundWindow();
    if (expected == 0 || foreground == IntPtr.Zero) return false;
    uint owner; GetWindowThreadProcessId(foreground, out owner);
    if (owner == 0 || owner != expected) return false;
    try { keybd_event(0x5B,0,0,UIntPtr.Zero); keybd_event(0x48,0,0,UIntPtr.Zero); }
    finally { keybd_event(0x48,0,2,UIntPtr.Zero); keybd_event(0x5B,0,2,UIntPtr.Zero); }
    return true;
  }
}
'@
if (-not [GongmingVoiceKeys]::Open([uint32]$ExpectedProcess)) { exit 2 }
