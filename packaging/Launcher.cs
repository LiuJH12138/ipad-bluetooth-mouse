using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("iPad 控制台")]
[assembly: AssemblyProduct("iPad Control Console")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class Launcher
{
    private const string Title = "iPad 控制台";
    private const string Instance = @"Local\LiuJH12138.iPadControlConsole";

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        bool first;
        using (var activate = new EventWaitHandle(false, EventResetMode.AutoReset, Instance + ".Open"))
        using (var mutex = new Mutex(true, Instance, out first))
        {
            if (!first) { activate.Set(); return; }
            try { Run(activate); }
            catch (Exception e) { MessageBox.Show(e.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error); }
            finally { mutex.ReleaseMutex(); }
        }
    }

    private static void Run(EventWaitHandle activate)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string browser = FindBrowser();
        var start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), "server.js --desktop") {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true
        };
        using (var service = Process.Start(start))
        {
            try {
                var read = service.StandardOutput.ReadLineAsync();
                if (!read.Wait(15000) || read.Result == null ||
                    !Regex.IsMatch(read.Result, @"^http://127\.0\.0\.1:\d{1,5}/#[0-9a-f]{64}$"))
                    throw new InvalidOperationException("本机服务启动失败，请重新打开应用。");
                string url = read.Result;
                Action open = () => Process.Start(new ProcessStartInfo(browser, "--app=" + url) { UseShellExecute = false });
                using (var menu = new ContextMenuStrip())
                using (var tray = new NotifyIcon())
                using (var timer = new System.Windows.Forms.Timer())
                {
                    menu.Items.Add("打开控制台", null, delegate { open(); });
                    menu.Items.Add("退出应用", null, delegate { Application.ExitThread(); });
                    tray.Text = Title; tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                    tray.ContextMenuStrip = menu;
                    tray.DoubleClick += delegate { open(); };
                    tray.Visible = true;
                    timer.Interval = 500;
                    timer.Tick += delegate {
                        if (service.HasExited) { Application.ExitThread(); return; }
                        if (activate.WaitOne(0)) open();
                    };
                    timer.Start();
                    open();
                    Application.Run();
                    tray.Visible = false;
                }
            } finally {
                if (!service.HasExited) {
                    service.StandardInput.Close();
                    if (!service.WaitForExit(12000)) service.Kill();
                }
            }
        }
    }

    private static string FindBrowser()
    {
        string[] roots = {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
        };
        foreach (string relative in new[] { @"Microsoft\Edge\Application\msedge.exe", @"Google\Chrome\Application\chrome.exe" })
            foreach (string root in roots) {
                string file = Path.Combine(root, relative);
                if (File.Exists(file)) return file;
            }
        throw new FileNotFoundException("请先安装 Microsoft Edge 或 Google Chrome，再打开 iPad 控制台。");
    }
}
