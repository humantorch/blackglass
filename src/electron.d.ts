declare module "electron" {
	const shell: {
		openExternal(url: string): void;
	};
	export { shell };
}
