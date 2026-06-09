import { execSync, spawn } from "child_process";
import type { ChildProcess } from "child_process";
import pseudoterminalScript from "./pseudoterminal.py";
import winBridgeScript from "./pty_bridge_win.py";
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

		// Enumerate Python installs under %LOCALAPPDATA%\Programs\Python\ —
		// the Python installer's default per-user location, often not on Electron's PATH.
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires -- dynamic require needed for Electron-compatible runtime module loading
			const fs = require("fs") as typeof import("fs");
			const pythonBase = localAppData ? `${localAppData}\\Programs\\Python` : "";
			if (pythonBase && fs.existsSync(pythonBase)) {
				for (const entry of fs.readdirSync(pythonBase)) {
					if (/^Python3/i.test(String(entry))) {
						pathParts.add(`${pythonBase}\\${entry}`);
						pathParts.add(`${pythonBase}\\${entry}\\Scripts`);
					}
				}
			}
		} catch {
			// ignore — fallback probes in resolvePython() cover this
		}

		[
			`${userProfile}\\.local\\bin`,
			appData ? `${appData}\\npm` : "",
			localAppData ? `${localAppData}\\Microsoft\\WinGet\\Links` : "",
			localAppData ? `${localAppData}\\Microsoft\\WindowsApps` : "",
			localAppData ? `${localAppData}\\Python\\bin` : "",
			"C:\\Program Files\\nodejs",
			"C:\\Windows",
		]
			.filter(Boolean)
			.forEach((p) => pathParts.add(p));
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
		const python = this.resolvePython();

		const args = [options.claudePath];
		if (options.resumeLastSession) args.push("--continue");
		if (options.skipPermissions) args.push("--dangerously-skip-permissions");

		const proc = spawn(python, ["-c", winBridgeScript, ...args], {
			cwd: options.workingDirectory || this.resolvedEnv["USERPROFILE"] || "C:\\",
			env: { ...this.resolvedEnv, TERM: "xterm-color", COLORTERM: "truecolor" },
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});

		proc.once("spawn", () => this.resizePty(proc, options.cols, options.rows));

		return proc;
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
		const isWindows = process.platform === "win32";

		// On Windows, probe the filesystem directly before falling back to PATH lookup.
		// Electron's inherited PATH is stripped and often misses Python even when installed.
		if (isWindows) {
			// eslint-disable-next-line @typescript-eslint/no-var-requires -- dynamic require needed for Electron-compatible runtime module loading
			const fs = require("fs") as typeof import("fs");
			const localAppData = this.resolvedEnv["LOCALAPPDATA"] || "";

			// Enumerate %LOCALAPPDATA%\Programs\Python\Python3* — the default per-user
			// install location from python.org. Sort descending to prefer newer versions.
			if (localAppData) {
				const pythonBase = `${localAppData}\\Programs\\Python`;
				try {
					if (fs.existsSync(pythonBase)) {
						const entries = fs.readdirSync(pythonBase)
							.map(String)
							.filter((e) => /^Python3/i.test(e))
							.sort()
							.reverse();
						for (const entry of entries) {
							const exe = `${pythonBase}\\${entry}\\python.exe`;
							if (fs.existsSync(exe)) return exe;
						}
					}
				} catch {
					// fall through
				}

				// %LOCALAPPDATA%\Python\bin — used by uv and pyenv-win
				const uvProbe = `${localAppData}\\Python\\bin\\python.exe`;
				try {
					if (fs.existsSync(uvProbe)) return uvProbe;
				} catch {
					// fall through
				}
			}

			// System-wide installs and the Windows Python Launcher
			for (const probe of ["C:\\Windows\\py.exe", "C:\\Python3\\python.exe"]) {
				try {
					if (fs.existsSync(probe)) return probe;
				} catch {
					// continue
				}
			}
		}

		// PATH-based lookup (reliable on macOS/Linux; fallback on Windows)
		const candidates = isWindows ? ["python", "python3", "py"] : ["python3", "python"];
		const locator = isWindows ? "where" : "which";

		for (const exe of candidates) {
			try {
				const result = execSync(`${locator} ${exe}`, {
					env: this.resolvedEnv,
					timeout: 3000,
				});
				const p = result.toString().trim().split("\n")[0].trim();
				if (p) return p;
			} catch {
				// try next
			}
		}

		const installHint = isWindows
			? "Install Python 3 from https://www.python.org/downloads/"
			: "Install it via Homebrew: brew install python3";
		throw new Error(`Python 3 not found. ${installHint}`);
	}

	/**
	 * Runs Claude in non-interactive print mode with a plain prompt.
	 */
	runPrintMode(prompt: string, options: PrintModeOptions): Promise<PrintModeResult> {
		return this.runPrintModeWithContext("", prompt, options);
	}

	/**
	 * Runs Claude in streaming print mode, emitting text deltas via onToken as they arrive.
	 * Calls onComplete with the full final text, or onError on failure.
	 * Returns a kill function to abort the request.
	 */
	runPrintModeStreamingWithContext(
		context: string,
		prompt: string,
		options: PrintModeOptions,
		onToken: (delta: string) => void,
		onComplete: (fullText: string) => void,
		onError: (message: string) => void
	): () => void {
		const args = ["--print", "--output-format", "text"];
		if (options.model) args.push("--model", options.model);

		const proc = spawn(options.claudePath, args, {
			cwd: options.workingDirectory || undefined,
			env: { ...this.resolvedEnv },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const fullMessage = context ? `${context}\n\n${prompt}` : prompt;
		proc.stdin.write(fullMessage);
		proc.stdin.end();

		let fullText = "";
		let killed = false;
		let completed = false;

		const timeoutMs = options.timeoutMs ?? 120000;
		const timer = window.setTimeout(() => {
			if (killed || completed) return;
			killed = true;
			proc.kill();
			onError(`Request timed out after ${timeoutMs / 1000}s`);
		}, timeoutMs);

		proc.stdout.on("data", (chunk: Buffer) => {
			if (killed) return;
			const delta = chunk.toString();
			fullText += delta;
			onToken(delta);
		});

		let stderr = "";
		proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

		proc.on("close", (code: number | null) => {
			window.clearTimeout(timer);
			if (killed || completed) return;
			completed = true;
			if (code === 0) {
				onComplete(fullText);
			} else {
				onError(stderr.trim() || `Claude exited with code ${code}`);
			}
		});

		proc.on("error", (err: Error) => {
			window.clearTimeout(timer);
			if (killed || completed) return;
			completed = true;
			const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT";
			const isWindows = process.platform === "win32";
			const hint = isEnoent && isWindows
				? `Set the full path in Settings → Blackglass → "Claude binary path".`
				: `Is '${options.claudePath}' on your PATH?`;
			onError(`Failed to start Claude: ${err.message}. ${hint}`);
		});

		return () => {
			killed = true;
			window.clearTimeout(timer);
			try { proc.kill(); } catch { /* already dead */ }
		};
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

			const timer = window.setTimeout(() => {
				proc.kill();
				resolve({
					success: false,
					text: "",
					error: `Request timed out after ${timeoutMs / 1000}s`,
				});
			}, timeoutMs);

			proc.on("close", (code: number | null) => {
				window.clearTimeout(timer);

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
				window.clearTimeout(timer);
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
