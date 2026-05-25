export interface ClaudeCodeSettings {
	claudeBinaryPath: string;
	workingDirectory: string;
	quickAskModel: string;
	autoOpenOnStartup: boolean;
	resumeLastSession: boolean;
	fontSize: number;
	fontFamily: string;
	mcpServerEnabled: boolean;
	mcpServerPort: number;
	mcpReadOnly: boolean;
	skipPermissions: boolean;
	scrollback: number;
}

export const DEFAULT_SETTINGS: ClaudeCodeSettings = {
	claudeBinaryPath: "claude",
	workingDirectory: "",
	quickAskModel: "",
	autoOpenOnStartup: false,
	resumeLastSession: true,
	fontSize: 14,
	fontFamily: "monospace",
	mcpServerEnabled: true,
	mcpServerPort: 27123,
	mcpReadOnly: false,
	skipPermissions: false,
	scrollback: 5000,
};

export const CLAUDE_TERMINAL_VIEW_TYPE = "claude-code-terminal";
export const CLAUDE_ICON = "bot";

export interface PtySessionOptions {
	claudePath: string;
	workingDirectory: string;
	resumeLastSession: boolean;
	skipPermissions: boolean;
	cols: number;
	rows: number;
}

export interface PrintModeOptions {
	claudePath: string;
	workingDirectory: string;
	model?: string;
	timeoutMs?: number;
}

export interface PrintModeResult {
	success: boolean;
	text: string;
	error?: string;
}
