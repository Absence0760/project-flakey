import { sveltekit } from "@sveltejs/kit/vite";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";
import kitConfig from "./kit.config.js";

export default defineConfig({
	plugins: [
		sveltekit(kitConfig()),
		Icons({
			autoInstall: true,
			compiler: "svelte",
		}),
	],
});
