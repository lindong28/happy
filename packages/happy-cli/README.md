# Happy

Code on the go — control AI coding agents from your phone, browser, or terminal.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g happy
```

> Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

## Usage

### Claude Code (default)

```bash
happy
# or
happy claude
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device or browser
3. Allow real-time session control — all communication is end-to-end encrypted
4. Start new sessions directly from your phone or web while your computer is online

### More agents

```
happy codex
happy agy        # Antigravity CLI (Gemini's successor)
happy gemini     # deprecated — use `happy agy`
happy openclaw

# or any ACP-compatible CLI
happy acp opencode
happy acp -- custom-agent --flag
```

> **Note on agy permissions:** the agy backend runs `agy --print`, which is
> one-shot and has no interactive approval surface — tool calls proceed
> automatically without ever prompting you. The permission mode you pick in
> Happy only chooses which flag is passed to agy: the default modes use
> `--sandbox`, and the bypass/yolo-style modes (including `acceptEdits`) use
> `--dangerously-skip-permissions`. Neither adds a per-tool approval gate
> inside Happy, so selecting "default" for an agy session does **not** give
> you an approval prompt the way it does for Claude Code.

### Codex 手机接续：开发分支验证状态

本开发分支正在补齐 Codex 原生提问与 Happy 表单之间的转接，并为终端增加文本输入。`Enter` 提交、`Ctrl-U` 清空草稿；手机与终端的普通输入进入同一 Happy 会话队列。这里的终端界面不是完整的 Codex TUI。

同步提问通过 `item/tool/requestUserInput` 回答；异步提问使用 Codex 的 `send_user_message_question_reply` 包装，绑定原线程。明确被拒绝的答复可以重试；送达结果未知时不会自动重发。原生请求撤回、清空上下文和取消时会撤销相应待答控件。秘密输入不使用普通手机表单。

2026-11-11 的无模型探针先通过官方中继取得 iPhone 消息往返，以及选择、自由文字两种表单的提交和电脑回显读数。随后真实 Codex 测试取得下述单机、多机和恢复结果；手机通知仍待验收。安装须使用配套 fork，不能用上游 npm 包替代。

本分支另提供实验参数 `happy codex --native-config`：让 Codex 从启动环境读取自身配置，Happy 不传模型、推理强度、审批或沙箱覆盖，不注入标题 MCP，也不按 Happy 权限预设自动批准。参数与模型、权限等覆盖参数冲突时拒绝启动；Happy 自身沙箱开启时同样拒绝。此模式标记保存在会话 metadata，供 `happy resume <happy-session-id>` 的恢复参数构造使用，不需要迁移既有会话。

实验模式会忽略手机消息携带的模型、推理强度和权限选择，并在会话中提示。实测官方 iPhone 的 Codex 权限菜单不采用发布的权限目录；配套 [iOS fork](../happy-ios/README.md#codex-native-configuration-development) 提供只读配置显示，读取实际 thread/start 或 thread/resume 返回值，不以手机默认设置替代。普通 `happy codex` 保持上游的 Happy 配置预设。

希望手机新建也采用该模式时，在启动 daemon 前设置 `HAPPY_CODEX_NATIVE_CONFIG=1`。配套 iOS fork 根据机器能力显示只读 Local settings，实际模型在会话启动后更新。这个 daemon 的新 Codex 会话拒绝手机传入的 token 或非空环境覆盖，使用电脑端选择的账号与配置；既有会话恢复仍依据自身保存的模式。

`--native-config` 保留 Codex 的 thread 配置，不会自动执行用户终端里的 shell 函数。需要复用函数中的 dotenv、账号选择及代理初始化时，设置 `HAPPY_CODEX_PATH` 为本机可执行适配器的完整路径；版本检查和 app-server 均调用该入口，参数按 argv 传递。适配器的 stdout 必须只输出 Codex 版本或 JSON-RPC，启动诊断放 stderr，并负责转发退出信号。个人安装入口及其依赖见 [system-config/happy-personal](https://github.com/lindong28/system-config/tree/main/happy-personal)（配套安装代码仍在开发，尚未发布）；其他采用者不需要该个人 shell 环境。

2026-11-11 的开发版本已在一台 MacBook 与一台 iPhone 14（iOS 27.2、Personal 开发签名）完成电脑输入、手机追问、原生同步/异步提问和 ask-user MCP 表单答复。MCP 表单覆盖字符串选项、可选题留空；其他 JSON Schema 类型仍按明确不支持处理。会话详情显示实际模型及完整权限/沙箱读数。退出 Happy 后可用 `codex resume <codex-thread-id>` 接回；退出原生 CLI 后，手机的 Resume Session 已恢复同一个 Happy 会话与 Codex thread，并保留前文上下文。切换前先退出当前执行端，避免两个执行器同时推进同一 thread。未启动 Happy 的原生 CLI 不会因此自动向手机同步输出。

测试中实际观察到原有 PreToolUse 提问 hook 的拦截及修正问题后的正常答复，不代表全部 hooks 均已验收。手机 Stop 后下一轮输入正常完成，用户切到蜂窝网络并确认收到 CELLULAR_OK。同一手机在 MacBook、Mac Studio、Mac mini 各选一个目录新建会话，两台远端 Mac 各完成原线程追问。mini 的待答表单在 App 退到后台和终止重启后仍可提交，回复保留原线程上下文。

工具审批在 MacBook 的独立 on-request/read-only 测试进程中覆盖单次批准、拒绝两种结果：手机批准后命令执行，拒绝后工具返回用户取消，下一轮输入仍可完成。没有修改全局审批设置。MacBook 的终端退出和 daemon stop-session 均使手机显示非活动；手机恢复后保留原线程上下文。Studio 的会话及 daemon 停止、daemon 重启后，手机 Resume Session 同样恢复原线程。停止的会话可能在主页“显示已归档”中；daemon 离线时先在对应 Mac 启动它，或使用页面的终端恢复命令。用户还完成了手机关闭蜂窝与 Wi-Fi 约 20 秒、恢复网络后在原 Studio 会话续问的测试。后台通知及最终分发仍待验证；未测试整机重启、系统睡眠或主机断网，不能用进程重启结果外推。以上是开发验证记录，不是正式发布声明。

定向回归（在 `packages/happy-cli` 下执行）：

```bash
pnpm exec vitest run --project unit src/codex/userQuestions.test.ts src/codex/questionForms.test.ts src/codex/codexQuestions.test.ts src/codex/codexPrompt.test.ts src/codex/codexAppServerClient.test.ts
pnpm exec vitest run --project unit src/codex/cliArgs.test.ts src/commands/codexCommand.test.ts src/resume/handleResumeCommand.test.ts src/codex/resumeExistingThread.test.ts src/codex/nativeConfigMetadata.test.ts src/codex/questionFormDisplay.test.ts
```

## Daemon

The daemon is a background service that stays running on your machine. It lets you spawn and manage coding sessions remotely — from your phone or the web app — without needing an open terminal.

```bash
happy daemon start
happy daemon stop
happy daemon status
happy daemon list
```

The daemon starts automatically when you run `happy`, so you usually don't need to manage it manually.

### Keeping the daemon running across reboots

If you want the daemon to come back automatically after a reboot — without opening a `happy` session first — start it from your shell profile so it inherits your normal user session context (PATH, keychain access, OAuth credentials):

```bash
# ~/.zshrc or ~/.bashrc
if [[ -o interactive ]] && [[ -z "$HAPPY_DAEMON_CHECKED" ]]; then
    export HAPPY_DAEMON_CHECKED=1
    () {
        local state=$HOME/.happy/daemon.state.json
        local pid=$(grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$state" 2>/dev/null | grep -oE '[0-9]+')
        if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
            happy daemon start >/dev/null 2>&1
        fi
    } &!
fi
```

The first interactive shell after a reboot triggers the start; subsequent shells short-circuit because the daemon is already running.

> **macOS users:** prefer this shell-init approach over a `launchd` LaunchAgent. A LaunchAgent runs in an agent domain that is **detached from your GUI/Aqua login session**, which means the bundled `claude-agent-sdk` cannot reach the macOS keychain and silently fails authentication ("Failed to authenticate. API Error: 401 terminated", `duration_api_ms: 0`). If you must use launchd, your wrapper has to read the OAuth access token from `~/.claude/.credentials.json` and export it as `CLAUDE_CODE_OAUTH_TOKEN` before exec'ing the daemon — and you'll need to handle token rotation yourself.

## Authentication

```bash
happy auth login
happy auth logout
```

Happy uses cryptographic key pairs for authentication — your private key stays on your machine. All session data is end-to-end encrypted before leaving your device.

To connect third-party agent APIs:

```bash
happy connect gemini
happy connect claude
happy connect codex
happy connect status
```

## Commands

| Command | Description |
|---------|-------------|
| `happy` | Start Claude Code session (default) |
| `happy codex` | Start Codex mode |
| `happy agy` | Start agy (Antigravity CLI) session |
| `happy gemini` | Start Gemini CLI session (**deprecated** — use `happy agy`) |
| `happy openclaw` | Start OpenClaw session |
| `happy acp` | Start any ACP-compatible agent |
| `happy resume <id>` | Resume a previous session |
| `happy notify` | Send push notification to your devices |
| `happy doctor` | Diagnostics & troubleshooting |

---

## Advanced

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HAPPY_SERVER_URL` | Custom server URL (default: `https://api.cluster-fluster.com`) |
| `HAPPY_WEBAPP_URL` | Custom web app URL (default: `https://app.happy.engineering`) |
| `HAPPY_HOME_DIR` | Custom home directory for Happy data (default: `~/.happy`) |
| `HAPPY_CODEX_NATIVE_CONFIG` | Set to `1` before starting the daemon to use local configuration for newly spawned Codex sessions |
| `HAPPY_CODEX_PATH` | Optional executable path used for Codex version checks and app-server startup; defaults to `codex` |
| `HAPPY_DISABLE_CAFFEINATE` | Disable macOS sleep prevention |
| `HAPPY_EXPERIMENTAL` | Enable experimental features |

### Sandbox (experimental)

Happy can run agents inside an OS-level sandbox to restrict file system and network access.

```bash
happy sandbox configure
happy sandbox status
happy sandbox disable
```

### Building from source

```bash
git clone https://github.com/slopus/happy
cd happy-cli
yarn install
yarn workspace happy cli --help
```

## Requirements

- Node.js >= 20.0.0
- For Claude: `claude` CLI installed & logged in
- For Codex: `codex` CLI installed & logged in
- For agy: install the Antigravity CLI (`agy`) and log in
- For Gemini (**deprecated** — use agy): `npm install -g @google/gemini-cli` + `happy connect gemini`

## License

MIT
