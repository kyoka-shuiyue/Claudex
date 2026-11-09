# Claudex 开发约定

Claudex 是 Windows 本机额度监控与原会话续接工具。应用代码使用 Node.js 内置模块，最低版本为 Node.js 22。

- app/ 提供单屏界面。live.js 与 live.css 负责实时模式，claudex.js 提供演练状态展示。
- server/ 提供本机接口、会话解析、队列、发送和诊断。server/test/ 为回归测试。
- launch/ 包含 Windows 启动、停止、安装和构建入口。PowerShell 文件采用 UTF-8 BOM，并保持 Windows PowerShell 5.1 兼容。
- 默认 dryRun=true。确认框、跳过选择、同次中断去重及原会话上下文是产品行为。
- 使用 npm test 验证修改。Windows 发布包通过 launch/build.ps1 构建。
- 界面验收使用 Ego Browser。1440×960、1280×760、1024×768 的 100% 缩放视口均只允许中间会话列表滚动。
- 会话、账户、配置和日志存放在用户目录，发布源码和构建产物应只包含应用文件。
- Codex 账户只使用 account/read 和 account/rateLimits/read；不保存邮箱、账户 ID 或凭据。网络失败须保留历史读数的时间与来源。
- Claude 续接用同会话的完整回合结果确认；失败重试前重读原会话，用户已手动继续的任务不再自动接管。


- Claude Desktop 使用用户明确批准安装的 SessionStart 接入；消息 UUID 落入原会话并有有效回复才确认接上，未知结果保持去重。不要用另一套 CLI 登录替代桌面登录。
- 本地会话 inbox token 只留在会话子进程，独立 helper 不继承 API 凭据。注册、回执和设置备份属于私人运行数据，不能进入发布包。
- 发送与重试前检查用户是否自行继续；未提交新消息的接入失败不得丢失此前提交的归属。不同 Store 的默认队列与嵌套配置必须隔离。

- 桌面续接须区分思考、文字、工具请求和对应的回执；只核对原会话本轮分支。自动批次及延时重试遵守当前总开关。
