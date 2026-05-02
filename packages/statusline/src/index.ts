import { resolve } from "node:path";
import {
	type GitStatus,
	getGitStatus,
	invalidateGit,
	type ReadonlyFooterDataProvider,
} from "./git-status";
import type { ModelLike, ModelRegistryLike } from "./pi-types";
import {
	discoverProviderUsageTargets,
	invalidateProviderUsageCache,
	isProviderUsageEnabled,
	refreshProviderUsage,
	renderProviderUsage,
} from "./provider-usage";

type Theme = {
	fg(color: string, text: string): string;
};

type TuiLike = {
	requestRender?: () => void;
};

type ExtensionContext = {
	hasUI: boolean;
	ui: {
		setFooter(
			factory:
				| ((
						tui: TuiLike,
						theme: Theme,
						footerData: ReadonlyFooterDataProvider,
				  ) => {
						dispose?(): void;
						invalidate?(): void;
						render(width?: number): string[];
				  })
				| undefined,
		): void;
		setWidget(
			key: string,
			factory:
				| ((
						tui: TuiLike,
						theme: Theme,
				  ) => {
						dispose?(): void;
						invalidate?(): void;
						render(width: number): string[];
				  })
				| undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	};
	sessionManager?: {
		getBranch?(): unknown[];
		getCwd?(): string;
	};
	model?: ModelLike;
	modelRegistry?: ModelRegistryLike;
	settingsManager?: {
		getCompactionSettings?(): { enabled?: boolean } | undefined;
	};
	getContextUsage?():
		| {
				tokens: number | null;
				contextWindow: number;
				percent: number | null;
		  }
		| undefined;
};

type AfterProviderResponseEvent = {
	status: number;
	headers: Record<string, string>;
};

type ExtensionEvent = Partial<AfterProviderResponseEvent> & {
	toolName?: string;
};

type ExtensionEventName =
	| "session_start"
	| "session_shutdown"
	| "agent_start"
	| "agent_end"
	| "input"
	| "tool_result"
	| "session_compact"
	| "after_provider_response"
	| "model_select";

type ExtensionAPI = {
	on(
		eventName: ExtensionEventName,
		handler: (
			event: ExtensionEvent,
			ctx: ExtensionContext,
		) => void | Promise<void>,
	): void;
};

const ANSI_RESET = "\x1b[0m";
const SEPARATOR_COLOR = "\x1b[38;5;244m";
const POWERLINE_THIN_LEFT = "\uE0B1";
const ASCII_THIN_LEFT = "|";
const NERD_ICONS = {
	model: "\uEC19",
	branch: "\uF126",
	context: "\uE70F",
	auto: "\u{F0068}",
	provider: "\uF544",
	anthropic: "\uF544",
	openai: "\uE7CF",
	openrouter: "\uF135",
	github: "\uF09B",
	google: "\uE7B2",
	antigravity: "\uF11E",
};

const ASCII_ICONS = {
	model: "",
	branch: "⎇",
	context: "◫",
	auto: "AC",
	provider: "",
	anthropic: "",
	openai: "",
	openrouter: "",
	github: "",
	google: "",
	antigravity: "",
};

type ThemeColor = Parameters<Theme["fg"]>[0];
type SemanticColor =
	| "model"
	| "gitDirty"
	| "gitClean"
	| "providerUsage"
	| "context"
	| "contextWarn"
	| "contextError";
type ColorValue = ThemeColor | `#${string}`;

type AssistantTokenUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

const COLORS: Record<SemanticColor, ColorValue> = {
	model: "#d787af",
	gitDirty: "warning",
	gitClean: "success",
	providerUsage: "dim",
	context: "dim",
	contextWarn: "warning",
	contextError: "error",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNerdFonts(): boolean {
	if (process.env.POWERLINE_NERD_FONTS === "1") return true;
	if (process.env.POWERLINE_NERD_FONTS === "0") return false;
	if (process.env.GHOSTTY_RESOURCES_DIR) return true;

	const term = (process.env.TERM_PROGRAM || "").toLowerCase();
	return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some((t) =>
		term.includes(t),
	);
}

function icons(): typeof NERD_ICONS {
	return hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
}

function separator(): string {
	return hasNerdFonts() ? POWERLINE_THIN_LEFT : ASCII_THIN_LEFT;
}

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

function hexToAnsi(hex: string): string {
	const h = hex.replace("#", "");
	const r = Number.parseInt(h.slice(0, 2), 16);
	const g = Number.parseInt(h.slice(2, 4), 16);
	const b = Number.parseInt(h.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function isHexColor(color: ColorValue): color is `#${string}` {
	return /^#[0-9a-fA-F]{6}$/.test(color);
}

function applyColor(theme: Theme, color: ColorValue, text: string): string {
	if (isHexColor(color)) {
		return `${hexToAnsi(color)}${text}${ANSI_RESET}`;
	}
	return theme.fg(color, text);
}

function color(theme: Theme, semantic: SemanticColor, text: string): string {
	return applyColor(theme, COLORS[semantic], text);
}

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

const ANSI_PATTERN = String.raw`\x1B\[[0-?]*[ -/]*[@-~]`;

function stripAnsi(text: string): string {
	return text.replace(new RegExp(ANSI_PATTERN, "g"), "");
}

function displayLength(text: string): number {
	return Array.from(stripAnsi(text)).length;
}

function isAssistantMessageWithUsage(
	value: unknown,
): value is { usage: AssistantTokenUsage; stopReason?: string } {
	if (!isRecord(value)) return false;
	const usage = value.usage;
	if (!isRecord(usage)) return false;
	return (
		value.role === "assistant" &&
		typeof usage.input === "number" &&
		typeof usage.output === "number" &&
		typeof usage.cacheRead === "number" &&
		typeof usage.cacheWrite === "number" &&
		(value.stopReason === undefined || typeof value.stopReason === "string")
	);
}

function collectContextTokens(ctx: ExtensionContext): number {
	let lastAssistant: { usage: AssistantTokenUsage } | undefined;
	const branch = ctx.sessionManager?.getBranch?.() ?? [];

	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isAssistantMessageWithUsage(message)) continue;
		if (message.stopReason === "error" || message.stopReason === "aborted")
			continue;

		lastAssistant = message;
	}

	const contextTokens = lastAssistant
		? lastAssistant.usage.input +
			lastAssistant.usage.output +
			lastAssistant.usage.cacheRead +
			lastAssistant.usage.cacheWrite
		: (ctx.getContextUsage?.()?.tokens ?? 0);

	return contextTokens ?? 0;
}

function renderModel(ctx: ExtensionContext, theme: Theme): string {
	let modelName = ctx.model?.name || ctx.model?.id || "no-model";
	if (modelName.startsWith("Claude ")) modelName = modelName.slice(7);
	return color(theme, "model", withIcon(icons().model, modelName));
}

function renderGit(git: GitStatus, theme: Theme): string | undefined {
	const { branch, staged, unstaged, untracked } = git;
	const isDirty = staged > 0 || unstaged > 0 || untracked > 0;
	if (!branch && !isDirty) return undefined;

	let content = "";
	if (branch) {
		content = color(
			theme,
			isDirty ? "gitDirty" : "gitClean",
			withIcon(icons().branch, branch),
		);
	}

	const indicators: string[] = [];
	if (unstaged > 0) indicators.push(theme.fg("warning", `*${unstaged}`));
	if (staged > 0) indicators.push(theme.fg("success", `+${staged}`));
	if (indicators.length > 0)
		content += content ? ` ${indicators.join(" ")}` : indicators.join(" ");

	return content || undefined;
}

function renderContext(
	ctx: ExtensionContext,
	contextTokens: number,
	theme: Theme,
): string | undefined {
	const contextUsage = ctx.getContextUsage?.();
	const contextWindow =
		contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (!contextWindow) return undefined;

	const pct = contextUsage?.percent ?? (contextTokens / contextWindow) * 100;
	const autoCompactEnabled =
		ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true;
	const autoIcon = autoCompactEnabled && icons().auto ? ` ${icons().auto}` : "";
	const text = `${pct.toFixed(1)}%/${formatTokens(contextWindow)}${autoIcon}`;
	const semantic =
		pct > 90 ? "contextError" : pct > 70 ? "contextWarn" : "context";
	return withIcon(icons().context, color(theme, semantic, text));
}

function formatLine(parts: (string | undefined)[]): string {
	const visibleParts = parts.filter((part): part is string => Boolean(part));
	if (visibleParts.length === 0) return "";
	return ` ${visibleParts.join(` ${SEPARATOR_COLOR}${separator()}${ANSI_RESET} `)}${ANSI_RESET} `;
}

function sessionCwd(ctx: ExtensionContext): string {
	return resolve(ctx.sessionManager?.getCwd?.() ?? process.cwd());
}

function buildCompactLine(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider | null,
	onUpdate: () => void,
	width: number,
): string {
	const providerUsageEnabled = isProviderUsageEnabled();
	const providerUsageTargets = providerUsageEnabled
		? discoverProviderUsageTargets(ctx)
		: [];
	if (providerUsageEnabled) {
		refreshProviderUsage(ctx, providerUsageTargets, onUpdate);
	}

	const contextTokens = collectContextTokens(ctx);
	const providerBranch = footerData?.getGitBranch() ?? null;
	const git = getGitStatus(sessionCwd(ctx), providerBranch, onUpdate);
	const modelPart = renderModel(ctx, theme);
	const gitPart = renderGit(git, theme);
	const contextPart = renderContext(ctx, contextTokens, theme);
	const providerPart = providerUsageEnabled
		? renderProviderUsage(providerUsageTargets, theme, false, icons())
		: undefined;
	const activeProviderPart = providerUsageEnabled
		? renderProviderUsage(providerUsageTargets, theme, true, icons())
		: undefined;

	const fullLine = formatLine([modelPart, gitPart, providerPart, contextPart]);
	if (!width || displayLength(fullLine) <= width) return fullLine;

	const activeProviderLine = formatLine([
		modelPart,
		gitPart,
		activeProviderPart,
		contextPart,
	]);
	if (displayLength(activeProviderLine) <= width) return activeProviderLine;

	return formatLine([modelPart, gitPart, contextPart]);
}

export default function statusline(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | null = null;
	let footerData: ReadonlyFooterDataProvider | null = null;
	let tuiRef: { requestRender?: () => void } | null = null;

	const requestRender = () => tuiRef?.requestRender?.();
	const refreshCurrentProviderUsage = (ctx: ExtensionContext): void => {
		currentCtx = ctx;
		if (isProviderUsageEnabled()) {
			refreshProviderUsage(
				ctx,
				discoverProviderUsageTargets(ctx),
				requestRender,
			);
		}
	};

	function install(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		currentCtx = ctx;
		if (isProviderUsageEnabled()) {
			refreshProviderUsage(
				ctx,
				discoverProviderUsageTargets(ctx),
				requestRender,
			);
		}

		ctx.ui.setFooter((tui, _theme, data) => {
			tuiRef = tui;
			footerData = data;
			const unsubscribe = data.onBranchChange(() => {
				invalidateGit();
				requestRender();
			});

			return {
				dispose: unsubscribe,
				invalidate: requestRender,
				render: () => [],
			};
		});

		ctx.ui.setWidget(
			"pi-statusline",
			(tui, theme) => {
				tuiRef = tui;
				return {
					dispose() {},
					invalidate: requestRender,
					render(width: number): string[] {
						if (!currentCtx) return [];
						const line = buildCompactLine(
							currentCtx,
							theme,
							footerData,
							requestRender,
							width,
						);
						return line ? [line] : [];
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	pi.on("session_start", (_event, ctx) => {
		invalidateProviderUsageCache();
		install(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (currentCtx === ctx) currentCtx = null;
	});
	pi.on("agent_start", (_event, ctx) => {
		currentCtx = ctx;
		requestRender();
	});
	pi.on("agent_end", (_event, ctx) => {
		refreshCurrentProviderUsage(ctx);
		requestRender();
	});
	pi.on("after_provider_response", (_event, ctx) => {
		refreshCurrentProviderUsage(ctx);
		requestRender();
	});
	pi.on("model_select", (_event, ctx) => {
		invalidateProviderUsageCache();
		refreshCurrentProviderUsage(ctx);
		requestRender();
	});
	pi.on("input", (_event, ctx) => {
		currentCtx = ctx;
		requestRender();
	});
	pi.on("tool_result", (event, ctx) => {
		currentCtx = ctx;
		if (event.toolName === "bash") invalidateGit();
		requestRender();
	});
	pi.on("session_compact", (_event, ctx) => {
		currentCtx = ctx;
		requestRender();
	});
}
