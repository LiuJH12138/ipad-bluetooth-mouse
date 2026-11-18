using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class DesktopWindowSmoke
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static async Task CheckScript(CoreWebView2 core, string expression, string name)
    {
        var args = Json.Serialize(new { expression = expression, awaitPromise = true,
            userGesture = true, returnByValue = true });
        var reply = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", args);
        var parsed = Json.Deserialize<Evaluation>(reply);
        if (parsed.result == null || !object.Equals(parsed.result.value, true))
            throw new Exception(name + " failed");
        Console.WriteLine("OK " + name);
    }
    public class Evaluation { public Result result { get; set; } }
    public class Result { public object value { get; set; } }

    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        int exit = 1;
        using (var form = new ConsoleWindow(new Uri(Console.ReadLine()))) {
            form.Shown += async delegate {
                try {
                    var view = (WebView2)form.Controls[0];
                    for (int i = 0; i < 100; i++) {
                        if (view.CoreWebView2 != null &&
                            await view.ExecuteScriptAsync("typeof ready === 'function'") == "true") break;
                        await Task.Delay(100);
                    }
                    var core = view.CoreWebView2;
                    if (core == null) throw new Exception("WebView2 did not initialize");
                    await CheckScript(core, "api('status').then(s => s.state === 'idle')", "authenticated console");
                    await CheckScript(core, "VideoDecoder.isConfigSupported({codec:'avc1.42E01E',optimizeForLatency:true}).then(c=>c.supported)", "H.264 decoder");
                    await CheckScript(core, "typeof navigator.mediaDevices.getDisplayMedia === 'function'", "window picker API");
                    var bounds = form.Bounds;
                    await CheckScript(core, "monitor.requestFullscreen().then(()=>document.fullscreenElement === monitor)", "enter fullscreen");
                    await Task.Delay(150);
                    if (form.FormBorderStyle != FormBorderStyle.None || form.Bounds != Screen.FromControl(form).Bounds)
                        throw new Exception("Host did not cover the current monitor");
                    await CheckScript(core, "monitor.requestPointerLock().then(()=>document.pointerLockElement === monitor)", "capture pointer");
                    await CheckScript(core, "(document.exitPointerLock(),document.exitFullscreen().then(()=>!document.fullscreenElement))", "exit fullscreen");
                    await Task.Delay(150);
                    if (form.Bounds != bounds || form.FormBorderStyle != FormBorderStyle.Sizable)
                        throw new Exception("Host window geometry was not restored");
                    Console.WriteLine("OK native window bounds restored");
                    exit = 0;
                } catch (Exception e) { Console.Error.WriteLine(e.Message); }
                finally { form.Close(); }
            };
            Application.Run(form);
        }
        return exit;
    }
}
