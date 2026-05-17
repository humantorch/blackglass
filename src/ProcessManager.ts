import { execSync, spawn } from "child_process";
import type { ChildProcess } from "child_process";
import pseudoterminalScript from "./pseudoterminal.py";
import { PtySessionOptions, PrintModeOptions, PrintModeResult } from "./types";

/**
 * Electron inherits a minimal environment — PATH is truncated and shell-profile
 * variables (API tokens, etc.) are absent. Capture the full login shell
 * environment so Claude Code and its MCP servers have everything they need.
 * Falls back gracefully if execSync is unavailable in the renderer.
 */
function buildEnv(): Record<string, string> {
	if (process.platform === "win32") {
		const env: Record<string, string> = { ...(process.env as Record<string, string>) };
		const userProfile = env.USERPROFILE || "C:\\Users\\Default";
		const appData = env.APPDATA || "";
		const localAppData = env.LOCALAPPDATA || "";
		const pathParts = new Set<string>(
			(env.PATH || "").split(";").filter(Boolean)
		);
		[
			`${userProfile}\\.local\\bin`,
			`${appData}\\npm`,
			`${localAppData}\\Microsoft\\WinGet\\Packages`,
			"C:\\Program Files\\nodejs",
		].filter(Boolean).forEach((p) => pathParts.add(p));
		env.PATH = Array.from(pathParts).join(";");
		return env;
	}

	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
	};

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
	private resolvedEnv: Record<string, string>;

	constructor() {
		this.resolvedEnv = buildEnv();
	}

	startPtySession(options: PtySessionOptions): ChildProcess {
		if (process.platform === "win32") {
			return this.startWindowsSession(options);
		}

		const python = this.resolvePython();

		const args = [options.claudePath];
		if (options.resumeLastSession) args.push("--continue");
		if (options.skipPermissions) args.push("--dangerously-skip-permissions");

		const proc = spawn(python, ["-c", pseudoterminalScript, ...args], {
			cwd: options.workingDirectory || this.resolvedEnv["HOME"] || "/",
			env: { ...this.resolvedEnv, TERM: "xterm-color", COLORTERM: "truecolor" },
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});

		// Send the actual terminal dimensions as soon as the process is alive.
		// Without this the PTY starts at the kernel default (often 0×0 or 80×24),
		// causing Claude Code's cursor-based UI to wrap incorrectly and overwrite text.
		proc.once("spawn", () => this.resizePty(proc, options.cols, options.rows));

		return proc;
	}

	private startWindowsSession(options: PtySessionOptions): ChildProcess {
		const args: string[] = [];
		if (options.resumeLastSession) args.push("--continue");
		if (options.skipPermissions) args.push("--dangerously-skip-permissions");

		const cols = options.cols || 80;
		const rows = options.rows || 24;
		// Quote path to handle spaces (e.g. C:\Users\scott\.local\bin\claude.exe)
		const quotedPath = options.claudePath.includes(" ")
			? `"${options.claudePath}"`
			: options.claudePath;
		const claudeCmd = [quotedPath, ...args].join(" ");

		// conhost.exe creates a ConPTY session so Claude Code sees a real terminal.
		// Wrap in cmd.exe to set the console dimensions before Claude starts —
		// without this, ConPTY defaults to 80x24 regardless of the xterm.js panel size.
		return spawn("C:\\Windows\\System32\\conhost.exe", [
			"--headless", "--",
			"cmd.exe", "/c",
			`mode con cols=${cols} lines=${rows} >nul 2>nul && ${claudeCmd}`,
		], {
			cwd: options.workingDirectory || this.resolvedEnv["USERPROFILE"] || "C:\\",
			env: { ...this.resolvedEnv, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) },
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	resizePty(proc: ChildProcess, cols: number, rows: number): void {
		try {
			// FD #3 is the resize control channel — Python reads "COLSxROWS\n" and
			// calls ioctl(TIOCSWINSZ) on the PTY master.
			const cmdio = proc.stdio[3] as NodeJS.WritableStream | null;
			cmdio?.write(`${cols}x${rows}\n`);
		} catch {
			// Process may have already exited
		}
	}

	writePty(proc: ChildProcess, data: string): void {
		try {
			proc.stdin?.write(data);
		} catch {
			// Process may have already exited
		}
	}

	killPty(proc: ChildProcess | null): void {
		if (!proc) return;
		try {
			proc.kill("SIGTERM");
		} catch {
			// Process may have already exited
		}
	}

	private resolvePython(): string {
		for (const exe of ["python3", "python"]) {
			try {
				const result = execSync(`which ${exe}`, {
					env: this.resolvedEnv,
					timeout: 3000,
				});
				const p = result.toString().trim();
				if (p) return p;
			} catch {
				// try next
			}
		}
		throw new Error(
			"Python 3 not found. Install it via Homebrew: brew install python3"
		);
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

			const args = ["--print", "--output-format", "json"];
			if (options.model) args.push("--model", options.model);

			const proc = spawn(options.claudePath, args, {
				cwd: options.workingDirectory || undefined,
				env: { ...this.resolvedEnv },
				stdio: ["pipe", "pipe", "pipe"],
			});

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
					const text: string =
						parsed.result ??
						parsed.content?.[0]?.text ??
						parsed.message ??
						stdout.trim();
					resolve({ success: true, text });
				} catch {
					resolve({ success: true, text: stdout.trim() });
				}
			});

			proc.on("error", (err: Error) => {
				clearTimeout(timer);
				const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT";
				const isWindows = process.platform === "win32";
				const hint = isEnoent && isWindows
					? `Set the full path in Settings → Blackglass → "Claude binary path" (e.g. C:\\Users\\<you>\\.local\\bin\\claude.exe).`
					: `Is '${options.claudePath}' on your PATH?`;
				resolve({
					success: false,
					text: "",
					error: `Failed to start Claude: ${err.message}. ${hint}`,
				});
			});
		});
	}
}
