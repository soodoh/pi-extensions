import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			exclude: [
				"**/*.test.*",
				"**/dist/**",
				"**/node_modules/**",
				"coverage/**",
				"packages/**/index.ts",
				"packages/statusline/**",
				"packages/workflows/**",
			],
			include: [
				"packages/prompt-suggester/src/app/services/suggestion-engine.ts",
				"packages/prompt-suggester/src/config/schema.ts",
				"packages/prompt-suggester/src/domain/usage.ts",
				"packages/prompt-suggester/src/infra/pi/ghost-accept-keys.ts",
				"packages/shared-prompt-history/history-store.ts",
			],
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage",
			thresholds: {
				branches: 80,
				functions: 80,
				lines: 80,
				statements: 80,
			},
		},
		exclude: ["**/node_modules/**", "**/dist/**"],
		include: ["packages/**/*.{test,spec}.{ts,js}"],
	},
});
