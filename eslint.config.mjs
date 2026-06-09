import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": ["error", {
				brands: ["Blackglass", "Claude", "Claude Code", "Obsidian"],
				acronyms: ["MCP", "CLI", "PTY", "UI", "API", "JSON", "HTTP", "URL"],
			}],
		},
	},
	{
		ignores: ["node_modules/**", "main.js"],
	},
];
