import { execSync, spawn } from "child_process";
import * as path from "path";
import type { IPty } from "node-pty";
import { PtySessionOptions, PrintModeOptions, PrintModeResult } from "./types";

/**
 * Electron inherits a minimal environment — PATH is truncated and shell-profile
 * variables (API tokens, etc.) are absent. Capture the full login shell
 * environment so Claude Code and its MCP servers have everything they need.
 * Falls back gracefully if execSync is unavailable in the renderer.
 */
function buildEnv(): Record<string, string> {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
	};

	// Try to capture the full login shell environment
	try {
		const shell = process.env.SHELL || "/bin/zsh";
		const output = execSync(`${shell} -l -c "env"`, {
			encoding: "utf8",
			timeout: 5000,
		}).trim();

		for (const line of output.split("\n")) {
			const idx = line.indexOf("=");
			if (idx > 0) {
				env[line.slice(0, idx)] = line.slice(idx + 1);
			}
		}
	} catch {
		// execSync may fail in Electron renderer — PATH fallback below handles it
	}

	// Always supplement PATH with common install locations as a safety net
	const home = env.HOME || "";
	const pathParts = new Set<string>(
		(env.PATH || "").split(":").filter(Boolean)
	);
	[
		`${home}/.local/bin`,
		`${home}/.npm-global/bin`,
		`${home}/.yarn/bin`,
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	]
		.filter(Boolean)
		.forEach((p) => pathParts.add(p));

	env.PATH = Array.from(pathParts).join(":");
	return env;
}

export class ProcessManager {
	/**
	 * Absolute path to the plugin directory, used to locate node-pty.
	 * __dirname resolves to Obsidian's internal ASAR in the renderer process,
	 * so we derive the plugin dir from the manifest instead and pass it in.
	 */
	private pluginDir: string;
	private resolvedEnv: Record<string, string>;

	constructor(pluginDir: string) {
		this.pluginDir = pluginDir;
		this.resolvedEnv = buildEnv();
	}

	/**
	 * Starts an interactive Claude Code session in a PTY.
	 * node-pty is required at runtime (native module, not bundled).
	 */
	startPtySession(options: PtySessionOptions): IPty {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const pty = require(path.join(this.pluginDir, "node_modules", "node-pty"));

		const args: string[] = [];
		if (options.resumeLastSession) {
			args.push("--continue");
		}
		if (options.skipPermissions) {
			args.push("--dangerously-skip-permissions");
		}

		const ptyProcess: IPty = pty.spawn(options.claudePath, args, {
			name: "xterm-color",
			cols: options.cols || 80,
			rows: options.rows || 24,
			cwd: options.workingDirectory,
			env: {
				...this.resolvedEnv,
				TERM: "xterm-color",
				COLORTERM: "truecolor",
			},
		});

		return ptyProcess;
	}

	resizePty(pty: IPty, cols: number, rows: number): void {
		try {
			pty.resize(cols, rows);
		} catch {
			// Process may have already exited
		}
	}

	killPty(pty: IPty | null): void {
		if (!pty) return;
		try {
			pty.kill();
		} catch {
			// Process may have already exited
		}
	}

	/**
	 * Runs Claude in non-interactive print mode with a plain prompt.
	 */
	runPrintMode(prompt: string, options: PrintModeOptions): Promise<PrintModeResult> {
		return this.runPrintModeWithContext("", prompt, options);
	}

	/**
	 * Runs Claude in non-interactive print mode, piping optional context + prompt via stdin.
	 * Uses --output-format json for reliable response parsing.
	 */
	runPrintModeWithContext(
		context: string,
		prompt: string,
		options: PrintModeOptions
	): Promise<PrintModeResult> {
		return new Promise((resolve) => {
			const timeoutMs = options.timeoutMs ?? 120000;

			// --print with stdin input. Pipe full message (context + prompt) via stdin.
			const args = ["--print", "--output-format", "json"];
			if (options.model) args.push("--model", options.model);

			const proc = spawn(options.claudePath, args, {
				cwd: options.workingDirectory || undefined,
				env: { ...this.resolvedEnv },
				stdio: ["pipe", "pipe", "pipe"],
			});

			// Write the full message to stdin
			const fullMessage = context ? `${context}\n\n${prompt}` : prompt;
			proc.stdin.write(fullMessage);
			proc.stdin.end();

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data: Buffer) => {
				stdout += data.toString();
			});

			proc.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			const timer = setTimeout(() => {
				proc.kill();
				resolve({
					success: false,
					text: "",
					error: `Request timed out after ${timeoutMs / 1000}s`,
				});
			}, timeoutMs);

			proc.on("close", (code: number | null) => {
				clearTimeout(timer);

				if (code !== 0) {
					resolve({
						success: false,
						text: "",
						error: stderr.trim() || `Claude exited with code ${code}`,
					});
					return;
				}

				try {
					const parsed = JSON.parse(stdout.trim());
					// Claude Code --output-format json: { result: string, ... }
					const text: string =
						parsed.result ??
						parsed.content?.[0]?.text ??
						parsed.message ??
						stdout.trim();
					resolve({ success: true, text });
				} catch {
					// JSON parsing failed — return raw stdout
					resolve({ success: true, text: stdout.trim() });
				}
			});

			proc.on("error", (err: Error) => {
				clearTimeout(timer);
				resolve({
					success: false,
					text: "",
					error: `Failed to start Claude: ${err.message}. Is '${options.claudePath}' on your PATH?`,
				});
			});
		});
	}
}
