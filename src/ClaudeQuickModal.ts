import { App, Modal, MarkdownRenderer, Notice, Component } from "obsidian";
import type ClaudeCodePlugin from "./main";
import { QUICK_ASK_MODELS } from "./types";

export class ClaudeQuickModal extends Modal {
	private plugin: ClaudeCodePlugin;
	private prefill: string;
	private promptTextarea: HTMLTextAreaElement | null = null;
	private modelSelect: HTMLSelectElement | null = null;
	private resultEl: HTMLElement | null = null;
	private submitBtn: HTMLButtonElement | null = null;
	private stopBtn: HTMLButtonElement | null = null;
	private copyBtn: HTMLButtonElement | null = null;
	private lastResponse = "";
	private aborted = false;
	private killStream: (() => void) | null = null;
	private streamEl: HTMLElement | null = null;
	private streamText = "";
	private charQueue: string[] = [];
	private animationId: number | null = null;
	private pendingCompleteText: string | null = null;
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

		this.stopBtn = actionBar.createEl("button", {
			text: "Stop",
			cls: "claude-quick-modal-stop-btn",
		});
		this.stopBtn.hide();
		this.stopBtn.addEventListener("click", () => {
			this.killStream?.();
			this.killStream = null;
			this.pendingCompleteText = null;
			// Flush queued chars into streamText before rendering
			if (this.charQueue.length > 0) {
				this.streamText += this.charQueue.join("");
				this.charQueue = [];
			}
			if (this.streamText) {
				void this.finalizeResponse(this.streamText);
			} else {
				this.finishStreaming();
				this.resultEl?.hide();
			}
		});

		// Model selector — defaults to the setting, overridable per-query
		const modelWrapper = actionBar.createDiv({ cls: "claude-quick-modal-model-wrapper" });
		modelWrapper.createEl("label", {
			text: "Model:",
			cls: "claude-quick-modal-model-label",
		});
		this.modelSelect = modelWrapper.createEl("select", {
			cls: "claude-quick-modal-model-select",
		});
		for (const [value, label] of QUICK_ASK_MODELS) {
			const opt = this.modelSelect.createEl("option", { text: label });
			opt.value = value;
		}
		this.modelSelect.value = this.plugin.settings.quickAskModel;

		this.copyBtn = actionBar.createEl("button", {
			text: "Copy response",
			cls: "claude-quick-modal-copy-btn",
		});
		this.copyBtn.hide();
		this.copyBtn.addEventListener("click", () => { void this.copyToClipboard(); });

		// Result area
		this.resultEl = contentEl.createDiv({ cls: "claude-quick-modal-result" });
		this.resultEl.hide();
	}

	private submit(): void {
		if (!this.promptTextarea || !this.resultEl || !this.submitBtn) return;

		const prompt = this.promptTextarea.value.trim();
		if (!prompt) {
			new Notice("Please enter a prompt.");
			return;
		}

		// Kill any in-progress stream before starting a new one
		this.killStream?.();
		this.killStream = null;
		this.aborted = false;
		this.streamText = "";

		this.submitBtn.disabled = true;
		this.submitBtn.textContent = "Asking...";
		this.stopBtn?.show();
		this.copyBtn?.hide();

		// Show streaming area
		this.resultEl.show();
		this.resultEl.empty();
		this.streamEl = this.resultEl.createDiv({ cls: "claude-quick-modal-stream claude-quick-modal-stream--active" });

		const { settings } = this.plugin;
		const workingDir = settings.workingDirectory || this.plugin.contextBuilder.getVaultRoot() || "";
		const model = this.modelSelect?.value || undefined;

		this.killStream = this.plugin.processManager.runPrintModeStreamingWithContext(
			this.prefill,
			prompt,
			{ claudePath: settings.claudeBinaryPath, workingDirectory: workingDir, model },
			(delta: string) => {
				if (this.aborted) return;
				for (const ch of delta) this.charQueue.push(ch);
				if (this.animationId === null) this.startStreamAnimation();
			},
			(fullText: string) => {
				if (this.aborted) return;
				this.killStream = null;
				if (this.charQueue.length === 0 && this.animationId === null) {
					void this.finalizeResponse(fullText);
				} else {
					this.pendingCompleteText = fullText;
				}
			},
			(error: string) => {
				if (this.aborted) return;
				this.killStream = null;
				this.finishStreaming();
				if (this.resultEl) {
					this.resultEl.empty();
					this.resultEl.createEl("p", { text: `Error: ${error}`, cls: "claude-quick-modal-error" });
				}
			}
		);
	}

	private startStreamAnimation(): void {
		const step = () => {
			if (this.charQueue.length === 0) {
				this.animationId = null;
				if (this.pendingCompleteText !== null) {
					const text = this.pendingCompleteText;
					this.pendingCompleteText = null;
					void this.finalizeResponse(text);
				}
				return;
			}
			// Slow when queue is small (visible streaming), fast when backlogged
			const n = this.charQueue.length > 1000 ? 50 : this.charQueue.length > 300 ? 15 : 5;
			this.streamText += this.charQueue.splice(0, n).join("");
			if (this.streamEl) {
				this.streamEl.textContent = this.streamText;
			}
			this.animationId = window.requestAnimationFrame(step);
		};
		this.animationId = window.requestAnimationFrame(step);
	}

	private finishStreaming(): void {
		if (this.animationId !== null) {
			window.cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}
		this.charQueue = [];
		this.pendingCompleteText = null;
		if (this.submitBtn) {
			this.submitBtn.disabled = false;
			this.submitBtn.textContent = "Ask Claude";
		}
		this.stopBtn?.hide();
		this.streamEl = null;
	}

	private async finalizeResponse(text: string): Promise<void> {
		this.lastResponse = text;
		this.finishStreaming();

		if (!this.resultEl) return;
		this.resultEl.empty();
		const responseEl = this.resultEl.createDiv({ cls: "claude-quick-modal-response" });
		await MarkdownRenderer.render(this.app, text, responseEl, "", this.markdownComponent);
		this.resultEl.scrollTo({ top: 0 });

		this.copyBtn?.show();
	}

	private async copyToClipboard(): Promise<void> {
		if (!this.lastResponse) return;
		await navigator.clipboard.writeText(this.lastResponse);
		new Notice("Response copied to clipboard.");
		if (this.copyBtn) this.copyBtn.textContent = "Copied!";
		window.setTimeout(() => {
			if (this.copyBtn) this.copyBtn.textContent = "Copy response";
		}, 2000);
	}

	onClose(): void {
		this.aborted = true;
		this.killStream?.();
		this.killStream = null;
		if (this.animationId !== null) {
			window.cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}
		this.charQueue = [];
		this.markdownComponent.unload();
		const { contentEl } = this;
		contentEl.empty();
	}
}
