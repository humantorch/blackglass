import { ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ChildProcess } from "child_process";
import type ClaudeCodePlugin from "./main";
import { CLAUDE_ICON, CLAUDE_TERMINAL_VIEW_TYPE } from "./types";

/** Returns a reasonable xterm theme based on Obsidian's current color scheme */
function getXtermTheme(): object {
	const isDark = document.body.classList.contains("theme-dark");
	if (isDark) {
		return {
			background: "#1e1e1e",
			foreground: "#d4d4d4",
			cursor: "#d4d4d4",
			selectionBackground: "#264f78",
			black: "#1e1e1e",
			red: "#f44747",
			green: "#4ec9b0",
			yellow: "#dcdcaa",
			blue: "#569cd6",
			magenta: "#c678dd",
			cyan: "#4ec9b0",
			white: "#d4d4d4",
			brightBlack: "#808080",
			brightRed: "#f44747",
			brightGreen: "#4ec9b0",
			brightYellow: "#dcdcaa",
			brightBlue: "#569cd6",
			brightMagenta: "#c678dd",
			brightCyan: "#4ec9b0",
			brightWhite: "#ffffff",
		};
	}
	return {
		background: "#ffffff",
		foreground: "#383a42",
		cursor: "#383a42",
		selectionBackground: "#c8def0",
		black: "#383a42",
		red: "#e45649",
		green: "#50a14f",
		yellow: "#c18401",
		blue: "#0184bc",
		magenta: "#a626a4",
		cyan: "#0997b3",
		white: "#fafafa",
		brightBlack: "#4f525e",
		brightRed: "#e45649",
		brightGreen: "#50a14f",
		brightYellow: "#c18401",
		brightBlue: "#4078f2",
		brightMagenta: "#a626a4",
		brightCyan: "#0997b3",
		brightWhite: "#ffffff",
	};
}

export class ClaudeTerminalView extends ItemView {
	private plugin: ClaudeCodePlugin;
	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private pty: ChildProcess | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private terminalInputDisposable: { dispose(): void } | null = null;

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

		const newSessionBtn = toolbar.createEl("button", {
			text: "New session",
			cls: "claude-code-toolbar-btn",
		});
		newSessionBtn.addEventListener("click", (e) => {
			(e.currentTarget as HTMLButtonElement).blur();
			this.restartSession();
		});

		// Terminal wrapper (fills remaining space)
		const xtermWrapper = container.createDiv({ cls: "claude-code-xterm-wrapper" });

		// Initialize xterm
		this.fitAddon = new FitAddon();
		const webLinksAddon = new WebLinksAddon();

		this.terminal = new Terminal({
			fontFamily: this.plugin.settings.fontFamily,
			fontSize: this.plugin.settings.fontSize,
			theme: getXtermTheme(),
			cursorBlink: true,
			allowProposedApi: true,
			scrollback: 5000,
		});

		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(webLinksAddon);
		this.terminal.open(xtermWrapper);

		// Fit after DOM is rendered
		setTimeout(() => {
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
			this.terminal.writeln(
				`\r\n\x1b[31mFailed to start Claude Code: ${(err as Error).message}\x1b[0m`
			);
			this.terminal.writeln(
				`\r\n\x1b[33mCheck that '${settings.claudeBinaryPath}' is on your PATH and that Python 3 is installed.\x1b[0m`
			);
			return;
		}

		// Capture PTY reference so callbacks can detect if they've been superseded
		// by a newer session (e.g. user clicked New Session before this one exited).
		const thisPty = this.pty;

		// PTY output -> terminal display
		const onData = (chunk: Buffer) => {
			const data = chunk.toString("utf-8");
			this.terminal?.write(data);
			// Force repaint when a TUI (e.g. /mcp dialog) exits the alternate screen.
			// Without this, xterm.js leaves rendering artifacts from the TUI overlay.
			if (data.includes("\x1b[?1049l")) {
				requestAnimationFrame(() => {
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

		// PTY exit
		thisPty.on("close", (code: number | null) => {
			// If this PTY has already been replaced (e.g. New Session was clicked),
			// ignore the exit entirely — do not null out the newer session.
			if (this.pty !== thisPty) return;

			this.pty = null;

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
		// Full terminal reset — safe because the PTY is already dead.
		// Always starts fresh (ignores the resumeLastSession setting) since
		// the user is explicitly requesting a clean slate.
		this.terminal?.reset();
		this.startSession(false);
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;

		if (this.pty) {
			this.plugin.processManager.killPty(this.pty);
			this.pty = null;
		}

		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
	}
}
