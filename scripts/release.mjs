#!/usr/bin/env node
/**
 * Release script for Blackglass.
 *
 * Usage: npm run release:patch | release:minor | release:major
 *
 * Bumps the version in manifest.json and package.json, then:
 *   1. Checks that the working tree is clean
 *   2. Builds (tsc + esbuild)
 *   3. Commits the version bump
 *   4. Generates release notes using claude --print
 *   5. Creates and pushes a X.X.X git tag
 *   6. Creates a GitHub release with main.js, manifest.json, styles.css attached
 *   7. Bumps the version badge on the gh-pages website
 *   8. Cleans up local temp files
 */

import { execSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const bumpType = process.argv[2];
if (!["patch", "minor", "major"].includes(bumpType)) {
	console.error("Usage: npm run release:patch | release:minor | release:major");
	process.exit(1);
}

function bumpVersion(current, type) {
	const [major, minor, patch] = current.split(".").map(Number);
	if (type === "major") return `${major + 1}.0.0`;
	if (type === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

const manifestPath = resolve(root, "manifest.json");
const packagePath = resolve(root, "package.json");
const versionsPath = resolve(root, "versions.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));

const oldVersion = manifest.version;
const version = bumpVersion(oldVersion, bumpType);
const tag = version; // Obsidian requires tags without a 'v' prefix
const notesFile = resolve(tmpdir(), `blackglass-release-notes-${version}.md`);

console.log(`\nBumping ${bumpType}: ${oldVersion} -> ${version}\n`);

// Guard: clean working tree
const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim();
if (dirty) {
	console.error("Uncommitted changes present. Commit or stash them before releasing.");
	process.exit(1);
}

// Guard: tag must not already exist
try {
	execSync(`git rev-parse ${tag}`, { cwd: root, stdio: "ignore" });
	console.error(`Tag ${tag} already exists.`);
	process.exit(1);
} catch {
	// Tag does not exist — good to proceed
}

// Write version to manifest.json, package.json, and versions.json
manifest.version = version;
pkg.version = version;
versions[version] = manifest.minAppVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");

// Build first — if it fails, nothing is committed or tagged
console.log("Building...");
execSync("npm run build", { cwd: root, stdio: "inherit" });

// Commit version bump
console.log("\nCommitting version bump...");
execSync("git add manifest.json package.json versions.json", { cwd: root });
execSync(`git commit -m "Bump version to ${version}"`, { cwd: root, stdio: "inherit" });
execSync("git push origin main", { cwd: root, stdio: "inherit" });

// Generate release notes using claude --print
console.log("\nGenerating release notes...");
let notesArg = "--generate-notes";
try {
	const lastTag = execSync("git describe --tags --abbrev=0 HEAD^", { cwd: root })
		.toString()
		.trim();
	const commits = execSync(`git log ${lastTag}..HEAD --format="- %s"`, { cwd: root })
		.toString()
		.trim();

	const prompt =
		`Write release notes for version ${version} of Blackglass, an Obsidian plugin ` +
		`that embeds Claude Code as an interactive terminal with a built-in vault MCP server.\n\n` +
		`Format as markdown. Start with "## What's new". Group related changes under ` +
		`subheadings if there are multiple themes. Be specific and user-focused — describe ` +
		`what users can now do or what problems are fixed. Keep it concise.\n\n` +
		`Commits since ${lastTag}:\n${commits}`;

	const result = spawnSync("claude", ["--print"], {
		input: prompt,
		cwd: root,
		encoding: "utf8",
	});

	if (result.status === 0 && result.stdout.trim()) {
		// Claude sometimes wraps --print output in ```markdown ... ``` fences.
		// Strip them so the GitHub release notes render as plain markdown.
		let notes = result.stdout.trim();
		notes = notes.replace(/^```[a-z]*\n/, "").replace(/\n```$/, "").trim();
		writeFileSync(notesFile, notes);
		notesArg = `--notes-file ${notesFile}`;
		console.log("Release notes generated.");
	} else {
		console.warn("claude --print returned no output, falling back to auto-generated notes.");
	}
} catch (err) {
	console.warn(`Could not generate release notes (${err.message}), falling back to auto-generated notes.`);
}

// Tag + push
console.log(`\nTagging ${tag}...`);
execSync(`git tag -a ${tag} -m "${tag}"`, { cwd: root, stdio: "inherit" });
execSync(`git push origin ${tag}`, { cwd: root, stdio: "inherit" });

// GitHub release — attach individual files (Obsidian requires main.js, manifest.json, styles.css as direct assets)
console.log("\nCreating GitHub release...");
// main.js and styles.css are uploaded by the GitHub Actions release workflow
// after it builds and attests them. The script only creates the release shell.
const url = execSync(
	`gh release create ${tag} manifest.json --title "${tag}" ${notesArg}`,
	{ cwd: root }
).toString().trim();

// Bump version badge on gh-pages website
console.log("\nUpdating gh-pages version badge...");
const worktreePath = resolve(tmpdir(), `blackglass-gh-pages-${version}`);
try {
	execSync(`git worktree add ${worktreePath} gh-pages`, { cwd: root });
	const indexPath = resolve(worktreePath, "index.html");
	const indexContent = readFileSync(indexPath, "utf8");
	const updated = indexContent.replace(
		/Obsidian Plugin · v[\d.]+/,
		`Obsidian Plugin · v${version}`
	);
	writeFileSync(indexPath, updated);
	execSync("git add index.html", { cwd: worktreePath });
	execSync(`git commit -m "Bump version badge to v${version}"`, { cwd: worktreePath });
	execSync("git push origin gh-pages", { cwd: worktreePath, stdio: "inherit" });
	console.log("gh-pages updated.");
} catch (err) {
	console.warn(`Could not update gh-pages (${err.message}). Update the version badge manually.`);
} finally {
	execSync(`git worktree remove --force ${worktreePath}`, { cwd: root, stdio: "ignore" });
}

// Clean up local temp files
if (existsSync(notesFile)) unlinkSync(notesFile);

console.log(`\nDone: ${url}\n`);
