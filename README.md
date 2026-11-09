<p align="center"><img src="./app/icon-256.png" width="72" alt="Claudex 时砂图标"></p>
<h1 align="center">Claudex</h1>
<p align="center">在一屏里查看 Claude Code 和 Codex 的额度，让中断的原会话到点接着跑。</p>
<p align="center"><a href="https://github.com/kyoka-shuiyue/Claudex/releases/latest">下载 Windows 发布包</a> · <a href="#开始使用">开始使用</a> · <a href="#从源码运行">从源码运行</a> · <a href="./LICENSE">MIT 许可证</a></p>

![Claudex 单屏界面，顶部显示恢复倒计时，左侧显示额度，中间排列待续会话，右侧设置继续消息](./assets/readme/dashboard.png)

*实际界面截图，使用演练数据展示等待队列。只有中间的会话列表滚动。*

## 到点后接上原来的任务

Claudex 在 Windows 本机读取 Claude Code 和 Codex 的会话记录，找出因额度不足中断的会话。用户启用真实发送后，额度恢复时会向对应原会话发送继续消息，沿用原有上下文。

- **默认每 5 分钟检测。** Codex 优先从只读账户接口获取套餐和额度，失败时显示历史读数、来源时间与原因。账户没有返回的周期单独标明。
- **逐个决定是否继续。** 可查看完整续接命令、跳过或恢复会话，同一次中断只提交一次。
- **先演练再发送。** 初始模式记录将执行的命令，便于先检查队列和设置。
- **一屏操作。** 额度、检测状态、主要设置和 Codex 连接结果固定显示，会话列表单独滚动。

## 开始使用

需要已安装 **Ego Browser（Ego Lite）**，以及准备使用并已登录的 Claude 桌面应用、Claude Code CLI 或 Codex 本机 CLI。

1. 从 [Releases](https://github.com/kyoka-shuiyue/Claudex/releases/latest) 下载 Windows ZIP，完整解压。
2. 双击 **安装Claudex.cmd**，默认安装到 `%LOCALAPPDATA%\Programs\Claudex`，并创建桌面快捷方式。
3. 打开桌面 **Claudex**，顶栏会显示运行状态、最近检测时间和下一次检测倒计时。
4. 保持演练模式，点击「立即检测」，检查额度、等待会话、继续消息和已演练的记录。

发布包附带 Node.js 运行时。也可以直接运行解压目录中的 `Claudex.exe`，按便携方式使用。

关闭窗口后，后台继续检测。需要结束后台时，运行安装目录里的 **停止Claudex.cmd**。同一目录重复启动会复用后台。更换运行目录前，先停止当前这一份。

### 发送模式

开启「真实发送」后，符合条件的等待会话会收到续接消息。右侧「试发 Codex」是独立连接测试，即使队列处于演练模式，也会向专用测试会话发送一条真实消息。

「沿用原权限」会继承原 Codex 会话最近一轮的 `sandbox_mode`。选择完全访问的原会话时，续接任务也会获得相应访问能力。系统代理开关将代理设置传给 CLI 子进程；Claude CLI 可在配置中用 `claude.useSystemProxy=false` 关闭。CLI 会使用自己的登录与服务商配置。

发送记录显示连接、桌面收信、思考、可见回复与工具回执。点击桌面记录可查看各阶段用时。只有原任务分支的工具请求收到匹配的成功结果，才会显示工具已执行。本轮只回复文字会单独标注，审批或工具异常可回到 Claude 查看。等待核对的请求继续占用同一次投递记录，避免重发。关闭自动发送会停止自动批次中尚未启动的项目和待执行的自动重试。

### Claude 桌面接入

在右侧选择「启用本地接入」，查看变更后确认安装。软件会先备份 Claude 设置，再追加自己的 `SessionStart` 钩子，保留已有设置。新启动或恢复的会话会运行一个本地接入子进程。

桌面会话通过自己的本机消息 inbox 接收继续。Claude 为这类请求添加同伴来源说明，并沿用原会话的登录、模型和权限。原会话要求人工确认时，需要在 Claude 中批准相应操作。尚未连接时，Claudex 会尝试在桌面打开原会话。

恢复后的默认缓冲为 5 秒，任务默认不额外排队。CLI 两分钟没有开始回复时会停止该次请求；已开始执行的长任务继续运行。消息投递确认与模型等待分别计时，网络与模型速度仍会影响回复时间。

## 当前验证范围

| 项目 | 已有验证 |
| --- | --- |
| 单屏布局 | Ego 中以 100% 缩放验证 1440×960、1280×760、1024×768，41 条会话实际滚轮测试 |
| 队列与设置 | 跳过和恢复、长消息保存、发送间隔、失败重试去重、演练记录 |
| Windows 入口 | 启动、重复启动复用后台、停止和端口释放 |
| Codex 原会话续接 | 专用测试会话实发成功，保留上下文和沙箱权限 |
| Codex 账户识别 | 实际只读 RPC 获取套餐与本周额度，支持缺失周期和历史读数回退 |
| Claude Code 续接 | 独立测试会话真实续接成功，会话 ID 一致，并正确回忆上一轮验证标记 |
| Claude 桌面投递 | 本机独立桌面会话保留上下文并完成文件读写；消息约 0.24 秒送达、7.3 秒开始回复、14.8 秒完成该测试（一次实测） |
| 重复请求与重启 | 真实桌面中 1,000 次调度请求及 1,000 次本地重放仅形成一条消息；调度器重启未重复发送 |

Claude Code 的精确额度依赖可选的状态栏同步。普通 CLI 续接记录可能稍后才同步到桌面，桌面接入直接向原桌面进程投递。开机自启和已有定时任务需要使用者单独配置。

## 从源码运行

需要 Node.js 22 或更高版本，本项目的应用代码采用 Node.js 内置模块。

```sh
npm test
npm start
```

`npm start` 启动本机服务并打开 Ego 窗口。命令行单次查看可运行 `npm run scan`。

在 Windows PowerShell 中构建带 Node.js 运行时的发布包，可将官方 Node.js Windows 解压目录传给构建脚本。该目录需同时包含 `node.exe` 和 `LICENSE`。

```powershell
.\launch\build.ps1 -NodeDirectory C:\tools\node-v22.22.3-win-x64
```

产物位于 `dist/Claudex-Windows-0.3.3.zip`。构建使用 Windows 自带的 .NET Framework C# 编译器生成启动器。

## 本机数据

界面服务只监听 `127.0.0.1:4317`。配置、队列状态、诊断结果和日志保存到用户目录下的 `.claudex`。会话数据从本机 `.codex` 和 `.claude` 目录读取。账户接口只调用 `account/read` 和 `account/rateLimits/read`，不发起模型回合，不保存邮箱、账户 ID 或凭据。本地桌面接入的临时 inbox token 只留在会话子进程内，不转存桌面账户凭据。`.claudex` 内的本地接入数据与设置备份也属于私人运行数据，不能上传。

接口与代理行为参照 [Codex app-server 文档](https://learn.chatgpt.com/docs/app-server)、[Claude 本机会话消息](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)与 [Claude 桌面环境配置](https://code.claude.com/docs/en/desktop#environment-variables-desktop-sets-itself)。

## 许可证

Claudex 源码采用 [MIT](./LICENSE)。字体和发布包内的 Node.js 各自保留原许可证，详情见 [第三方许可](./THIRD_PARTY_NOTICES.md)。

