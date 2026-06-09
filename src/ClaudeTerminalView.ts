import { ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import type { FontWeight } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { shell } from "electron";
import type { ChildProcess } from "child_process";
import type ClaudeCodePlugin from "./main";
import { CLAUDE_ICON, CLAUDE_TERMINAL_VIEW_TYPE } from "./types";

/** Reads an Obsidian CSS variable from the current theme, falling back to a default. */
function cssVar(name: string, fallback: string): string {
	const value = getComputedStyle(activeDocument.body).getPropertyValue(name).trim();
	return value || fallback;
}

/**
 * Builds an xterm theme from the active Obsidian theme's CSS variables.
 * Background, foreground, and ANSI colors are derived from the theme so
 * third-party themes (e.g. Typewriter, Catppuccin) feel native rather than
 * clashing with hardcoded VS Code-style colors.
 * Hardcoded values are fallbacks for themes that don't define a given variable.
 */
function getXtermTheme(): object {
	const isDark = activeDocument.body.classList.contains("theme-dark");
	return {
		background:          cssVar("--background-primary",           isDark ? "#1e1e1e" : "#ffffff"),
		foreground:          cssVar("--text-normal",                  isDark ? "#d4d4d4" : "#383a42"),
		cursor:              cssVar("--text-normal",                  isDark ? "#d4d4d4" : "#383a42"),
		selectionBackground: cssVar("--text-selection",               isDark ? "#264f78" : "#c8def0"),
		black:               cssVar("--color-base-30",                isDark ? "#3a3a3a" : "#383a42"),
		red:                 cssVar("--color-red",                    isDark ? "#f44747" : "#e45649"),
		green:               cssVar("--color-green",                  isDark ? "#4ec9b0" : "#50a14f"),
		yellow:              cssVar("--color-yellow",                 isDark ? "#dcdcaa" : "#c18401"),
		blue:                cssVar("--color-blue",                   isDark ? "#569cd6" : "#0184bc"),
		magenta:             cssVar("--color-purple",                 isDark ? "#c678dd" : "#a626a4"),
		cyan:                cssVar("--color-cyan",                   isDark ? "#4ec9b0" : "#0997b3"),
		white:               cssVar("--color-base-70",                isDark ? "#d4d4d4" : "#fafafa"),
		brightBlack:         cssVar("--color-base-50",                isDark ? "#808080" : "#4f525e"),
		brightRed:           cssVar("--color-red",                    isDark ? "#f44747" : "#e45649"),
		brightGreen:         cssVar("--color-green",                  isDark ? "#4ec9b0" : "#50a14f"),
		brightYellow:        cssVar("--color-yellow",                 isDark ? "#dcdcaa" : "#c18401"),
		brightBlue:          cssVar("--color-blue",                   isDark ? "#569cd6" : "#4078f2"),
		brightMagenta:       cssVar("--color-purple",                 isDark ? "#c678dd" : "#a626a4"),
		brightCyan:          cssVar("--color-cyan",                   isDark ? "#4ec9b0" : "#0997b3"),
		brightWhite:         cssVar("--color-base-100",               isDark ? "#ffffff" : "#ffffff"),
	};
}

export class ClaudeTerminalView extends ItemView {
	private plugin: ClaudeCodePlugin;
	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private pty: ChildProcess | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private themeObserver: MutationObserver | null = null;
	private terminalInputDisposable: { dispose(): void } | null = null;
	private statusDot: HTMLElement | null = null;
	private mcpDot: HTMLElement | null = null;
	private mcpIndicator: HTMLElement | null = null;
	private versionLabel: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeCodePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CLAUDE_TERMINAL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Claude Code";
	}

	getIcon(): string {
		return CLAUDE_ICON;
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("claude-code-terminal-container");

		// Toolbar
		const toolbar = container.createDiv({ cls: "claude-code-toolbar" });

		const wordmark = toolbar.createDiv({ cls: "claude-code-wordmark" });
		wordmark.createSpan({ text: "Black" });
		wordmark.createSpan({ cls: "claude-code-wordmark-accent", text: "glass" });

		const newSessionBtn = toolbar.createEl("button", {
			text: "New session",
			cls: "claude-code-toolbar-btn",
		});
		newSessionBtn.title = "Start a new Claude Code session";
		newSessionBtn.addEventListener("click", (e) => {
			(e.currentTarget as HTMLButtonElement).blur();
			this.restartSession();
		});

		const clearBtn = toolbar.createEl("button", {
			text: "Clear",
			cls: "claude-code-toolbar-btn",
		});
		clearBtn.title = "Clear terminal output without ending the session";
		clearBtn.addEventListener("click", (e) => {
			(e.currentTarget as HTMLButtonElement).blur();
			this.terminal?.clear();
		});

		const sessionIndicator = toolbar.createDiv({ cls: "claude-code-indicator" });
		this.statusDot = sessionIndicator.createDiv({ cls: "claude-code-status-dot" });
		sessionIndicator.createSpan({ cls: "claude-code-indicator-label", text: "session" });
		this.statusDot.title = "No session";
		sessionIndicator.title = "No session";

		this.mcpIndicator = toolbar.createDiv({ cls: "claude-code-indicator" });
		this.mcpDot = this.mcpIndicator.createDiv({ cls: "claude-code-mcp-dot" });
		this.mcpIndicator.createSpan({ cls: "claude-code-indicator-label", text: "MCP" });
		this.updateMcpStatus();

		const version = this.plugin.manifest.version;
		const isPrerelease = /[^0-9.]/.test(version);
		this.versionLabel = toolbar.createDiv({ cls: "claude-code-version" });
		this.versionLabel.setText(`v${version}`);
		if (isPrerelease) this.versionLabel.addClass("claude-code-version--prerelease");

		if (this.plugin.availableVersion) {
			this.showUpdateAvailable(this.plugin.availableVersion);
		}

		// Terminal wrapper (fills remaining space)
		const xtermWrapper = container.createDiv({ cls: "claude-code-xterm-wrapper" });

		// Initialize xterm
		this.fitAddon = new FitAddon();
		const webLinksAddon = new WebLinksAddon((_event, uri) => shell.openExternal(uri));

		this.terminal = new Terminal({
			fontFamily: this.plugin.settings.fontFamily,
			fontSize: this.plugin.settings.fontSize,
			fontWeight: this.plugin.settings.fontWeight as FontWeight,
			theme: getXtermTheme(),
			cursorBlink: true,
			allowProposedApi: true,
			customGlyphs: true,
			scrollback: this.plugin.settings.scrollback,
		});

		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(webLinksAddon);
		this.terminal.open(xtermWrapper);

		// Fit after DOM is rendered
		window.setTimeout(() => {
			this.fitAddon?.fit();
			this.startSession();
		}, 50);

		// Resize observer to keep terminal sized to container
		this.resizeObserver = new ResizeObserver(() => {
			this.fitAddon?.fit();
			if (this.pty && this.terminal) {
				const cols = this.terminal.cols;
				const rows = this.terminal.rows;
				this.plugin.processManager.resizePty(this.pty, cols, rows);
			}
		});
		this.resizeObserver.observe(xtermWrapper);

		this.themeObserver = new MutationObserver(() => {
			if (this.terminal) this.terminal.options.theme = getXtermTheme();
		});
		this.themeObserver.observe(activeDocument.body, { attributeFilter: ["class"] });
	}

	private setSessionStatus(active: boolean): void {
		if (!this.statusDot) return;
		const title = active ? "Session active" : "Session ended";
		this.statusDot.toggleClass("claude-code-status-dot--active", active);
		this.statusDot.title = title;
		if (this.statusDot.parentElement) this.statusDot.parentElement.title = title;
	}

	private startSession(resumeLastSession?: boolean): void {
		if (!this.terminal) return;

		const { settings } = this.plugin;
		const shouldResume = resumeLastSession ?? settings.resumeLastSession;

		const workingDir =
			settings.workingDirectory ||
			this.plugin.contextBuilder.getVaultRoot() ||
			process.env.HOME ||
			"/";

		const startTime = Date.now();

		try {
			this.pty = this.plugin.processManager.startPtySession({
				claudePath: settings.claudeBinaryPath,
				workingDirectory: workingDir,
				resumeLastSession: shouldResume,
				skipPermissions: settings.skipPermissions,
				cols: this.terminal.cols,
				rows: this.terminal.rows,
			});
		} catch (err) {
			const msg = (err as Error).message;
			this.terminal.writeln(`\r\n\x1b[31mFailed to start Claude Code: ${msg}\x1b[0m`);
			if (process.platform === "win32" && msg.includes("Python")) {
				this.terminal.writeln(`\r\n\x1b[33mSetup steps:\x1b[0m`);
				this.terminal.writeln(`\r\n\x1b[33m  1. Install Python 3: https://www.python.org/downloads/\x1b[0m`);
				this.terminal.writeln(`\r\n\x1b[33m  2. Run in PowerShell: pip install pywinpty\x1b[0m`);
				this.terminal.writeln(`\r\n\x1b[33m  3. Reload Obsidian\x1b[0m`);
			} else if (process.platform === "win32") {
				this.terminal.writeln(
					`\r\n\x1b[33mCheck that '${settings.claudeBinaryPath}' is on your PATH. If pywinpty is missing: pip install pywinpty\x1b[0m`
				);
			} else {
				this.terminal.writeln(
					`\r\n\x1b[33mCheck that '${settings.claudeBinaryPath}' is on your PATH and that Python 3 is installed.\x1b[0m`
				);
			}
			return;
		}

		// Capture PTY reference so callbacks can detect if they've been superseded
		// by a newer session (e.g. user clicked New Session before this one exited).
		const thisPty = this.pty;

		thisPty.once("spawn", () => {
			if (this.pty === thisPty) this.setSessionStatus(true);
		});

		// PTY output -> terminal display
		const onData = (chunk: Buffer) => {
			const data = chunk.toString("utf-8");
			this.terminal?.write(data);
			// Force repaint when a TUI (e.g. /mcp dialog) exits the alternate screen.
			// Without this, xterm.js leaves rendering artifacts from the TUI overlay.
			if (data.includes("\x1b[?1049l")) {
				window.requestAnimationFrame(() => {
					this.fitAddon?.fit();
					if (this.pty && this.terminal) {
						this.plugin.processManager.resizePty(
							this.pty,
							this.terminal.cols,
							this.terminal.rows
						);
					}
				});
			}
		};
		thisPty.stdout?.on("data", onData);
		thisPty.stderr?.on("data", onData);

		// Catch spawn errors (e.g. binary not found) that arrive asynchronously.
		// Without this handler Node.js throws an uncaught exception which Electron swallows,
		// leaving the terminal silently empty.
		thisPty.on("error", (err: Error) => {
			if (this.pty !== thisPty) return;
			this.pty = null;
			this.setSessionStatus(false);
			const setupHint = process.platform === "win32"
				? " Python 3 and pywinpty are required (pip install pywinpty)."
				: " Check that Python 3 is installed.";
			this.terminal?.writeln(`\r\n\x1b[31mFailed to start Claude Code: ${err.message}\x1b[0m`);
			this.terminal?.writeln(`\r\n\x1b[33mCheck that '${settings.claudeBinaryPath}' is on your PATH.${setupHint}\x1b[0m`);
		});

		// PTY exit
		thisPty.on("close", (code: number | null) => {
			// If this PTY has already been replaced (e.g. New Session was clicked),
			// ignore the exit entirely — do not null out the newer session.
			if (this.pty !== thisPty) return;

			this.pty = null;
			this.setSessionStatus(false);

			const exitCode = code ?? 1;

			// If --continue caused an immediate exit (no previous session exists),
			// retry without it rather than showing an error.
			const elapsed = Date.now() - startTime;
			if (exitCode === 1 && shouldResume && elapsed < 3000) {
				this.terminal?.writeln(
					`\r\n\x1b[33m[No previous session found — starting fresh]\x1b[0m\r\n`
				);
				this.startSession(false);
				return;
			}

			this.terminal?.writeln(
				`\r\n\x1b[90m[Claude Code session ended with exit code ${exitCode}]\x1b[0m`
			);
		});

		// Terminal input -> PTY stdin.
		// Dispose any previous handler first — startSession can be called more than
		// once on the same terminal instance (e.g. the --continue retry), and leaving
		// stale handlers registered causes every keystroke to be written multiple times.
		this.terminalInputDisposable?.dispose();
		this.terminalInputDisposable = this.terminal.onData((data: string) => {
			if (this.pty) this.plugin.processManager.writePty(this.pty, data);
		});
	}

	private restartSession(): void {
		if (this.pty) {
			this.plugin.processManager.killPty(this.pty);
			this.pty = null;
		}
		this.setSessionStatus(false);
		// Full terminal reset — safe because the PTY is already dead.
		// Always starts fresh (ignores the resumeLastSession setting) since
		// the user is explicitly requesting a clean slate.
		this.terminal?.reset();
		this.startSession(false);
	}

	showUpdateAvailable(version: string): void {
		if (!this.versionLabel) return;
		this.versionLabel.setText(`v${version} ↑`);
		this.versionLabel.addClass("claude-code-version--update");
		this.versionLabel.title = `Blackglass ${version} is available — click to update`;
		this.versionLabel.onclick = () => {
			const app = this.plugin.app as unknown as {
				setting: { open(): void; openTabById(id: string): void };
			};
			app.setting.open();
			app.setting.openTabById("community-plugins");
		};
	}

	updateMcpStatus(): void {
		if (!this.mcpDot || !this.mcpIndicator) return;
		const mcpPort = this.plugin.vaultMcpServer?.getActualPort() ?? null;
		this.mcpDot.toggleClass("claude-code-mcp-dot--active", mcpPort !== null);
		const title = mcpPort !== null
			? `Vault MCP server running on port ${mcpPort}`
			: this.plugin.settings.mcpServerEnabled
				? "Vault MCP server failed to start"
				: "Vault MCP server disabled";
		this.mcpDot.title = title;
		this.mcpIndicator.title = title;
	}

	updateFont(size: number, family: string, weight: string): void {
		if (!this.terminal) return;
		this.terminal.options.fontSize = size;
		this.terminal.options.fontFamily = family;
		this.terminal.options.fontWeight = weight as FontWeight;
		this.fitAddon?.fit();
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.themeObserver?.disconnect();
		this.themeObserver = null;

		if (this.pty) {
			this.plugin.processManager.killPty(this.pty);
			this.pty = null;
		}

		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
	}
}
