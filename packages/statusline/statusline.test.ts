import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import statusline from "./index";

const execFileAsync = promisify(execFile);

type Handler = (event: Record<string, unknown>, ctx: StatuslineContext) => void;
type Widget = {
	render(width: number): string[];
	dispose?(): void;
	invalidate?(): void;
};
type WidgetFactory = (
	tui: { requestRender?: () => void },
	theme: { fg(color: string, text: string): string },
) => Widget;
type FooterFactory = (
	tui: { requestRender?: () => void },
	theme: { fg(color: string, text: string): string },
	footerData: {
		getGitBranch(): string | null;
		onBranchChange(cb: () => void): () => void;
	},
) => Widget;
type StatuslineContext = {
	hasUI: boolean;
	ui: {
		setFooter(factory: FooterFactory | undefined): void;
		setWidget(key: string, factory: WidgetFactory | undefined): void;
	};
	model?: {
		name?: string;
		id?: string;
		provider?: string;
		contextWindow?: number;
	};
	modelRegistry?: {
		getAvailable(): Array<{ provider?: string }>;
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
		isUsingOAuth?(model: { provider?: string }): boolean;
		authStorage?: {
			get(
				provider: string,
			): { type: "oauth"; access?: string; refresh?: string } | undefined;
		};
	};
	sessionManager: { getBranch(): unknown[]; getCwd?(): string };
	settingsManager: { getCompactionSettings(): { enabled: boolean } };
	getContextUsage(): { tokens: number; contextWindow: number; percent: number };
};

function createPi() {
	const handlers = new Map<string, Handler>();
	return {
		handlers,
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, handler);
		},
	};
}

describe("statusline extension", () => {
	test("registers a below-editor widget and renders model/context smoke output", () => {
		let widgetFactory: WidgetFactory | undefined;
		let footerFactory: FooterFactory | undefined;
		const pi = createPi();
		statusline(pi);
		const ctx: StatuslineContext = {
			hasUI: true,
			ui: {
				setFooter(factory) {
					footerFactory = factory;
				},
				setWidget(key, factory) {
					expect(key).toBe("pi-statusline");
					widgetFactory = factory;
				},
			},
			model: {
				name: "Claude Sonnet Test",
				id: "sonnet-test",
				provider: "test-provider",
				contextWindow: 1000,
			},
			modelRegistry: {
				getAvailable() {
					return [];
				},
				async getApiKeyForProvider() {
					return undefined;
				},
			},
			sessionManager: { getBranch: () => [] },
			settingsManager: { getCompactionSettings: () => ({ enabled: true }) },
			getContextUsage: () => ({
				tokens: 250,
				contextWindow: 1000,
				percent: 25,
			}),
		};

		pi.handlers.get("session_start")?.({}, ctx);
		expect(footerFactory).toBeDefined();
		expect(widgetFactory).toBeDefined();

		footerFactory?.(
			{},
			{ fg: (_color, text) => text },
			{ getGitBranch: () => "main", onBranchChange: () => () => undefined },
		);
		const widget = widgetFactory?.({}, { fg: (_color, text) => text });
		const line = widget?.render(120).join("\n") ?? "";

		expect(line).toContain("Sonnet Test");
		expect(line).toContain("25.0%/1.0k");
	});

	test("uses stored GitHub Copilot access credential for OAuth usage", async () => {
		const fetchCalls: RequestInit[] = [];
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				fetchCalls.push(init ?? {});
				return Response.json({
					quotaSnapshots: {
						premiumInteractions: { percent_used: 42 },
					},
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			let widgetFactory: WidgetFactory | undefined;
			const pi = createPi();
			statusline(pi);
			const ctx: StatuslineContext = {
				hasUI: true,
				ui: {
					setFooter() {},
					setWidget(_key, factory) {
						widgetFactory = factory;
					},
				},
				model: { id: "copilot", provider: "github-copilot" },
				modelRegistry: {
					getAvailable() {
						return [];
					},
					async getApiKeyForProvider() {
						return "provider-token";
					},
					isUsingOAuth() {
						return true;
					},
					authStorage: {
						get(provider) {
							return provider === "github-copilot"
								? {
										type: "oauth",
										access: "stored-access-token",
										refresh: "stored-refresh-token",
									}
								: undefined;
						},
					},
				},
				sessionManager: { getBranch: () => [] },
				settingsManager: { getCompactionSettings: () => ({ enabled: true }) },
				getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
			};

			pi.handlers.get("session_start")?.({}, ctx);
			widgetFactory?.({}, { fg: (_color, text) => text }).render(120);

			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
			expect(fetchCalls[0].headers).toMatchObject({
				Authorization: "token stored-access-token",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test("scopes git status cache by active session cwd", async () => {
		const repoOne = await mkdtemp(join(tmpdir(), "pi-statusline-repo-one-"));
		const repoTwo = await mkdtemp(join(tmpdir(), "pi-statusline-repo-two-"));
		for (const repo of [repoOne, repoTwo]) {
			await execFileAsync("git", ["init"], { cwd: repo });
			await execFileAsync("git", ["config", "user.email", "test@example.com"], {
				cwd: repo,
			});
			await execFileAsync("git", ["config", "user.name", "Test User"], {
				cwd: repo,
			});
			await writeFile(join(repo, "tracked.txt"), "initial\n", "utf8");
			await execFileAsync("git", ["add", "tracked.txt"], { cwd: repo });
			await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
		}
		await writeFile(join(repoOne, "tracked.txt"), "modified\n", "utf8");
		const { stdout: repoTwoBranchOutput } = await execFileAsync(
			"git",
			["branch", "--show-current"],
			{ cwd: repoTwo },
		);
		const repoTwoBranch = repoTwoBranchOutput.trim();

		let widgetFactory: WidgetFactory | undefined;
		const pi = createPi();
		statusline(pi);
		const makeCtx = (cwd: string): StatuslineContext => ({
			hasUI: true,
			ui: {
				setFooter() {},
				setWidget(_key, factory) {
					widgetFactory = factory;
				},
			},
			model: { name: "Test Model", contextWindow: 1000 },
			modelRegistry: {
				getAvailable() {
					return [];
				},
				async getApiKeyForProvider() {
					return undefined;
				},
			},
			sessionManager: { getBranch: () => [], getCwd: () => cwd },
			settingsManager: { getCompactionSettings: () => ({ enabled: true }) },
			getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
		});

		pi.handlers.get("session_start")?.({}, makeCtx(repoOne));
		const widget = widgetFactory?.(
			{},
			{ fg: (_color: string, text: string) => text },
		);
		if (!widget) throw new Error("expected statusline widget");
		const render = () => widget.render(120).join("\n");
		render();
		await vi.waitFor(() => expect(render()).toMatch(/[+*]1/));

		pi.handlers.get("session_start")?.({}, makeCtx(repoTwo));
		await vi.waitFor(() => expect(render()).toContain(repoTwoBranch));
		expect(render()).not.toMatch(/[+*]1/);
	});
});
