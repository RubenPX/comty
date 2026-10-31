import { defineConfig, configDefaults } from "vitest/config"
import path from "path"

export default defineConfig({
	test: {
		// The protobuf generator has Bun-native tests; keep the Node/Vitest suite separate.
		exclude: [...configDefaults.exclude, "scripts/generate-proto.test.ts"],
		environment: "node",
		globals: true,
		setupFiles: [],
		testTimeout: 30000,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["**/*.{ts,js}"],
			exclude: ["**/node_modules/**", "**/*.test.{ts,js}", "**/dist/**"],
		},
	},
	resolve: {
		alias: {
			"^@shared-classes/Scylla$": path.resolve(
				__dirname,
				"classes/Scylla/index.ts",
			),
			"^@shared-classes/Scylla/(.*)$": path.resolve(
				__dirname,
				"classes/Scylla/$1",
			),
		},
	},
})
