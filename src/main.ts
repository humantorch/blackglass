import { FileSystemAdapter, Menu, Notice, Plugin, RequestUrlResponse, TFile, WorkspaceLeaf, requestUrl } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import {
	ClaudeCodeSettings,
	CLAUDE_ICON,
	CLAUDE_TERMINAL_VIEW_TYPE,
	DEFAULT_SETTINGS,
} from "./types";
import { SettingsTab } from "./SettingsTab";
import { ContextBuilder } from "./ContextBuilder";
import { ProcessManager } from "./ProcessManager";
import { ClaudeTerminalView } from "./ClaudeTerminalView";
import { ClaudeQuickModal } from "./ClaudeQuickModal";
import { VaultMcpServer } from "./VaultMcpServer";

interface GitHubRelease {
	tag_name: string;
}

export default class ClaudeCodePlugin extends Plugin {
	settings: ClaudeCodeSettings = DEFAULT_SETTINGS;
	processManager!: ProcessManager;
	contextBuilder!: ContextBuilder;
	vaultMcpServer: VaultMcpServer | null = null;
	availableVersion: string | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.processManager = new ProcessManager();

		this.contextBuilder = new ContextBuilder(this.app);

		// Register the terminal view
		this.registerView(
			CLAUDE_TERMINAL_VIEW_TYPE,
			(leaf) => new ClaudeTerminalView(leaf, this)
		);

		// Ribbon icon
		this.addRibbonIcon(CLAUDE_ICON, "Open Claude Code", () => {
			void this.activateClaudeView();
		});

		// Settings tab
		this.addSettingTab(new SettingsTab(this.app, this));

		// Commands
		this.addCommand({
			id: "open-terminal",
			name: "Open Claude Code terminal",
			callback: () => { void this.activateClaudeView(); },
		});

		this.addCommand({
			id: "quick-ask",
			name: "Ask Claude (quick)",
			callback: () => {
				new ClaudeQuickModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: "ask-about-note",
			name: "Ask Claude about this note",
			callback: async () => {
				const content = await this.contextBuilder.getActiveFileContent();
				if (!content) {
					new Notice("No active note.");
					return;
				}
				const relativePath =
					this.contextBuilder.getActiveFileRelativePath() ?? "unknown";
				const context = this.contextBuilder.buildNoteContext(
					content,
					relativePath
				);
				new ClaudeQuickModal(this.app, this, context).open();
			},
		});

		this.addCommand({
			id: "ask-about-selection",
			name: "Ask Claude about selection",
			editorCallback: (editor) => {
				const selection = this.contextBuilder.getActiveSelection(editor);
				if (!selection) {
					new Notice("No text selected.");
					return;
				}
				const context =
					this.contextBuilder.buildSelectionContext(selection);
				new ClaudeQuickModal(this.app, this, context).open();
			},
		});

		this.addCommand({
			id: "new-session",
			name: "Start new Claude Code session",
			callback: () => {
				const view = this.getClaudeView();
				if (!view) {
					// Open a fresh terminal instead
					void this.activateClaudeView();
					return;
				}
				// ClaudeTerminalView.restartSession is private — close and reopen
				// to trigger a clean new session
				const leaves = this.app.workspace.getLeavesOfType(
					CLAUDE_TERMINAL_VIEW_TYPE
				);
				for (const leaf of leaves) {
					leaf.detach();
				}
				void this.activateClaudeView();
			},
		});

		// File explorer context menu
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((item) => {
					item
						.setTitle("Ask Claude about this")
						.setIcon(CLAUDE_ICON)
						.onClick(async () => {
							const content = await this.app.vault.read(file);
							const context = this.contextBuilder.buildNoteContext(
								content,
								file.path
							);
							new ClaudeQuickModal(this.app, this, context).open();
						});
				});
			})
		);

		// Auto-open on startup if configured
		if (this.settings.autoOpenOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				void this.activateClaudeView();
			});
		}

		// Start vault MCP server
		if (this.settings.mcpServerEnabled) {
			await this.startVaultMcpServer();
		}

		// Check for updates once on load, then every 24 hours
		this.app.workspace.onLayoutReady(() => { void this.checkForUpdate(); });
		this.registerInterval(
			window.setInterval(() => { void this.checkForUpdate(); }, 24 * 60 * 60 * 1000)
		);
	}

	onunload(): void {
		this.stopVaultMcpServer();
		// Detach all Claude terminal leaves — ClaudeTerminalView.onClose() handles PTY cleanup
		this.app.workspace
			.getLeavesOfType(CLAUDE_TERMINAL_VIEW_TYPE)
			.forEach((leaf: WorkspaceLeaf) => leaf.detach());
	}

	async activateClaudeView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(
			CLAUDE_TERMINAL_VIEW_TYPE
		);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		// Open in right sidebar
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({
			type: CLAUDE_TERMINAL_VIEW_TYPE,
			active: true,
		});

		this.app.workspace.revealLeaf(leaf);
	}

	private async checkForUpdate(): Promise<void> {
		try {
			const resp: RequestUrlResponse = await requestUrl({
				url: "https://api.github.com/repos/humantorch/blackglass/releases/latest",
				headers: { "User-Agent": "blackglass-obsidian-plugin" },
			});
			const data = resp.json as GitHubRelease | null;
			const latest: string = (data?.tag_name ?? "").replace(/^v/, "");
			const current = this.manifest.version;
			if (latest && latest !== current && this.isNewerVersion(latest, current)) {
				this.availableVersion = latest;
				this.getClaudeView()?.showUpdateAvailable(latest);
				new Notice(
					`Blackglass ${latest} is available. Click the version in the toolbar to update.`,
					10000
				);
			}
		} catch {
			// Network unavailable or API rate-limited — silently skip
		}
	}

	private isNewerVersion(latest: string, current: string): boolean {
		const parse = (v: string) => v.split(".").map((n) => parseInt(n) || 0);
		const [lMaj, lMin, lPat] = parse(latest);
		const [cMaj, cMin, cPat] = parse(current);
		if (lMaj !== cMaj) return lMaj > cMaj;
		if (lMin !== cMin) return lMin > cMin;
		return lPat > cPat;
	}

	applyFontToTerminal(): void {
		this.getClaudeView()?.updateFont(
			this.settings.fontSize,
			this.settings.fontFamily,
			this.settings.fontWeight
		);
	}

	getClaudeView(): ClaudeTerminalView | null {
		const leaves = this.app.workspace.getLeavesOfType(
			CLAUDE_TERMINAL_VIEW_TYPE
		);
		if (leaves.length === 0) return null;
		const view = leaves[0].view;
		return view instanceof ClaudeTerminalView ? view : null;
	}

	async startVaultMcpServer(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const vaultRoot = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
		this.vaultMcpServer = new VaultMcpServer(this.app, this.settings.mcpServerPort, this.settings.mcpReadOnly);
		try {
			const port = await this.vaultMcpServer.start();
			const token = this.vaultMcpServer.getToken();
			this.registerMcpInProjectSettings(vaultRoot, port, token);
		} catch (err) {
			console.error("Blackglass: failed to start vault MCP server:", err);
			this.vaultMcpServer = null;
		}
		this.getClaudeView()?.updateMcpStatus();
	}

	stopVaultMcpServer(): void {
		if (!this.vaultMcpServer) return;
		const adapter = this.app.vault.adapter;
		const vaultRoot = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
		this.vaultMcpServer.stop();
		this.vaultMcpServer = null;
		this.deregisterMcpFromProjectSettings(vaultRoot);
		this.getClaudeView()?.updateMcpStatus();
	}

	private registerMcpInProjectSettings(vaultRoot: string, port: number, token: string): void {
		// Claude Code reads project-level MCP servers from .mcp.json at the project root
		const mcpPath = path.join(vaultRoot, ".mcp.json");

		let config: Record<string, unknown> = {};
		try {
			if (fs.existsSync(mcpPath)) {
				config = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
			}
		} catch {
			config = {};
		}

		if (!config.mcpServers || typeof config.mcpServers !== "object") {
			config.mcpServers = {};
		}
		(config.mcpServers as Record<string, unknown>).obsidian = {
			type: "http",
			url: `http://localhost:${port}/`,
			headers: {
				Authorization: `Bearer ${token}`,
			},
		};

		try {
			fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2));
		} catch (err) {
			console.error("Blackglass: failed to write .mcp.json:", err);
		}
	}

	private deregisterMcpFromProjectSettings(vaultRoot: string): void {
		const mcpPath = path.join(vaultRoot, ".mcp.json");
		try {
			if (!fs.existsSync(mcpPath)) return;
			const config = JSON.parse(
				fs.readFileSync(mcpPath, "utf8")
			) as Record<string, unknown>;
			const servers = config.mcpServers as Record<string, unknown> | undefined;
			if (!servers) return;
			delete servers.obsidian;
			fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2));
		} catch {
			// Ignore errors on cleanup
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
