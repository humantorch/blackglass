import { App, Modal, MarkdownRenderer, Notice, Component } from "obsidian";
import type ClaudeCodePlugin from "./main";

export class ClaudeQuickModal extends Modal {
	private plugin: ClaudeCodePlugin;
	private prefill: string;
	private promptTextarea: HTMLTextAreaElement | null = null;
	private modelSelect: HTMLSelectElement | null = null;
	private resultEl: HTMLElement | null = null;
	private submitBtn: HTMLButtonElement | null = null;
	private copyBtn: HTMLButtonElement | null = null;
	private lastResponse = "";
	private aborted = false;
	private markdownComponent: Component;

	constructor(app: App, plugin: ClaudeCodePlugin, prefill = "") {
		super(app);
		this.plugin = plugin;
		this.prefill = prefill;
		this.markdownComponent = new Component();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("claude-quick-modal");

		contentEl.createEl("h2", { text: "Ask Claude" });

		// Context preview (if prefill provided)
		if (this.prefill) {
			const contextSection = contentEl.createDiv({ cls: "claude-quick-modal-context" });
			contextSection.createEl("p", {
				text: "Context:",
				cls: "claude-quick-modal-context-label",
			});
			const preview = this.prefill.length > 200
				? this.prefill.slice(0, 200) + "..."
				: this.prefill;
			contextSection.createEl("p", {
				text: preview,
				cls: "claude-quick-modal-context-preview",
			});
		}

		// Prompt textarea
		const promptSection = contentEl.createDiv({ cls: "claude-quick-modal-prompt-section" });
		this.promptTextarea = promptSection.createEl("textarea", {
			cls: "claude-quick-modal-textarea",
			attr: {
				placeholder: "Ask Claude anything...",
				rows: "4",
			},
		});
		this.promptTextarea.focus();

		// Submit on Cmd+Enter / Ctrl+Enter
		this.promptTextarea.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submit();
			}
		});

		// Action bar
		const actionBar = contentEl.createDiv({ cls: "claude-quick-modal-actions" });

		this.submitBtn = actionBar.createEl("button", {
			text: "Ask Claude",
			cls: "mod-cta",
		});
		this.submitBtn.addEventListener("click", () => this.submit());

		// Model selector — defaults to the setting, overridable per-query
		const modelWrapper = actionBar.createDiv({ cls: "claude-quick-modal-model-wrapper" });
		modelWrapper.createEl("label", {
			text: "Model:",
			cls: "claude-quick-modal-model-label",
		});
		this.modelSelect = modelWrapper.createEl("select", {
			cls: "claude-quick-modal-model-select",
		});
		const models: [string, string][] = [
			["", "Default"],
			["claude-haiku-4-5-20251001", "Haiku 4.5"],
			["claude-sonnet-4-6", "Sonnet 4.6"],
			["claude-opus-4-7", "Opus 4.7"],
		];
		for (const [value, label] of models) {
			const opt = this.modelSelect.createEl("option", { text: label });
			opt.value = value;
		}
		this.modelSelect.value = this.plugin.settings.quickAskModel;

		this.copyBtn = actionBar.createEl("button", {
			text: "Copy response",
			cls: "claude-quick-modal-copy-btn",
		});
		this.copyBtn.style.display = "none";
		this.copyBtn.addEventListener("click", () => this.copyToClipboard());

		// Result area
		this.resultEl = contentEl.createDiv({ cls: "claude-quick-modal-result" });
		this.resultEl.style.display = "none";
	}

	private async submit(): Promise<void> {
		if (!this.promptTextarea || !this.resultEl || !this.submitBtn) return;

		const prompt = this.promptTextarea.value.trim();
		if (!prompt) {
			new Notice("Please enter a prompt.");
			return;
		}

		this.aborted = false;
		this.submitBtn.disabled = true;
		this.submitBtn.textContent = "Asking Claude...";

		// Show loading state
		this.resultEl.style.display = "block";
		this.resultEl.empty();
		const spinner = this.resultEl.createDiv({ cls: "claude-quick-modal-loading" });
		spinner.createEl("span", { text: "Claude is thinking..." });

		const { settings } = this.plugin;
		const workingDir =
			settings.workingDirectory ||
			this.plugin.contextBuilder.getVaultRoot() ||
			"";

		const model = this.modelSelect?.value || undefined;

		const result = await this.plugin.processManager.runPrintModeWithContext(
			this.prefill,
			prompt,
			{
				claudePath: settings.claudeBinaryPath,
				workingDirectory: workingDir,
				model,
			}
		);

		if (this.aborted) return;

		this.submitBtn.disabled = false;
		this.submitBtn.textContent = "Ask Claude";

		this.resultEl.empty();

		if (!result.success) {
			this.resultEl.createEl("p", {
				text: `Error: ${result.error}`,
				cls: "claude-quick-modal-error",
			});
			return;
		}

		this.lastResponse = result.text;

		// Render response as markdown
		const responseEl = this.resultEl.createDiv({ cls: "claude-quick-modal-response" });
		await MarkdownRenderer.render(
			this.app,
			result.text,
			responseEl,
			"",
			this.markdownComponent
		);

		// Show copy button
		if (this.copyBtn) {
			this.copyBtn.style.display = "inline-block";
		}
	}

	private async copyToClipboard(): Promise<void> {
		if (!this.lastResponse) return;
		await navigator.clipboard.writeText(this.lastResponse);
		new Notice("Response copied to clipboard.");
		if (this.copyBtn) this.copyBtn.textContent = "Copied!";
		setTimeout(() => {
			if (this.copyBtn) this.copyBtn.textContent = "Copy response";
		}, 2000);
	}

	onClose(): void {
		this.aborted = true;
		this.markdownComponent.unload();
		const { contentEl } = this;
		contentEl.empty();
	}
}
