# 无桌面操控能力时，用本机命令

让用户在目标设备的控制台窗口保持投屏，退出手动操控，再点 **允许助手控制**。只保留一个已授权的窗口。脚本在当前 Windows 用户下发现该窗口，无需复制令牌或填写端口。

## 找到工具与目标

以下命令适用于 PowerShell 和 MSI 安装版，安装目录可以自定义。从源码运行时，改用仓库根目录的 `assistant.js` 和本机 Node.js。

```powershell
$installDir = Get-ItemPropertyValue -Path 'HKCU:\Software\LiuJH12138\iPadControlConsole' -Name InstallDirectory -ErrorAction Stop
$node = Join-Path $installDir 'runtime\node.exe'
$cli = Join-Path $installDir 'assistant.js'
function Invoke-Device {
    & $node $cli @args
    if ($LASTEXITCODE -ne 0) { throw '控制台命令未完成，请核对设备和画面。' }
}
$status = Invoke-Device status | ConvertFrom-Json
if (!$status.activeDeviceId -or !$status.assistantEnabled) { throw '请先在目标投屏窗口授权。' }
$status.activeDeviceId.Substring($status.activeDeviceId.Length - 8).ToUpperInvariant()
```

最后一行输出与窗口标题对应的八位短码。与用户指定的设备核对；目标仍不明确时，请用户确认窗口上的短码。提示「请在一个正在投屏的控制台窗口中点『允许助手控制』」时，检查是否没有授权或同时授权了多个窗口。

## 看一帧，再做下一步

```powershell
$frame = Join-Path ([IO.Path]::GetTempPath()) ('ipad-console-' + [guid]::NewGuid() + '.jpg')
Invoke-Device frame $frame
$frame
```

用读图工具打开命令成功后输出的 JPEG 路径。以**原图左上角为原点**，从原图确定目标的像素坐标。查看器若缩放了图片，先换算回原图。如果每次命令调用都新开 PowerShell，请在每次调用开头重新运行上面的初始化段并核对短码。取图时可以生成新的临时路径，把这次输出的路径交给读图工具。

| 要做的事 | 命令与判断 |
| --- | --- |
| 点击已识别的目标 | 将 `$x`、`$y` 设为刚读到的整数坐标，执行 `Invoke-Device click $x $y`。坐标点击需要绝对指针通道。若提示不支持，可用 `move DX DY` 相对移动，重新取图看到指针确实在目标上，才执行无参数的 `click`。 |
| 在已获得焦点的框内输入 | 例如 `Invoke-Device type '7319'`。`type` 每次支持 1–120 个英文字母、数字或空格。退格用 `Invoke-Device key Backspace`。中文需在设备端用拼音输入并看图选词。 |
| 检查结果 | 再执行 `Invoke-Device frame $frame` 并重新打开文件。若仍看到上一帧，短暂等待，再取图核对。命令报错时不要把磁盘上的旧 JPEG 当作本次结果。 |

例如搜索任务分为三次观察：点之前检查目标，点之后确认搜索框获得焦点，输入后读回实际文字。只有任务要求清理时才清理，并再次读回。若输入超时，先检查文字是否已经出现，避免重复输入。切换设备、旋转或重新授权后，从 `status` 和新图重新开始。

用完请用户在授权窗口点 **停止助手控制**，并清理本次创建的临时帧。若用户要求保留截图，按其指定位置保存。读图只需要 USB 投屏及窗口授权；执行键鼠输入还需要相应的蓝牙通道和设备核对。
