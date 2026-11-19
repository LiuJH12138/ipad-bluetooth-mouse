using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class ConsoleWindow : Form
{
    private readonly WebView2 view = new WebView2();
    private readonly Uri session;
    private Rectangle normalBounds;
    private FormWindowState normalState;
    private bool fullscreen;
    private bool loaded;
    private bool pendingUsb;

    internal async void StartUsb()
    {
        if (!loaded) { pendingUsb = true; return; }
        try { await view.CoreWebView2.ExecuteScriptAsync("if (!document.getElementById('placeholder')?.hidden) document.getElementById('usb')?.click()"); }
        catch (ObjectDisposedException) { }
    }

    internal ConsoleWindow(Uri session)
    {
        this.session = session;
        Text = "iPhone / iPad 控制台";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1120, 740);
        MinimumSize = new Size(560, 400);
        view.Dock = DockStyle.Fill;
        view.CreationProperties = new CoreWebView2CreationProperties {
            UserDataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "iPadControlConsole.WebView2"), IsInPrivateModeEnabled = true
        };
        Controls.Add(view);
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        try {
            await view.EnsureCoreWebView2Async();
            if (IsDisposed || Disposing) return;
            var core = view.CoreWebView2;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = false;
            core.NewWindowRequested += (s, args) => {
                args.Handled = true;
                const string appleDevices = "https://apps.microsoft.com/detail/9np83lwlpz9k";
                if (args.IsUserInitiated && string.Equals(args.Uri, appleDevices, StringComparison.Ordinal)) {
                    try {
                        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(appleDevices) { UseShellExecute = true });
                    } catch (System.ComponentModel.Win32Exception) {
                        MessageBox.Show(this, "请在 Microsoft Store 搜索 Apple Devices。", Text);
                    }
                }
            };
            core.NavigationStarting += (s, args) => {
                Uri destination;
                args.Cancel = !Uri.TryCreate(args.Uri, UriKind.Absolute, out destination)
                    || destination.Scheme != session.Scheme || destination.Authority != session.Authority;
            };
            core.ContainsFullScreenElementChanged += (s, args) => SetFullscreen(core.ContainsFullScreenElement);
            core.NavigationCompleted += (s, args) => {
                loaded = args.IsSuccess;
                if (loaded && pendingUsb) { pendingUsb = false; StartUsb(); }
            };
            core.Navigate(session.AbsoluteUri);
        } catch (Exception error) {
            if (IsDisposed || Disposing) return;
            if (error is WebView2RuntimeNotFoundException) {
                const string download = "https://developer.microsoft.com/microsoft-edge/webview2/";
                if (MessageBox.Show(this, "缺少 Microsoft WebView2。打开微软下载页？安装 Evergreen Runtime 后重新打开控制台。", Text,
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes) {
                    try {
                        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(download) { UseShellExecute = true });
                    } catch (System.ComponentModel.Win32Exception) {
                        MessageBox.Show(this, download, Text);
                    }
                }
            } else {
                MessageBox.Show(this, "控制台窗口启动失败：" + error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            Close();
        }
    }

    private void SetFullscreen(bool active)
    {
        if (fullscreen == active) return;
        fullscreen = active;
        if (active) {
            normalState = WindowState;
            normalBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var screen = Screen.FromControl(this);
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            Bounds = screen.Bounds;
        } else {
            FormBorderStyle = FormBorderStyle.Sizable;
            Bounds = normalBounds;
            WindowState = normalState;
        }
    }
}
