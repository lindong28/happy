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

当前只完成本地协议与终端输入验证，尚未完成 App Store 客户端、官方中继和多机验收。现有 Happy 默认模型、推理强度及审批预设会覆盖部分 Codex 设置；本分支尚未解决完整的原配置继承。通用 MCP 表单、自定义 ask-user、进程重启后问题恢复、手机通知及断网恢复仍待验收。请勿将本分支直接替换日常入口。

定向回归（在 `packages/happy-cli` 下执行）：

```bash
pnpm exec vitest run --project unit src/codex/userQuestions.test.ts src/codex/questionForms.test.ts src/codex/codexQuestions.test.ts src/codex/codexPrompt.test.ts src/codex/codexAppServerClient.test.ts
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
