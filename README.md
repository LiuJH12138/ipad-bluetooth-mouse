<h1 align="center">iPad Bluetooth Mouse</h1>

<p align="center">
  从 Windows 用蓝牙控制 iPad 指针的 PowerShell 脚本
</p>

<p align="center">
  <strong>Windows 11</strong> &nbsp;·&nbsp; <strong>Windows PowerShell 5.1</strong> &nbsp;·&nbsp; <strong>Bluetooth LE HID</strong>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> &nbsp;·&nbsp;
  <a href="#命令">命令</a> &nbsp;·&nbsp;
  <a href="#常见问题">常见问题</a>
</p>

## 工作方式

脚本让 Windows 电脑以标准低功耗蓝牙鼠标的身份广播。iPad 配对后，可以接收移动、左键点击和滚轮命令。想在电脑上看实时画面时，再打开自己熟悉的投屏工具。

```mermaid
flowchart LR
    Windows["Windows PowerShell"] -->|"蓝牙 LE HID · 移动 / 点击 / 滚动"| iPad["iPad"]
    iPad -->|"可选 · USB 或 AirPlay"| Preview["Windows 投屏窗口"]
```

适合已经能投屏、还想从 Windows 发出鼠标操作的场景。蓝牙控制在两台设备之间传输，脚本使用 Windows 自带的 WinRT 接口，无需额外安装控制端或 iPad App。

## 准备

- 一台运行 **Windows 11** 的电脑，蓝牙适配器需支持 **Bluetooth LE 外设角色**。仅支持扫描和连接其他设备的适配器可能无法广播。
- 一台可连接蓝牙鼠标的 iPad。运行时打开两端蓝牙，保持 iPad 解锁并处于蓝牙覆盖范围内。 [Apple 蓝牙鼠标连接指南](https://support.apple.com/zh-cn/108938)
- 使用系统自带的 **Windows PowerShell 5.1**（`powershell.exe`）。可选投屏工具可单独使用，例如 [爱思投屏](https://www.i4.cn/pro_screen.html) 的 USB 投屏。

## 快速开始

1. 下载仓库里的 [IpadBluetoothMouse.ps1](IpadBluetoothMouse.ps1)，在脚本所在目录运行：

   ```powershell
   powershell.exe -NoProfile -File .\IpadBluetoothMouse.ps1
   ```

2. 看到 `READY` 后，在 iPad 的「设置 → 蓝牙」中选择脚本显示的 Windows 电脑名。若 Windows 弹出「添加设备」，在两端核对配对码后确认。
3. 在脚本窗口输入 `status`。看到 `active mouse connections: 1` 后，输入 `move 40 0` 检查指针是否向右移动，再把指针移到目标上输入 `click`。
4. 输入 `quit` 结束脚本并停止广播。

## 命令

| 命令 | 操作 | 示例 |
| --- | --- | --- |
| `status` | 查看广播、订阅和活动连接状态 | `status` |
| `move X Y` | 相对移动指针。正值分别向右和向下 | `move 40 -20` |
| `click` | 在指针当前位置左键点击 | `click` |
| `scroll N` | 发送垂直滚轮输入 | `scroll -3` |
| `quit` | 停止广播并退出 | `quit` |

移动和滚轮的每个参数都接受 `-127` 到 `127` 的整数。实际移动距离会受 iPad 的指针速度设置影响。

## 常见问题

| 现象 | 处理办法 |
| --- | --- |
| 启动显示 `Aborted` | 确认 Windows 蓝牙已开启，退出其他脚本实例后重试。持续失败时，检查蓝牙适配器是否支持外设角色。 |
| iPad 显示「已连接」，但 `status` 显示 0 | 检查 Windows 是否还在等待确认配对。可在 iPad 的「辅助功能 → 触控 → 辅助触控 → 设备」查看指针设备，并重新连接。 |
| 工具显示画面，点击没有反应 | 在 PowerShell 窗口输入鼠标命令。投屏窗口用于观察画面，脚本通过蓝牙发送输入。 |
| 出现多台活动设备 | 断开其他设备，让 `status` 只显示 1 台活动鼠标连接。脚本要求活动连接唯一才发送输入。 |

蓝牙指针设备的设置入口可参阅 [Apple 辅助触控指南](https://support.apple.com/zh-cn/111775)。

## 实机验证

在 Windows 11 和 iPadOS 17.6.1 上，完成了蓝牙配对、指针移动和左键点击。通过爱思投屏的 USB 预览，确认蓝牙点击打开了 iPad 的「时钟」。脚本还会拒绝超出范围的移动参数；其他系统和适配器组合需要自行验证。
