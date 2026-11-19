# iPad 控制台 · iPad Control Console

在 Windows 上通过 USB 实时查看 iPhone 或 iPad 的屏幕，用电脑的鼠标点按、拖动，用键盘打字。键鼠通过蓝牙连接，移动设备上无需安装 App。

**[下载多设备预览版 1.6.0-preview.5（Windows x64）](https://github.com/LiuJH12138/ipad-bluetooth-mouse/releases/download/v1.6.0-preview.5/iPad-Control-Console-1.6.0-preview.5-win-x64.msi)**　·　[下载稳定版 1.5.4](https://github.com/LiuJH12138/ipad-bluetooth-mouse/releases/download/v1.5.4/iPad-Control-Console-1.5.4-win-x64.msi)　·　[使用手册](docs/guide.md)

## 界面展示

**连接设备。** 用数据线连接并解锁设备，点 **一键配置** 开始投屏和键鼠设置。只想看屏幕时，点 **仅投屏**。[首次配置与故障恢复](docs/guide.md#首次配置)

![控制台首页。左侧分别显示 USB 投屏和蓝牙键鼠状态，中央提供「一键配置」和「仅投屏」。](docs/media/console-home.png)

**确认正在控制哪台设备。** 配对向导同时列出所选移动设备和要连接的电脑名称。多台设备可以保持连接，点 **切换设备** 选择当前目标。窗口标题和全屏提示都会显示设备名与八位短码，也可在 **连接详情** 保存本机别名。[多设备操作](docs/guide.md#同时接着-iphone-和-ipad) · [双机实测记录](docs/validation.md)

![预览版配对界面。示例设备「工作室的演示 iPad」处于仅预览状态，向导提示在设备上选择电脑 STUDIO-PC。](docs/media/console-pairing.png)

## 快速开始（稳定版 1.5.4）

准备一台 **Windows 11 x64** 电脑、一根支持数据传输的 USB 线，以及一台已解锁的 iPad。需要键鼠控制时，电脑的蓝牙适配器须支持 **BLE 外设角色**。

1. **安装并打开控制台。** 双击 MSI，按中文向导完成安装。旧版用户可先从托盘菜单选择「退出应用」再升级。
2. **先接画面。** 用数据线连接 iPad，在 iPad 上确认信任电脑，然后点「USB 直连」。出现实时画面后就能点右上角「全屏」。只想看屏幕，到这里即可。首次配置的电脑需要 Apple USB 驱动和设备过滤驱动。[USB 配置说明](docs/guide.md#usb-配置)
3. **再接键鼠。** 点「连接蓝牙」，在 iPad 的蓝牙设置里选择这台电脑并确认配对。要用 Windows 箭头直接点画面，可在 iPad 打开背景简单的静止页面，点控制台的「验证坐标」，看到「绝对坐标直达」后选「画面操控」。

## 选择操作方式

| 你想做什么 | 在控制台怎么做 |
| --- | --- |
| 演示、看屏或全屏预览 | 点「USB 直连」，然后按需收起左侧栏或切换全屏。 |
| 自己用键鼠操作 iPad | 「画面操控」可以直接点画面里的输入框并打字。「开始键鼠控制」会捕获电脑键鼠，适合连续移动、拖动和输入。按 `Esc` 释放。 |
| 让有 Computer Use 的 AI 操作 | 验证坐标后进入「画面操控」。AI 可以在窗口或全屏中看图、点目标、输入文字。「允许助手控制」可保持关闭。 |
| 让能执行本机命令的 AI 操作 | 保持投屏并退出手动控制，点「允许助手控制」。使用随附的 `assistant.js` 读图、点坐标、打字，再读图核对。用完点「停止助手控制」。[命令示例](docs/guide.md#本机助手控制) |

输入中文时，电脑切到英文输入法，在 iPad 上用拼音选字。USB 直连只传画面。当前版本支持鼠标和键盘输入，多点触摸与 Apple Pencil 尚未支持。滚轮响应取决于 iPad App。[键鼠操作说明](docs/guide.md#在投屏画面上使用键鼠)

## 隐私与授权

日常投屏时，画面在电脑本机解码。开启「允许助手控制」后，本机服务只在内存中保留最近一帧供已授权工具读取。超过 4 秒没有新的 USB 解码帧，助手读图会暂停。下一次操作会先用无按键的指针移动核对画面，确认画面恢复且目标一致才继续。把画面交给外部 AI 后，后续处理取决于该服务。[助手接口与授权说明](docs/guide.md#助手如何读取画面)

## 开发与支持

- [源码启动与环境要求](docs/guide.md#从源码运行) · [本机 API](docs/guide.md#本机接口) · [运行测试与构建 MSI](docs/guide.md#验证与开发)
- [USB、蓝牙与输入故障排查](docs/guide.md#边界与常见问题) · [提交问题](https://github.com/LiuJH12138/ipad-bluetooth-mouse/issues)
- [全部版本与 SHA-256 校验文件](https://github.com/LiuJH12138/ipad-bluetooth-mouse/releases)

<details>
<summary>English quick start · stable 1.5.4</summary>

Mirror an iPad on Windows 11 x64 over USB and control it with a Bluetooth mouse and keyboard emulated by the PC. No iPad app is required.

1. Install the Windows MSI, connect an unlocked iPad with a USB data cable, trust the PC, and select **USB 直连** (USB Direct). First-time setup requires the Apple USB driver and the device capture filter.
2. For input, select **连接蓝牙** (Connect Bluetooth) and pair the PC in iPad Settings. The PC must support the Bluetooth LE peripheral role. To click directly on the picture, open a still page, select **验证坐标** (Verify coordinates), then **画面操控** (Control on screen).
3. Use **全屏** for full screen. Press **Esc** to release captured input. A Computer Use agent can work directly in the window. For local scripts, opt in with **允许助手控制** and use the bundled `assistant.js`.

</details>
