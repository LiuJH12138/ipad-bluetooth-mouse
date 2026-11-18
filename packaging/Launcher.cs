using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("iPad 控制台")]
[assembly: AssemblyProduct("iPad Control Console")]
[assembly: AssemblyVersion("1.5.4.0")]

internal static class Launcher
{
    private const string Title = "iPad 控制台";
    private const string Instance = @"Local\LiuJH12138.iPadControlConsole";
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [STAThread]
    private static void Main(string[] args)
    {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        Application.EnableVisualStyles();
        bool source = Array.IndexOf(args, "--source") >= 0;
        bool usb = Array.IndexOf(args, "--usb") >= 0;
        try {
            Uri supplied = source ? Session(Console.ReadLine()) : null;
            string name = Instance + (source ? ".Source." + supplied.Port : "");
            bool first;
            using (var activate = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Open"))
            using (var activateUsb = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".OpenUsb"))
            using (var mutex = new Mutex(true, name, out first)) {
                if (!first) { (usb ? activateUsb : activate).Set(); return; }
                if (source) RunWindow(supplied, activate, activateUsb, usb, null);
                else RunService(activate, activateUsb, usb);
            }
        } catch (Exception e) { MessageBox.Show(e.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private static Uri Session(string line)
    {
        if (line == null || !Regex.IsMatch(line, @"\Ahttp://127\.0\.0\.1:\d{1,5}/#[0-9a-f]{64}\z"))
            throw new InvalidOperationException("本机服务启动失败，请重新打开应用。");
        return new Uri(line);
    }

    private static void RunService(EventWaitHandle activate, EventWaitHandle activateUsb, bool usb)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        var start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), "server.js --desktop") {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true
        };
        using (var service = Process.Start(start)) {
            try {
                var read = service.StandardOutput.ReadLineAsync();
                if (!read.Wait(15000)) throw new TimeoutException("等待本机服务超时。");
                RunWindow(Session(read.Result), activate, activateUsb, usb, service);
            } finally {
                if (!service.HasExited) {
                    service.StandardInput.Close();
                    if (!service.WaitForExit(12000)) service.Kill();
                }
            }
        }
    }

    private static void RunWindow(Uri session, EventWaitHandle activate, EventWaitHandle activateUsb, bool usb, Process service)
    {
        ConsoleWindow window = null;
        Action<bool> open = startUsb => {
            if (window == null || window.IsDisposed) {
                var url = new UriBuilder(session);
                if (startUsb) url.Query = "source=usb";
                window = new ConsoleWindow(url.Uri);
                window.Show();
            } else {
                if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
                window.Activate();
                if (startUsb) window.StartUsb();
            }
        };
        using (var menu = new ContextMenuStrip())
        using (var tray = new NotifyIcon())
        using (var timer = new System.Windows.Forms.Timer()) {
            menu.Items.Add("打开控制台", null, delegate { open(false); });
            menu.Items.Add("退出应用", null, delegate { Application.ExitThread(); });
            tray.Text = Title;
            tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { open(false); };
            tray.Visible = true;
            timer.Interval = 250;
            timer.Tick += delegate {
                if (service != null && service.HasExited) { Application.ExitThread(); return; }
                if (activateUsb.WaitOne(0)) open(true);
                if (activate.WaitOne(0)) open(false);
            };
            timer.Start();
            try {
                open(usb);
                Application.Run();
            } finally {
                tray.Visible = false;
                if (window != null) window.Dispose();
            }
        }
    }
}
