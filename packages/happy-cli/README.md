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

原生手机模式恢复同一 UUID 时，后台须先取得该会话的独占锁。若普通 Codex 会话仍在运行，先在原终端退出，再执行 `codex-account resume UUID --account NAME --mobile`；不要删除锁文件或同时启动第二个执行器。出现 `Native mobile startup failed` 时，查看错误指向的 `worker.log`：账号适配器的锁冲突详情会保留在该日志，JSON 就绪协议保持独立。仅有 `Native session lease unavailable (exit 2)` 不能区分锁冲突与适配器其他错误，旧日志中已丢弃的详情无法补回。

原生手机模式恢复长会话时，先恢复 Codex 执行端，再向手机分页同步旧消息；模型仍使用原始上下文，不删减历史。聊天中的同步提示与终端可用状态分别表示两件事。历史读取或发送失败不会结束已恢复的 Codex；已同步消息保留，提示会说明尚未完成，电脑 Happy 日志保留阶段和原因。稍后停止该手机后台再恢复同一 UUID 可重试历史同步；单纯退出终端再接回仍复用原后台，不会重新同步。此行为限原生手机模式，普通 Happy 和 fork 的历史路径不变。

`codex-account --mobile` 的终端使用原生 Codex TUI，手机与终端连接同一个 Codex 线程。输入框为空时按两次 `Esc`，选择更早的用户消息后按 `Enter`，即可在原 UUID、原 Happy 聊天内回退；所选消息及之后的轮次退出上下文，所选输入回到终端编辑框。文件修改和外部操作不会撤销。运行中的轮次须先中断；真正的旧版 legacy 历史仍受 Codex 原生限制，不会自动分叉或改写为另一条会话。

此回退需要配套更新 Happy CLI 和 Happy Personal iOS。手机按持久化的 `codexRewind` 元数据过滤已回退轮次及其输入；原始中继消息和电脑 rollout 保留，不显示撤回分支。旧版手机历史首次接入时可从新基线开始，尚未执行的手机输入继续保留。回退先记录本地 intent，再调用 Codex；只有手机投影获得中继确认才返回成功。结果未知时查询原生历史，不盲目重复回退；同步失败后恢复同一会话可继续协调。不要删除 `native-chats` 检查点来处理此类故障。

2026-11-18，Codex 0.167.0 的隔离三轮会话已通过真实 TUI 双 `Esc` 回退：选第二轮后只保留首轮，UUID 不变、原 rollout 字节前缀保留。实际安装验收覆盖一台 MacBook、一台 iPhone、两个账号（lindong9/lindong10）、一个测试 UUID：四次模型输入、A→B→A 两次账号交接和三次桌面回退，始终保留同一 Happy 聊天。最终 iOS `7e76bfe` 先显示保留轮次的提问和回答，再随桌面回退隐藏剩余轮次；返回列表重开和终止 App 后重开均未重现。用户另确认断网重开及恢复网络两种状态均未重现。此结果不外推其他机器、手机或附件实机行为；非原生手机入口仍使用 Happy 自身的终端界面。

真机验收曾发现回答已隐藏但提问仍显示：原生用户消息缺少 turn，且本地数据库的聊天 metadata 投影丢失 codexThreadId。CLI `267bce1` 补齐用户消息的 turn；iOS 使用现有的线程/消息 ID 过滤升级前消息，并保留该线程 ID 到实际聊天消费者。回归覆盖真实消息映射与 LocalStore→FeedState 路径；完整 CLI 单测为 111 文件、1132 项通过，最终 iOS 投影测试 5 项通过。真机最后一轮使用 CLI `cf97959` 的既有测试后台，因此同时验到了升级前用户消息的兼容过滤；最终 CLI `267bce1` 已安装并恢复业务会话，没有追加模型调用。上述自动测试不代替限定范围的真机记录。

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
| `HAPPY_CODEX_ACCOUNT_NAME` | Optional local alias for a compatible personal account adapter; saved as `codexAccountName` and explicitly restored on resume, stripped from daemon/ordinary child inheritance. Not credentials. Leave unset for ordinary installations. |
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
