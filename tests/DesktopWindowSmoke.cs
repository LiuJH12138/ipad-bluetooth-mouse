using System;
using System.Drawing;
using System.IO;
using System.Diagnostics;
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

    private static void EnableHardwareOcr(CoreWebView2 core, string script)
    {
        // Only this opt-in test window connects its authenticated local page to OCR.
        var source = new Uri(core.Source);
        core.Settings.IsWebMessageEnabled = true;
        core.WebMessageReceived += async (sender, message) => {
            if (new Uri(message.Source).GetLeftPart(UriPartial.Authority) != source.GetLeftPart(UriPartial.Authority)) return;
            string encoded = message.TryGetWebMessageAsString();
            if (encoded == null || encoded.Length > 3500000) return;
            var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
                "-NoProfile -NonInteractive -File \"" + script + "\"") {
                UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true, RedirectStandardOutput=true
            };
            try {
                using (var process = Process.Start(start)) {
                    Task<string> result = process.StandardOutput.ReadToEndAsync();
                    await process.StandardInput.WriteLineAsync(encoded);
                    process.StandardInput.Close();
                    string labels = await result;
                    core.PostWebMessageAsJson(string.IsNullOrWhiteSpace(labels) ? "null" : labels);
                }
            } catch { core.PostWebMessageAsJson("null"); }
        };
    }

    [STAThread]
    private static int Main()
    {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
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
                    var hardware = Environment.GetEnvironmentVariable("IPAD_CONSOLE_HARDWARE_TEST");
                    if (!string.IsNullOrEmpty(hardware)) {
                        var events = core.GetDevToolsProtocolEventReceiver("Runtime.consoleAPICalled");
                        events.DevToolsProtocolEventReceived += (s,e) => {
                            var entry = Json.Deserialize<ConsoleEntry>(e.ParameterObjectAsJson);
                            if (entry.args != null && entry.args.Length == 1) {
                                var message = entry.args[0].value as string;
                                if (message != null && message.StartsWith("USB verification: ", StringComparison.Ordinal)) Console.WriteLine(message);
                            }
                        };
                        await core.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");
                        var first = Environment.GetEnvironmentVariable("IPAD_CONSOLE_FIRST_DEVICE") ?? "";
                        var input = Environment.GetEnvironmentVariable("IPAD_CONSOLE_INPUT_TEST");
                        var accessory = Environment.GetEnvironmentVariable("IPAD_CONSOLE_ACCESSORY_TEST");
                        if (!string.IsNullOrEmpty(input)) EnableHardwareOcr(core, Path.Combine(Path.GetDirectoryName(input),"HardwareScreenText.ps1"));
                        var arguments = new[] {
                            Json.Serialize(first),
                            string.IsNullOrEmpty(input) ? "null" : "(" + File.ReadAllText(input) + ")",
                            Json.Serialize(Environment.GetEnvironmentVariable("IPAD_CONSOLE_RECOVER_MARKER")),
                            string.IsNullOrEmpty(accessory) ? "null" : "(" + File.ReadAllText(accessory) + ")",
                            Environment.GetEnvironmentVariable("IPAD_CONSOLE_PREPARED_SEARCH") == "yes" ? "true" : "false",
                            Json.Serialize(new { iPad=Environment.GetEnvironmentVariable("IPAD_CONSOLE_KNOWN_IPAD"),
                                iPhone=Environment.GetEnvironmentVariable("IPAD_CONSOLE_KNOWN_PHONE") }),
                            Json.Serialize(Environment.GetEnvironmentVariable("IPAD_CONSOLE_CYCLE_DEVICE")),
                            Environment.GetEnvironmentVariable("IPAD_CONSOLE_AUDIT_PHONE_RADIO") == "yes" ? "true" : "false",
                            Environment.GetEnvironmentVariable("IPAD_CONSOLE_NAMES_ONLY") == "yes" ? "true" : "false"
                        };
                        var script = "(" + File.ReadAllText(hardware) + ")(" + string.Join(",",arguments) + ")";
                        if (!string.IsNullOrEmpty(accessory)) script = File.ReadAllText(Path.Combine(Path.GetDirectoryName(accessory),
                            "accessory-validation.hardware.js")) + "\n" + script;
                        var result = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", Json.Serialize(new {
                            expression = script, awaitPromise = true, returnByValue = true, userGesture = true
                        }));
                        var parsed = Json.Deserialize<Evaluation>(result);
                        var report = parsed.result == null ? null : parsed.result.value as string;
                        if (string.IsNullOrEmpty(report)) throw new Exception("No hardware verification report");
                        Console.WriteLine(report);
                        if (!report.EndsWith("PASS", StringComparison.Ordinal)) throw new Exception("Hardware verification incomplete");
                        exit = 0;
                        return;
                    }
                    await CheckScript(core, "document.getElementById('usb-canvas') instanceof HTMLCanvasElement && document.getElementById('device-picker') instanceof HTMLDialogElement && !document.querySelector('video, #share')", "USB preview and device picker");
                    // Only the authenticated status above talks to the real service.
                    // Select and rename synthetic devices through the actual window.
                    await CheckScript(core, @"(async () => {
                        const devices = ['a','b'].map(x => ({id:x.repeat(32),name:'测试平板',family:'iPad',driver:'ready'}));
                        let active, alias = '';
                        api = async (route,data) => {
                            if (route === 'devices') return {devices};
                            if (route === 'device/alias') return {alias:alias=data.alias};
                            if (route === 'status') return {activeDeviceId:active,state:'connected',active:1,keyboardActive:1,
                                needsPairing:false,deviceAlias:alias,displayState:'live'};
                            if (route === 'control/start') return {lease:'sample-lease'};
                            return {};
                        };
                        playUsbVideo = ({deviceId,canvas,onFrame,signal}) => {
                            active=deviceId; canvas.width=800; canvas.height=600;
                            onFrame(1,0,'iPad');
                            return new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
                        };
                        await chooseUsbDevice(false);
                        const options=$('device-list').children;
                        if (options.length!==2 || options[0].textContent===options[1].textContent) return false;
                        options[1].click();
                        for(let i=0;!usbLive && i<50;i++) await new Promise(r=>setTimeout(r,10));
                        await updateBluetooth();
                        $('alias-input').value='会议平板';
                        await $('device-alias').onsubmit(new Event('submit'));
                        return $('preview-heading').textContent==='会议平板 · BBBBBBBB' && $('source-status').textContent===$('preview-heading').textContent;
                    })()", "select and name the second identical tablet");
                    var bounds = form.Bounds;
                    await CheckScript(core, "monitor.requestFullscreen().then(()=>document.fullscreenElement === monitor)", "enter fullscreen");
                    await Task.Delay(150);
                    if (form.FormBorderStyle != FormBorderStyle.None || form.Bounds != Screen.FromControl(form).Bounds)
                        throw new Exception("Host did not cover the current monitor");
                    await CheckScript(core, "$('control').onclick().then(()=>document.pointerLockElement===usbCanvas && monitor.classList.contains('captured'))", "capture pointer");
                    await CheckScript(core, @"(() => {
                        const label=$('fullscreen-target'), box=label.getBoundingClientRect();
                        return box.width>0 && box.height>0 && box.bottom<=innerHeight && getComputedStyle(label).pointerEvents==='none' &&
                            label.textContent.includes('会议平板 · BBBBBBBB') && label.textContent.includes('正在操控');
                    })()", "visible non-intercepting fullscreen control target");
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
    public class ConsoleEntry { public Result[] args { get; set; } }
}
