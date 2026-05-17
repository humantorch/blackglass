# Blackglass

[![GitHub release](https://img.shields.io/badge/release-v1.0.1-blue)](https://github.com/humantorch/blackglass/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.6%2B-7c3aed)](https://obsidian.md)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](https://github.com/humantorch/blackglass#requirements)
[![Python 3](https://img.shields.io/badge/python-3.6%2B-blue)](https://www.python.org/downloads/)

Blackglass puts [Claude Code](https://claude.ai/code) inside Obsidian: not a reimplementation, not a wrapper, but the actual CLI running in a real terminal alongside your notes. Every slash command, every MCP tool, every session you'd have in a standalone terminal is available here. If you already use Claude Code, there's nothing new to learn.

The vault MCP server is what makes it vault-native: a built-in server gives Claude structured, authenticated access to your notes (reading, searching, and writing) without any configuration on your part.

![Blackglass screenshot](assets/screenshot.png)

## Features

- **Real Claude Code terminal**: not a chat UI or a wrapper; the actual Claude Code CLI running in a full xterm.js terminal in your sidebar. All slash commands, all MCP tools, full session continuity.
- **Built-in vault MCP server**: gives Claude structured read/write access to your notes the moment the plugin loads; no configuration required
- **Authenticated MCP server**: auto-generated Bearer token written to `.mcp.json` on every launch; any other local process is denied access
- **Read-only vault mode**: optional setting to hide write tools from Claude entirely, limiting it to read and search only
- **Quick ask modal**: one-shot queries using Claude Code's `--print` mode; no terminal required; renders responses as Markdown
- **File explorer context menu**: right-click any `.md` file and choose "Ask Claude about this" to query Claude about it without opening it
- **Vault-aware quick ask**: pre-fill the modal with the active note or selected text
- **Per-query model selector**: choose the model directly in the quick ask modal; overrides the default without changing your setting
- **Session resume**: picks up where you left off (`--continue`) on every open
- **Desktop-only**: takes full advantage of Electron's native process support

## Requirements

- Obsidian desktop app (1.6.0+)
- [Claude Code CLI](https://claude.ai/code) installed and on your PATH (`claude --version` should work in your terminal)
- Python 3 (used by the terminal bridge; ships with macOS, available via your package manager on Linux)

**Platform support:** The interactive terminal requires macOS or Linux. The Quick Ask modal works on all platforms including Windows. Full Windows terminal support is planned for a future release.

## Installation

Blackglass is not yet listed in the Obsidian Community Plugin directory. Install manually:

1. Go to the [latest release](https://github.com/humantorch/blackglass/releases/latest) and download `blackglass-X.X.X.zip` from the Assets section
2. Unzip it and copy the three files (`main.js`, `styles.css`, `manifest.json`) into:
   ```
   <your-vault>/.obsidian/plugins/blackglass/
   ```
3. Open Obsidian → Settings → Community Plugins → enable **Blackglass**

## Commands

All commands are available via the command palette (Cmd+P):

| Command | Description |
|---|---|
| Open Claude Code terminal | Opens the sidebar terminal panel |
| Ask Claude (quick) | Opens a quick-ask modal (print mode, no terminal needed) |
| Ask Claude about this note | Prefills the modal with the current note's content |
| Ask Claude about selection | Prefills the modal with the selected text |
| Start new Claude Code session | Kills the current session and starts a clean fresh one |

A ribbon icon (bot) also opens the terminal panel directly. The terminal toolbar has a **New session** button that does the same thing; it always starts completely fresh, regardless of the "Resume last session" setting.

Right-clicking any `.md` file in the file explorer shows an **Ask Claude about this** option, which opens the quick ask modal prefilled with that note's content.

## Settings

Settings → Blackglass:

| Setting | Default | Description |
|---|---|---|
| Claude binary path | `claude` | Path to the `claude` CLI. Use full path if not on PATH. |
| Working directory | *(vault root)* | Directory Claude starts in. Defaults to vault root. |
| Quick ask model | Default | Model used by the quick ask modal. Can be overridden per-query in the modal itself. |
| Terminal font size | `14` | Font size in pixels. |
| Terminal font family | `monospace` | Font family dropdown populated from your system fonts. Falls back to a curated monospace list if font enumeration is unavailable. |
| Open panel on startup | off | Auto-open the terminal when Obsidian launches. |
| Resume last session | on | Passes `--continue` to resume the previous conversation. |
| Enable vault MCP server | on | Starts the built-in MCP server. Disable to run without vault tool access. |
| MCP server port | `27123` | Port the MCP server binds to. Increments automatically if the port is in use. Valid range: 1024-65535. |
| Read-only vault access | off | Hides `create_note` and `update_note` from Claude. Claude can still read and search notes. |
| Skip permission prompts | off | Passes `--dangerously-skip-permissions` to Claude Code. Claude will execute tool calls without asking for confirmation. Only enable for trusted tasks. |

## Vault MCP server

Blackglass includes a built-in MCP server that gives the embedded Claude Code session structured access to your vault. When enabled (on by default), the plugin:

1. Starts a local HTTP server on `localhost:27123` (or the next available port)
2. Generates a random Bearer token and writes it alongside the server address into `.mcp.json` so Claude Code authenticates automatically
3. Removes the entry when the plugin unloads

The server requires a valid `Authorization: Bearer <token>` header on every request. The token is regenerated each time the plugin loads, so any other local process that previously had the token loses access after a restart.

Claude Code gains the following vault tools:

| Tool | Description |
|---|---|
| `read_note` | Read a note's full content by vault-relative path |
| `list_notes` | List notes and subfolders at a path (defaults to vault root) |
| `search_vault` | Find notes whose path or filename matches a query string |
| `search_note_content` | Full-text search across note content, returns matching lines with context |
| `get_active_note` | Get the path and content of the currently open note |
| `create_note` | Create a new note at a vault-relative path |
| `update_note` | Replace the content of an existing note |

`search_note_content` accepts an optional `directory` argument to limit the search to a subtree, and an optional `max_results` argument (default 10, max 50). Each result includes up to 3 matching lines with surrounding context so Claude can decide which notes to read in full.

To disable the MCP server, toggle it off in Settings - Blackglass - "Enable vault MCP server". To use a different port, change the "MCP server port" setting (valid range: 1024-65535). To prevent Claude from writing to your vault, enable "Read-only vault access"; this hides `create_note` and `update_note` from Claude entirely.

**Note:** `.mcp.json` in the vault root is managed by Blackglass. If you already have a `.mcp.json` with other servers, Blackglass will merge its `mcpServers.obsidian` entry rather than overwriting the whole file.

## Network usage

Blackglass itself communicates only over localhost: the vault MCP server binds to `127.0.0.1` and is never exposed to the network.

The Claude Code CLI that Blackglass runs is a separate process that sends your prompts and conversation history to [Anthropic's API](https://www.anthropic.com) over HTTPS. This is the same network activity that occurs when you use Claude Code in a terminal. Blackglass does not transmit any data to Anthropic directly; all API communication is handled by the Claude Code CLI using your own account and API credentials.

## Security

Blackglass gives Claude Code full shell access in the context of your vault's working directory. This means a note containing adversarial instructions (prompt injection) could (if read into Claude's context via `read_note`, `get_active_note`, or the quick ask commands) attempt to influence Claude's behaviour, including running shell commands.

**What Blackglass does:** All note content passed to Claude is wrapped in XML-style delimiters with an explicit instruction to treat it as data rather than instructions. This defends against naive and moderately sophisticated injection attempts. It is not a complete solution; a carefully crafted note could attempt to escape the wrapper, but it meaningfully raises the bar.

**What won't protect you:** The **Read-only vault access** setting removes the `create_note` and `update_note` MCP tools, but this is not a meaningful injection defence. A successful injection still has full shell access; it can exfiltrate data via `curl`, write files directly via the filesystem, or run any other shell command. Read-only mode is useful if you want to prevent accidental vault writes during a browsing or query session; it should not be mistaken for a security boundary.

**Recommended practices:**

- Be cautious running "Ask Claude about this" on notes from untrusted sources: web clips, shared vaults, downloaded templates
- The terminal panel is interactive; you see Claude's responses before anything executes, which is a meaningful check on unexpected behaviour

## Building from source

### Prerequisites

- Node.js 18+
- Python 3
- Claude Code CLI on your PATH

### Steps

```bash
git clone git@github.com:humantorch/blackglass.git
cd blackglass
npm install
npm run build   # Produces main.js
```

Then copy `main.js`, `styles.css`, and `manifest.json` into your vault's plugin directory.

### Releasing

```bash
npm run release:patch   # 0.2.0 → 0.2.1
npm run release:minor   # 0.2.0 → 0.3.0
npm run release:major   # 0.2.0 → 1.0.0
```

Bumps the version in `manifest.json` and `package.json`, builds, commits, tags, and publishes a GitHub release with the zip attached. Requires the `gh` CLI to be authenticated.

### Development loop

```bash
npm run dev   # Watch mode — recompiles on every save
```

### Testing

```bash
npm test          # Run tests once
npm run test:watch  # Re-run on file changes
```

Integration tests cover the vault MCP server: auth, all seven tools, read-only mode, port fallback, and HTTP edge cases. Tests spin up a real HTTP server against a mock vault — no Obsidian instance required.

The PTY terminal, xterm.js rendering, and Obsidian plugin lifecycle are not covered by automated tests; verify those manually in the test vault.

Install the [hot-reload](https://github.com/pjeby/hot-reload) community plugin in a dedicated test vault, symlink this directory into its plugins folder, and the plugin will reload automatically as you edit.

```bash
mkdir -p /path/to/test-vault/.obsidian/plugins/
ln -s "$(pwd)" /path/to/test-vault/.obsidian/plugins/blackglass
```

The symlink folder name should match the plugin ID (`blackglass`) so Obsidian can locate it correctly.

**Never use your main vault for development testing.**

### Troubleshooting

**"Interactive terminal is not yet supported on Windows"**: the terminal requires macOS or Linux for now. Use the Quick Ask modal on Windows. Full Windows terminal support is planned for a future release.

**"Python 3 not found"**: install Python 3 from [python.org](https://www.python.org/downloads/) or via Homebrew (`brew install python3`). Python 3 ships with macOS 12.3+; if you're on an older version this may be missing.

**"Session ended with exit code 1" immediately**: Claude is either not on PATH or not found. Obsidian's Electron process does not inherit your full shell PATH. The plugin attempts to supplement PATH with common install locations (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, etc.), but if Claude is installed elsewhere the most reliable fix is to set the full path explicitly in Settings → Blackglass → "Claude binary path" (use `which claude` in your terminal to find it).

**"No previous session found, starting fresh"**: expected on first launch or in a new working directory. The plugin retries automatically without `--continue` and this message can be ignored.

**MCP servers not available inside the plugin**: Electron's process environment does not inherit your full shell profile, so environment variables like `GITHUB_PERSONAL_ACCESS_TOKEN` are absent by default. The plugin works around this by capturing the full login shell environment at startup (via `zsh -l -c "env"`), which should make any MCP servers that rely on shell-profile variables work automatically. If an MCP tool is still missing, check that the relevant environment variable is exported in your shell profile (`.zshrc`, `.zprofile`, etc.) rather than set only in a terminal session.

## Architecture

```
src/
├── main.ts                # Plugin entry, commands, settings load/save
├── types.ts               # Shared interfaces and constants
├── SettingsTab.ts         # Obsidian settings UI
├── ContextBuilder.ts      # Vault context extraction (file content, selection, paths)
├── ProcessManager.ts      # Claude subprocess management (PTY + print mode)
├── ClaudeTerminalView.ts  # xterm.js interactive terminal view
├── ClaudeQuickModal.ts    # One-shot query modal using --print mode
└── VaultMcpServer.ts      # Built-in MCP server exposing vault tools to Claude
```

**Dual-mode design:** The terminal view runs a persistent PTY session (full interactive Claude Code). The quick modal uses `claude --print --output-format json` for one-shot queries without needing an open terminal session.

## License

MIT
