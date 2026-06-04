import { App, DropdownComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudeCodePlugin from "./main";

export class SettingsTab extends PluginSettingTab {
	plugin: ClaudeCodePlugin;
	private fontVariantMap: Map<string, Array<{ label: string; weight: string }>> = new Map();

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
					.addOption("claude-opus-4-8", "Opus 4.8")
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
							this.plugin.applyFontToTerminal();
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

		// Create stubs synchronously so they appear in the right position,
		// then fill in the dropdowns asynchronously once font data is loaded.
		const familySetting = new Setting(containerEl)
			.setName("Terminal font family")
			.setDesc("Font family for the terminal panel. Loading fonts...");
		const weightSetting = new Setting(containerEl)
			.setName("Terminal font weight")
			.setDesc("Weight or style variant for the selected font. Loading fonts...");
		this.buildFontDropdowns(familySetting, weightSetting);

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
				"Registers automatically in .mcp.json in the vault root."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.mcpServerEnabled)
					.onChange(async (value) => {
						this.plugin.settings.mcpServerEnabled = value;
						await this.plugin.saveSettings();
						if (value) {
							await this.plugin.startVaultMcpServer();
							new Notice("Vault MCP server started. Start a new session for Claude to pick it up.");
						} else {
							this.plugin.stopVaultMcpServer();
							new Notice("Vault MCP server stopped. Start a new session for the change to take effect in Claude.");
						}
					})
			);

		new Setting(containerEl)
			.setName("Read-only vault access")
			.setDesc(
				"When enabled, Claude can read and search notes but cannot create or update them. " +
				"Takes effect the next time the MCP server starts."
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

	private async buildFontDropdowns(familySetting: Setting, weightSetting: Setting): Promise<void> {
		const { families, variantMap } = await this.getFontData();
		this.fontVariantMap = variantMap;

		let variantDropdown: DropdownComponent | null = null;

		familySetting.setDesc("Font family for the terminal panel.");
		familySetting.addDropdown((dd) => {
			for (const font of families) {
				dd.addOption(font, font);
			}
			const current = this.plugin.settings.fontFamily;
			if (current && !families.includes(current)) {
				dd.addOption(current, current);
			}
			dd.setValue(current);
			dd.onChange(async (value) => {
				this.plugin.settings.fontFamily = value;
				this.plugin.settings.fontWeight = "normal";
				await this.plugin.saveSettings();
				this.plugin.applyFontToTerminal();
				if (variantDropdown) {
					this.populateVariantOptions(variantDropdown, value);
					variantDropdown.setValue("normal");
				}
			});
		});

		weightSetting.setDesc("Weight or style variant for the selected font.");
		weightSetting.addDropdown((dd) => {
			variantDropdown = dd;
			this.populateVariantOptions(dd, this.plugin.settings.fontFamily);
			// Restore saved weight, fall back to normal if not present
			const saved = this.plugin.settings.fontWeight;
			const available = Array.from(dd.selectEl.options).map((o) => o.value);
			dd.setValue(available.includes(saved) ? saved : "normal");
			dd.onChange(async (value) => {
				this.plugin.settings.fontWeight = value;
				await this.plugin.saveSettings();
				this.plugin.applyFontToTerminal();
			});
		});
	}

	private populateVariantOptions(dd: DropdownComponent, family: string): void {
		dd.selectEl.innerHTML = "";
		const variants = this.fontVariantMap.get(family);
		if (variants && variants.length > 0) {
			for (const v of variants) {
				dd.addOption(v.weight, v.label);
			}
		} else {
			dd.addOption("normal", "Normal");
			dd.addOption("300", "Light (300)");
			dd.addOption("500", "Medium (500)");
			dd.addOption("600", "SemiBold (600)");
			dd.addOption("bold", "Bold");
		}
	}

	private styleToWeight(style: string): string {
		const s = style.toLowerCase().replace(/[\s\-]/g, "");
		if (s.includes("hairline") || s === "thin") return "100";
		if (s.includes("extralight") || s.includes("ultralight")) return "200";
		if (s.includes("light")) return "300";
		if (s.includes("medium")) return "500";
		if (s.includes("semibold") || s.includes("demibold")) return "600";
		if (s.includes("extrabold") || s.includes("ultrabold")) return "800";
		if (s.includes("black") || s.includes("heavy")) return "900";
		if (s.includes("bold")) return "bold";
		return "normal";
	}

	private async getFontData(): Promise<{
		families: string[];
		variantMap: Map<string, Array<{ label: string; weight: string }>>;
	}> {
		if ("queryLocalFonts" in window) {
			try {
				const rawFonts = await (window as any).queryLocalFonts();
				const familySet = new Set<string>();
				const variantMap = new Map<string, Array<{ label: string; weight: string }>>();

				for (const font of rawFonts) {
					const family = font.family as string;
					const style = font.style as string;
					familySet.add(family);

					// Skip italic/oblique — not a useful weight choice for a terminal
					const styleLower = style.toLowerCase();
					if (styleLower.includes("italic") || styleLower.includes("oblique")) continue;

					if (!variantMap.has(family)) variantMap.set(family, []);
					const weight = this.styleToWeight(style);
					const variants = variantMap.get(family)!;
					// One entry per weight value — keep the first style name encountered
					if (!variants.some((v) => v.weight === weight)) {
						variants.push({ label: style, weight });
					}
				}

				// Sort families alphabetically, sort each family's variants by weight
				const families = [...familySet].sort((a, b) => a.localeCompare(b));
				for (const variants of variantMap.values()) {
					variants.sort((a, b) => {
						const wa = parseInt(a.weight) || (a.weight === "bold" ? 700 : 400);
						const wb = parseInt(b.weight) || (b.weight === "bold" ? 700 : 400);
						return wa - wb;
					});
				}

				if (families.length > 0) return { families, variantMap };
			} catch {
				// Permission denied or API unavailable — fall through to curated list
			}
		}

		return {
			families: [
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
			],
			variantMap: new Map(),
		};
	}
}
