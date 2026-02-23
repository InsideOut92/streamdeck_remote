using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace StreamDeckAudio {
  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
  public enum AudioSessionState { Inactive = 0, Active = 1, Expired = 2 }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int NotImpl1();
    int NotImpl2();
    int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    int GetCount(out int SessionCount);
    int GetSession(int SessionCount, out IAudioSessionControl Session);
  }

  [Guid("bfa971f1-4d5e-40bb-935e-967039bfbee4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl {
    int GetState(out AudioSessionState pRetVal);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetGroupingParam(out Guid pRetVal);
    int SetGroupingParam(ref Guid Override, ref Guid EventContext);
    int RegisterAudioSessionNotification(IntPtr NewNotifications);
    int UnregisterAudioSessionNotification(IntPtr NewNotifications);
  }

  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out AudioSessionState pRetVal);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetGroupingParam(out Guid pRetVal);
    int SetGroupingParam(ref Guid Override, ref Guid EventContext);
    int RegisterAudioSessionNotification(IntPtr NewNotifications);
    int UnregisterAudioSessionNotification(IntPtr NewNotifications);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetProcessId(out uint pRetVal);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
  }

  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float fLevel, ref Guid EventContext);
    int GetMasterVolume(out float pfLevel);
    int SetMute(bool bMute, ref Guid EventContext);
    int GetMute(out bool pbMute);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  public sealed class SessionSnapshot {
    public int Pid { get; set; }
    public string ProcessName { get; set; }
    public string DisplayName { get; set; }
    public string SessionIdentifier { get; set; }
    public string State { get; set; }
    public double VolumePercent { get; set; }
    public bool Muted { get; set; }
    public bool HasWindow { get; set; }
  }

  public static class CoreAudioBridge {
    const int CLSCTX_ALL = 23;
    const uint WM_APPCOMMAND = 0x0319;
    const int APPCOMMAND_MEDIA_PLAY_PAUSE = 14;
    const byte VK_MEDIA_PLAY_PAUSE = 0xB3;
    const int KEYEVENTF_KEYUP = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);

    static IAudioSessionEnumerator CreateSessionEnumerator() {
      IMMDeviceEnumerator deviceEnumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
      if (deviceEnumerator == null) throw new InvalidOperationException("IMMDeviceEnumerator unavailable");

      IMMDevice device;
      Marshal.ThrowExceptionForHR(deviceEnumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));
      if (device == null) throw new InvalidOperationException("Default audio endpoint unavailable");

      object managerObj;
      Guid iid = typeof(IAudioSessionManager2).GUID;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out managerObj));
      IAudioSessionManager2 manager = managerObj as IAudioSessionManager2;
      if (manager == null) throw new InvalidOperationException("IAudioSessionManager2 unavailable");

      IAudioSessionEnumerator enumerator;
      Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out enumerator));
      return enumerator;
    }

    public static List<SessionSnapshot> ListSessions() {
      List<SessionSnapshot> result = new List<SessionSnapshot>();
      IAudioSessionEnumerator enumerator = CreateSessionEnumerator();
      int count = 0;
      Marshal.ThrowExceptionForHR(enumerator.GetCount(out count));

      for (int i = 0; i < count; i++) {
        IAudioSessionControl control;
        Marshal.ThrowExceptionForHR(enumerator.GetSession(i, out control));
        if (control == null) continue;

        IAudioSessionControl2 control2 = control as IAudioSessionControl2;
        ISimpleAudioVolume volume = control as ISimpleAudioVolume;
        if (control2 == null || volume == null) continue;

        AudioSessionState state = AudioSessionState.Inactive;
        try { control.GetState(out state); } catch { }

        uint pidRaw = 0;
        try { control2.GetProcessId(out pidRaw); } catch { }
        int pid = unchecked((int)pidRaw);

        string displayName = "";
        try { control.GetDisplayName(out displayName); } catch { displayName = ""; }

        string sessionIdentifier = "";
        try { control2.GetSessionIdentifier(out sessionIdentifier); } catch { sessionIdentifier = ""; }

        float volumeRaw = 0f;
        try { volume.GetMasterVolume(out volumeRaw); } catch { }
        bool muted = false;
        try { volume.GetMute(out muted); } catch { }

        string processName = "";
        bool hasWindow = false;
        if (pid > 0) {
          try {
            Process process = Process.GetProcessById(pid);
            processName = process.ProcessName ?? "";
            hasWindow = process.MainWindowHandle != IntPtr.Zero;
          } catch {
            processName = "";
          }
        } else if (pid == 0) {
          processName = "System";
        }

        result.Add(new SessionSnapshot {
          Pid = pid,
          ProcessName = processName,
          DisplayName = displayName ?? "",
          SessionIdentifier = sessionIdentifier ?? "",
          State = state.ToString(),
          VolumePercent = Math.Round(Math.Max(0.0, Math.Min(1.0, volumeRaw)) * 100.0, 1),
          Muted = muted,
          HasWindow = hasWindow
        });
      }

      return result;
    }

    public static bool SetVolume(int pid, float level, out string message) {
      message = "";
      if (pid <= 0) {
        message = "pid fehlt";
        return false;
      }

      float clamped = Math.Max(0f, Math.Min(1f, level));
      Guid context = Guid.Empty;
      int changed = 0;
      IAudioSessionEnumerator enumerator = CreateSessionEnumerator();
      int count = 0;
      Marshal.ThrowExceptionForHR(enumerator.GetCount(out count));

      for (int i = 0; i < count; i++) {
        IAudioSessionControl control;
        Marshal.ThrowExceptionForHR(enumerator.GetSession(i, out control));
        if (control == null) continue;

        IAudioSessionControl2 control2 = control as IAudioSessionControl2;
        ISimpleAudioVolume volume = control as ISimpleAudioVolume;
        if (control2 == null || volume == null) continue;

        uint pidRaw = 0;
        try { control2.GetProcessId(out pidRaw); } catch { }
        if (unchecked((int)pidRaw) != pid) continue;
        volume.SetMasterVolume(clamped, ref context);
        changed++;
      }

      if (changed <= 0) {
        message = "Keine Session fuer pid gefunden";
        return false;
      }
      message = "OK";
      return true;
    }

    public static bool SetMute(int pid, bool mute, out string message) {
      message = "";
      if (pid <= 0) {
        message = "pid fehlt";
        return false;
      }

      Guid context = Guid.Empty;
      int changed = 0;
      IAudioSessionEnumerator enumerator = CreateSessionEnumerator();
      int count = 0;
      Marshal.ThrowExceptionForHR(enumerator.GetCount(out count));

      for (int i = 0; i < count; i++) {
        IAudioSessionControl control;
        Marshal.ThrowExceptionForHR(enumerator.GetSession(i, out control));
        if (control == null) continue;

        IAudioSessionControl2 control2 = control as IAudioSessionControl2;
        ISimpleAudioVolume volume = control as ISimpleAudioVolume;
        if (control2 == null || volume == null) continue;

        uint pidRaw = 0;
        try { control2.GetProcessId(out pidRaw); } catch { }
        if (unchecked((int)pidRaw) != pid) continue;
        volume.SetMute(mute, ref context);
        changed++;
      }

      if (changed <= 0) {
        message = "Keine Session fuer pid gefunden";
        return false;
      }
      message = "OK";
      return true;
    }

    public static bool SendPlayPause(int pid, out string message) {
      message = "";
      IntPtr targetWindow = IntPtr.Zero;

      if (pid > 0) {
        try {
          Process process = Process.GetProcessById(pid);
          targetWindow = process.MainWindowHandle;
        } catch { }
      }

      if (targetWindow != IntPtr.Zero) {
        IntPtr lParam = new IntPtr(APPCOMMAND_MEDIA_PLAY_PAUSE << 16);
        bool posted = PostMessage(targetWindow, WM_APPCOMMAND, targetWindow, lParam);
        if (posted) {
          message = "APPCOMMAND gesendet";
          return true;
        }
      }

      // Fallback to global media key (active media session)
      keybd_event(VK_MEDIA_PLAY_PAUSE, 0, 0, 0);
      keybd_event(VK_MEDIA_PLAY_PAUSE, 0, KEYEVENTF_KEYUP, 0);
      message = "Globales Media Play/Pause gesendet";
      return true;
    }
  }
}