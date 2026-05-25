import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeCodePlugin from "./main";

export class SettingsTab extends PluginSettingTab {
	plugin: ClaudeCodePlugin;

	constructor(app: App, plugin: ClaudeCodePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Claude Code Settings" });

		new Setting(containerEl)
			.setName("Claude binary path")
			.setDesc(
				"Path to the claude CLI executable. Use 'claude' if it's on your PATH, or provide the full absolute path (e.g. /usr/local/bin/claude)."
			)
			.addText((text) =>
				text
					.setPlaceholder("claude")
					.setValue(this.plugin.settings.claudeBinaryPath)
					.onChange(async (value) => {
						this.plugin.settings.claudeBinaryPath = value.trim() || "claude";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Working directory")
			.setDesc(
				"Directory Claude Code starts in. Leave blank to use vault root. Claude will have access to files in this directory."
			)
			.addText((text) =>
				text
					.setPlaceholder("(vault root)")
					.setValue(this.plugin.settings.workingDirectory)
					.onChange(async (value) => {
						this.plugin.settings.workingDirectory = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Quick ask model")
			.setDesc("Claude model to use for the quick ask modal.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("", "Default")
					.addOption("claude-haiku-4-5-20251001", "Haiku 4.5")
					.addOption("claude-sonnet-4-6", "Sonnet 4.6")
					.addOption("claude-opus-4-7", "Opus 4.7")
					.setValue(this.plugin.settings.quickAskModel)
					.onChange(async (value) => {
						this.plugin.settings.quickAskModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Terminal font size")
			.setDesc("Font size in pixels for the terminal panel.")
			.addText((text) =>
				text
					.setPlaceholder("14")
					.setValue(String(this.plugin.settings.fontSize))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.fontSize = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Terminal scrollback")
			.setDesc("Number of lines to keep in the terminal's scroll history (default 5000). Takes effect the next time the terminal is opened.")
			.addText((text) =>
				text
					.setPlaceholder("5000")
					.setValue(String(this.plugin.settings.scrollback))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed >= 100 && parsed <= 100000) {
							this.plugin.settings.scrollback = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		const fontSetting = new Setting(containerEl)
			.setName("Terminal font family")
			.setDesc("Font family for the terminal panel. Loading system fonts...");
		this.buildFontDropdown(fontSetting);

		new Setting(containerEl)
			.setName("Open Claude panel on startup")
			.setDesc(
				"Automatically open the Claude Code terminal when Obsidian starts."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoOpenOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.autoOpenOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Resume last Claude session")
			.setDesc(
				"Pass --continue when starting a new session to resume the previous conversation context."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.resumeLastSession)
					.onChange(async (value) => {
						this.plugin.settings.resumeLastSession = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Skip permission prompts")
			.setDesc(
				"Pass --dangerously-skip-permissions to Claude Code. " +
				"Claude will execute tool calls without asking for confirmation. " +
				"Only enable this if you trust the tasks you are running."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.skipPermissions)
					.onChange(async (value) => {
						this.plugin.settings.skipPermissions = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Vault MCP server" });

		new Setting(containerEl)
			.setName("Enable vault MCP server")
			.setDesc(
				"Starts a local MCP server that gives Claude vault-aware tools (read, search, create, update notes). " +
				"Registers automatically in .claude/settings.json in the vault root. Restart the plugin after changing this setting."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.mcpServerEnabled)
					.onChange(async (value) => {
						this.plugin.settings.mcpServerEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Read-only vault access")
			.setDesc(
				"When enabled, Claude can read and search notes but cannot create or update them. " +
				"Restart the plugin after changing."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.mcpReadOnly)
					.onChange(async (value) => {
						this.plugin.settings.mcpReadOnly = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("MCP server port")
			.setDesc(
				"Port the vault MCP server listens on (default 27123). If the port is in use, the next available port up to +4 is used automatically. Restart the plugin after changing."
			)
			.addText((text) =>
				text
					.setPlaceholder("27123")
					.setValue(String(this.plugin.settings.mcpServerPort))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 1023 && parsed < 65536) {
							this.plugin.settings.mcpServerPort = parsed;
							await this.plugin.saveSettings();
						}
					})
			);
	}

	private async buildFontDropdown(setting: Setting): Promise<void> {
		const fonts = await this.getSystemFonts();
		setting.setDesc("Font family for the terminal panel.");
		setting.addDropdown((dropdown) => {
			for (const font of fonts) {
				dropdown.addOption(font, font);
			}
			// Ensure the saved value is present even if not in the list
			const current = this.plugin.settings.fontFamily;
			if (current && !fonts.includes(current)) {
				dropdown.addOption(current, current);
			}
			dropdown.setValue(this.plugin.settings.fontFamily);
			dropdown.onChange(async (value) => {
				this.plugin.settings.fontFamily = value;
				await this.plugin.saveSettings();
			});
		});
	}

	private async getSystemFonts(): Promise<string[]> {
		// Try Local Font Access API — available in Chromium 103+ / Electron
		if ("queryLocalFonts" in window) {
			try {
				const rawFonts = await (window as any).queryLocalFonts();
				const families: string[] = [
					...new Set<string>(rawFonts.map((f: any) => f.family as string)),
				].sort((a, b) => a.localeCompare(b));
				if (families.length > 0) return families;
			} catch {
				// Permission denied or API unavailable — fall through to curated list
			}
		}

		// Fallback: curated list of widely-used fonts
		return [
			"monospace",
			"Cascadia Code",
			"Cascadia Mono",
			"Consolas",
			"Courier New",
			"DejaVu Sans Mono",
			"Fira Code",
			"Fira Mono",
			"Hack",
			"IBM Plex Mono",
			"Inconsolata",
			"JetBrains Mono",
			"Menlo",
			"Monaco",
			"Noto Sans Mono",
			"Roboto Mono",
			"SF Mono",
			"Source Code Pro",
			"Ubuntu Mono",
		];
	}
}
