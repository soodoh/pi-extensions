import type {
	AuthCredentialLike,
	ModelLike,
	ModelRegistryLike,
	ProviderUsageContext,
} from "./pi-types";

const PROVIDER_USAGE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_USAGE_FETCH_TIMEOUT_MS = 5000;
const PROVIDER_BADGE_SEPARATOR = " · ";

type ThemeLike = {
	fg(color: string, text: string): string;
};

type ProviderUsageAuthKind = "oauth" | "api_key" | "unknown";
type ProviderUsageState = "ready" | "unknown" | "error" | "unsupported";

type ProviderUsageScope = {
	sessionPercentUsed?: number;
	weeklyPercentUsed?: number;
	monthlyPercentUsed?: number;
	percentUsed?: number;
	balanceUsd?: number;
	creditsUsd?: number;
};

type ProviderUsageStatus = {
	providerId: string;
	authKind: ProviderUsageAuthKind;
	state: ProviderUsageState;
	scope?: ProviderUsageScope;
	fetchedAt?: number;
};

type ProviderUsageCacheEntry = ProviderUsageStatus & {
	lastAttemptAt?: number;
	pending?: Promise<void>;
};

export type ProviderUsageTarget = {
	providerId: string;
	authKind: ProviderUsageAuthKind;
	active: boolean;
};

const OAUTH_PROVIDER_IDS = new Set([
	"anthropic",
	"openai-codex",
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
]);
const API_KEY_PROVIDER_IDS = new Set(["anthropic", "openai", "openrouter"]);
const PROVIDER_FAMILY_ORDER = [
	"anthropic",
	"openai",
	"openrouter",
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
];

type AvailableModelsCacheEntry = {
	models?: ModelLike[];
	pending?: Promise<void>;
	callbacks: Set<() => void>;
};

const providerUsageCache = new Map<string, ProviderUsageCacheEntry>();
let availableModelsCache = new WeakMap<
	ModelRegistryLike,
	AvailableModelsCacheEntry
>();
let providerUsageInvalidation = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProviderId(providerId: string): string {
	return providerId.trim().toLowerCase();
}

function providerFamily(providerId: string): string {
	const normalized = normalizeProviderId(providerId);
	if (normalized === "openai-codex" || normalized === "openai") {
		return "openai";
	}
	return normalized;
}

function providerOrder(providerId: string): number {
	const family = providerFamily(providerId);
	const index = PROVIDER_FAMILY_ORDER.indexOf(family);
	return index === -1 ? PROVIDER_FAMILY_ORDER.length : index;
}

function providerCacheKey(
	providerId: string,
	authKind: ProviderUsageAuthKind,
): string {
	return `${normalizeProviderId(providerId)}:${authKind}`;
}

function isProviderSupportedAuth(
	providerId: string,
	authKind: ProviderUsageAuthKind,
): boolean {
	const normalized = normalizeProviderId(providerId);
	if (authKind === "oauth") return OAUTH_PROVIDER_IDS.has(normalized);
	if (authKind === "api_key") return API_KEY_PROVIDER_IDS.has(normalized);
	return false;
}

function addProviderCandidate(
	candidates: ProviderUsageTarget[],
	providerId: string | undefined,
	authKind: ProviderUsageAuthKind,
	activeProviderId: string | undefined,
	includeUnsupported = false,
): void {
	if (!providerId) return;
	const normalized = normalizeProviderId(providerId);
	if (!normalized) return;
	if (!includeUnsupported && !isProviderSupportedAuth(normalized, authKind)) {
		return;
	}

	candidates.push({
		providerId: normalized,
		authKind,
		active: activeProviderId === normalized,
	});
}

function modelAuthKind(
	ctx: ProviderUsageContext,
	model: ModelLike,
): ProviderUsageAuthKind | undefined {
	if (ctx.modelRegistry?.isUsingOAuth?.(model)) return "oauth";
	const providerId = model.provider
		? normalizeProviderId(model.provider)
		: undefined;
	const credential = providerId
		? ctx.modelRegistry?.authStorage?.get?.(providerId)
		: undefined;
	if (credential?.type === "oauth") return "oauth";
	if (credential?.type === "api_key") return "api_key";
	return providerId && API_KEY_PROVIDER_IDS.has(providerId)
		? "api_key"
		: undefined;
}

function getConfiguredModels(
	ctx: ProviderUsageContext,
	onUpdate?: () => void,
): ModelLike[] {
	const registry = ctx.modelRegistry;
	if (!registry) return [];

	const cached = availableModelsCache.get(registry);
	if (cached?.models) return cached.models;
	if (cached?.pending) {
		if (onUpdate) cached.callbacks.add(onUpdate);
		return [];
	}

	const available = registry.getAvailable?.();
	if (Array.isArray(available)) {
		availableModelsCache.set(registry, {
			models: available,
			callbacks: new Set(),
		});
		return available;
	}
	if (available) {
		const entry: AvailableModelsCacheEntry = { callbacks: new Set() };
		if (onUpdate) entry.callbacks.add(onUpdate);
		entry.pending = available
			.then((models) => {
				entry.models = Array.isArray(models) ? models : [];
			})
			.catch(() => {
				availableModelsCache.delete(registry);
			})
			.finally(() => {
				entry.pending = undefined;
				for (const callback of entry.callbacks) callback();
				entry.callbacks.clear();
			});
		availableModelsCache.set(registry, entry);
		return [];
	}

	const allModels = registry.getAll?.() ?? [];
	const hasConfiguredAuth = registry.hasConfiguredAuth;
	return hasConfiguredAuth
		? allModels.filter((model) => hasConfiguredAuth(model))
		: [];
}

function providerAuthKindOrder(authKind: ProviderUsageAuthKind): number {
	if (authKind === "oauth") return 0;
	if (authKind === "api_key") return 1;
	return 2;
}

function preferProviderCandidate(
	current: ProviderUsageTarget | undefined,
	candidate: ProviderUsageTarget,
	activeProviderId: string | undefined,
	activeAuthKind: ProviderUsageAuthKind | undefined,
): ProviderUsageTarget {
	if (!current) return candidate;

	const candidateMatchesActive = candidate.providerId === activeProviderId;
	const currentMatchesActive = current.providerId === activeProviderId;
	if (candidateMatchesActive !== currentMatchesActive) {
		return candidateMatchesActive ? candidate : current;
	}

	if (candidateMatchesActive && currentMatchesActive && activeAuthKind) {
		if (
			candidate.authKind === activeAuthKind &&
			current.authKind !== activeAuthKind
		) {
			return candidate;
		}
		if (
			current.authKind === activeAuthKind &&
			candidate.authKind !== activeAuthKind
		) {
			return current;
		}
	}

	if (candidate.authKind !== current.authKind) {
		return providerAuthKindOrder(candidate.authKind) <
			providerAuthKindOrder(current.authKind)
			? candidate
			: current;
	}

	return providerOrder(candidate.providerId) < providerOrder(current.providerId)
		? candidate
		: current;
}

export function discoverProviderUsageTargets(
	ctx: ProviderUsageContext,
): ProviderUsageTarget[] {
	const activeProviderId = ctx.model?.provider
		? normalizeProviderId(ctx.model.provider)
		: undefined;
	const activeAuthKind = ctx.model ? modelAuthKind(ctx, ctx.model) : undefined;
	const candidates: ProviderUsageTarget[] = [];

	if (activeProviderId && activeAuthKind) {
		addProviderCandidate(
			candidates,
			activeProviderId,
			activeAuthKind,
			activeProviderId,
			true,
		);
	} else if (activeProviderId) {
		let addedActiveProvider = false;
		if (OAUTH_PROVIDER_IDS.has(activeProviderId)) {
			addProviderCandidate(
				candidates,
				activeProviderId,
				"oauth",
				activeProviderId,
			);
			addedActiveProvider = true;
		}
		if (API_KEY_PROVIDER_IDS.has(activeProviderId)) {
			addProviderCandidate(
				candidates,
				activeProviderId,
				"api_key",
				activeProviderId,
			);
			addedActiveProvider = true;
		}
		if (!addedActiveProvider) {
			addProviderCandidate(
				candidates,
				activeProviderId,
				"unknown",
				activeProviderId,
				true,
			);
		}
	}

	for (const model of getConfiguredModels(ctx)) {
		const authKind = modelAuthKind(ctx, model);
		if (authKind) {
			addProviderCandidate(
				candidates,
				model.provider,
				authKind,
				activeProviderId,
			);
		}
	}

	const authStorage = ctx.modelRegistry?.authStorage;
	for (const providerId of authStorage?.list?.() ?? []) {
		const normalized = normalizeProviderId(providerId);
		const credential = authStorage?.get?.(normalized);
		if (credential?.type === "oauth") {
			addProviderCandidate(candidates, normalized, "oauth", activeProviderId);
		} else if (credential?.type === "api_key") {
			addProviderCandidate(candidates, normalized, "api_key", activeProviderId);
		}
	}

	for (const provider of authStorage?.getOAuthProviders?.() ?? []) {
		const normalized = normalizeProviderId(provider.id);
		if (authStorage?.hasAuth?.(normalized)) {
			addProviderCandidate(candidates, normalized, "oauth", activeProviderId);
		}
	}

	const byFamily = new Map<string, ProviderUsageTarget>();
	for (const candidate of candidates) {
		const family = providerFamily(candidate.providerId);
		byFamily.set(
			family,
			preferProviderCandidate(
				byFamily.get(family),
				candidate,
				activeProviderId,
				activeAuthKind,
			),
		);
	}

	return [...byFamily.values()].sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		return providerOrder(a.providerId) - providerOrder(b.providerId);
	});
}

async function getProviderToken(
	ctx: ProviderUsageContext,
	providerId: string,
): Promise<string | undefined> {
	return ctx.modelRegistry?.getApiKeyForProvider?.(providerId);
}

function getStoredOAuthCredential(
	ctx: ProviderUsageContext,
	providerId: string,
): Extract<AuthCredentialLike, { type: "oauth" }> | undefined {
	const credential = ctx.modelRegistry?.authStorage?.get?.(providerId);
	return credential?.type === "oauth" ? credential : undefined;
}

async function getOAuthProviderToken(
	ctx: ProviderUsageContext,
	providerId: string,
): Promise<string | undefined> {
	const credential = getStoredOAuthCredential(ctx, providerId);
	return credential?.access ?? (await getProviderToken(ctx, providerId));
}

async function getGitHubCopilotUserToken(
	ctx: ProviderUsageContext,
): Promise<string | undefined> {
	return getOAuthProviderToken(ctx, "github-copilot");
}

function numericField(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function nestedRecord(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const child = value[key];
	return isRecord(child) ? child : undefined;
}

async function fetchJson(
	url: string,
	init: RequestInit,
): Promise<unknown | undefined> {
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(PROVIDER_USAGE_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;
	return response.json();
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function parseUtilization(value: unknown): number | undefined {
	const numeric = numericField(value);
	return numeric === undefined ? undefined : clampPercent(numeric);
}

async function fetchOpenRouterKeyStatus(
	token: string,
): Promise<ProviderUsageScope | undefined> {
	const body = await fetchJson("https://openrouter.ai/api/v1/key", {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!isRecord(body) || !isRecord(body.data)) return undefined;

	const remaining = numericField(body.data.limit_remaining);
	if (remaining !== undefined) return { balanceUsd: remaining };

	const limit = numericField(body.data.limit);
	const usage = numericField(body.data.usage);
	if (limit !== undefined && usage !== undefined) {
		return { balanceUsd: limit - usage };
	}

	return undefined;
}

async function fetchOpenRouterCredits(
	token: string,
): Promise<ProviderUsageScope | undefined> {
	const body = await fetchJson("https://openrouter.ai/api/v1/credits", {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!isRecord(body) || !isRecord(body.data)) return undefined;

	const totalCredits = numericField(body.data.total_credits);
	const totalUsage = numericField(body.data.total_usage);
	if (totalCredits === undefined || totalUsage === undefined) return undefined;

	return {
		balanceUsd: totalCredits - totalUsage,
		creditsUsd: totalCredits,
	};
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
	const [, encoded] = token.split(".");
	if (!encoded) return undefined;
	try {
		const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
	} catch {
		return undefined;
	}
}

function extractOpenAiAccountId(token: string): string | undefined {
	const payload = jwtPayload(token);
	if (!payload) return undefined;
	const authClaim = nestedRecord(payload, "https://api.openai.com/auth");
	const accountId = authClaim?.chatgpt_account_id ?? authClaim?.account_id;
	return typeof accountId === "string" && accountId ? accountId : undefined;
}

async function fetchAnthropicOAuthUsage(
	token: string,
): Promise<ProviderUsageScope | undefined> {
	const body = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
			"anthropic-version": "2023-06-01",
			"User-Agent": "pi-statusline",
		},
	});
	if (!isRecord(body)) return undefined;

	const fiveHour = nestedRecord(body, "five_hour");
	const sevenDay = nestedRecord(body, "seven_day");
	const sevenDaySonnet = nestedRecord(body, "seven_day_sonnet");
	const sevenDayOpus = nestedRecord(body, "seven_day_opus");
	const sessionPercentUsed = fiveHour
		? parseUtilization(
				fiveHour.utilization ??
					fiveHour.used_percentage ??
					fiveHour.used_percent,
			)
		: undefined;
	const weeklyCandidates = [sevenDay, sevenDaySonnet, sevenDayOpus]
		.map((record) =>
			record
				? parseUtilization(
						record.utilization ?? record.used_percentage ?? record.used_percent,
					)
				: undefined,
		)
		.filter((value): value is number => value !== undefined);
	const weeklyPercentUsed =
		weeklyCandidates.length > 0 ? Math.max(...weeklyCandidates) : undefined;

	return sessionPercentUsed !== undefined || weeklyPercentUsed !== undefined
		? { sessionPercentUsed, weeklyPercentUsed }
		: undefined;
}

async function fetchOpenAiCodexUsage(
	token: string,
): Promise<ProviderUsageScope | undefined> {
	const accountId = extractOpenAiAccountId(token);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"User-Agent": "pi-statusline",
	};
	if (accountId) headers["chatgpt-account-id"] = accountId;

	const body = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
		headers,
	});
	if (!isRecord(body)) return undefined;

	const rateLimit = nestedRecord(body, "rate_limit");
	const primary = rateLimit
		? nestedRecord(rateLimit, "primary_window")
		: undefined;
	const secondary = rateLimit
		? nestedRecord(rateLimit, "secondary_window")
		: undefined;
	const credits = nestedRecord(body, "credits");
	const sessionPercentUsed = primary
		? parseUtilization(
				primary.used_percent ?? primary.used_percentage ?? primary.utilization,
			)
		: undefined;
	const weeklyPercentUsed = secondary
		? parseUtilization(
				secondary.used_percent ??
					secondary.used_percentage ??
					secondary.utilization,
			)
		: undefined;
	const balanceUsd =
		credits?.has_credits === true
			? numericField(
					credits.balance ?? credits.remaining ?? credits.remaining_credits,
				)
			: undefined;

	return sessionPercentUsed !== undefined ||
		weeklyPercentUsed !== undefined ||
		balanceUsd !== undefined
		? { sessionPercentUsed, weeklyPercentUsed, balanceUsd }
		: undefined;
}

function quotaSnapshotPercentUsed(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const used = numericField(
		value.percent_used ?? value.used_percent ?? value.usedPercentage,
	);
	if (used !== undefined) return used;

	const remaining = numericField(
		value.percent_remaining ??
			value.remaining_percent ??
			value.remainingPercentage,
	);
	return remaining !== undefined ? 100 - remaining : undefined;
}

async function fetchGitHubCopilotUsage(
	token: string,
): Promise<ProviderUsageScope | undefined> {
	const body = await fetchJson("https://api.github.com/copilot_internal/user", {
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/json",
			"Editor-Version": "vscode/1.96.2",
			"Editor-Plugin-Version": "copilot-chat/0.26.7",
			"User-Agent": "GitHubCopilotChat/0.26.7",
			"X-GitHub-Api-Version": "2025-04-01",
		},
	});
	if (!isRecord(body)) return undefined;

	const snapshots =
		nestedRecord(body, "quotaSnapshots") ??
		nestedRecord(body, "quota_snapshots");
	const premium = snapshots
		? (nestedRecord(snapshots, "premiumInteractions") ??
			nestedRecord(snapshots, "premium_interactions"))
		: undefined;
	const percentUsed = quotaSnapshotPercentUsed(premium);

	return percentUsed !== undefined
		? { monthlyPercentUsed: percentUsed }
		: undefined;
}

function parseGoogleOAuthToken(
	value: string,
): { token: string; projectId: string } | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) return undefined;
		const token = parsed.token ?? parsed.access;
		const projectId = parsed.projectId ?? parsed.project;
		return typeof token === "string" &&
			token &&
			typeof projectId === "string" &&
			projectId
			? { token, projectId }
			: undefined;
	} catch {
		return undefined;
	}
}

async function fetchGoogleCloudQuota(credential: {
	token: string;
	projectId: string;
}): Promise<ProviderUsageScope | undefined> {
	const body = await fetchJson(
		"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${credential.token}`,
				"Content-Type": "application/json",
				"User-Agent": "pi-statusline",
			},
			body: JSON.stringify({ project: credential.projectId }),
		},
	);
	if (!isRecord(body) || !Array.isArray(body.buckets)) return undefined;

	const usedPercents = body.buckets
		.map((bucket) => {
			if (!isRecord(bucket)) return undefined;
			const remainingFraction = numericField(bucket.remainingFraction);
			if (remainingFraction !== undefined) {
				return clampPercent((1 - remainingFraction) * 100);
			}
			const percentUsed = numericField(
				bucket.usedPercent ?? bucket.used_percentage ?? bucket.utilization,
			);
			return percentUsed !== undefined
				? parseUtilization(percentUsed)
				: undefined;
		})
		.filter((value): value is number => value !== undefined);

	return usedPercents.length > 0
		? { percentUsed: Math.max(...usedPercents) }
		: undefined;
}

async function fetchProviderUsage(
	ctx: ProviderUsageContext,
	target: ProviderUsageTarget,
): Promise<ProviderUsageStatus> {
	const statusBase = {
		providerId: target.providerId,
		authKind: target.authKind,
		fetchedAt: Date.now(),
	};

	if (target.authKind === "oauth") {
		let scope: ProviderUsageScope | undefined;
		if (target.providerId === "github-copilot") {
			const githubToken = await getGitHubCopilotUserToken(ctx);
			scope = githubToken
				? await fetchGitHubCopilotUsage(githubToken)
				: undefined;
		} else {
			const token = await getOAuthProviderToken(ctx, target.providerId);
			if (!token) return { ...statusBase, state: "unknown" };

			if (target.providerId === "anthropic") {
				scope = await fetchAnthropicOAuthUsage(token);
			} else if (target.providerId === "openai-codex") {
				scope = await fetchOpenAiCodexUsage(token);
			} else if (
				target.providerId === "google-gemini-cli" ||
				target.providerId === "google-antigravity"
			) {
				const googleCredential = parseGoogleOAuthToken(token);
				scope = googleCredential
					? await fetchGoogleCloudQuota(googleCredential)
					: undefined;
			} else {
				return { ...statusBase, state: "unsupported" };
			}
		}

		return scope
			? { ...statusBase, state: "ready", scope }
			: { ...statusBase, state: "unknown" };
	}

	if (target.providerId === "openrouter" && target.authKind === "api_key") {
		const token = await getProviderToken(ctx, target.providerId);
		if (!token) return { ...statusBase, state: "unknown" };

		const scope =
			(await fetchOpenRouterKeyStatus(token)) ??
			(await fetchOpenRouterCredits(token));
		return scope
			? { ...statusBase, state: "ready", scope }
			: { ...statusBase, state: "unknown" };
	}

	return { ...statusBase, state: "unsupported" };
}

export function invalidateProviderUsageCache(): void {
	providerUsageInvalidation++;
	providerUsageCache.clear();
	availableModelsCache = new WeakMap<
		ModelRegistryLike,
		AvailableModelsCacheEntry
	>();
}

export function refreshProviderUsage(
	ctx: ProviderUsageContext,
	targets: ProviderUsageTarget[],
	onUpdate: () => void,
): void {
	getConfiguredModels(ctx, onUpdate);
	const now = Date.now();
	const fetchId = providerUsageInvalidation;
	for (const target of targets) {
		const key = providerCacheKey(target.providerId, target.authKind);
		const entry = providerUsageCache.get(key);
		if (entry?.pending) continue;
		if (
			entry?.lastAttemptAt &&
			now - entry.lastAttemptAt < PROVIDER_USAGE_TTL_MS
		) {
			continue;
		}

		const pending = fetchProviderUsage(ctx, target)
			.then((status) => {
				if (fetchId !== providerUsageInvalidation) return;
				providerUsageCache.set(key, {
					...status,
					lastAttemptAt: now,
				});
			})
			.catch(() => {
				if (fetchId !== providerUsageInvalidation) return;
				providerUsageCache.set(key, {
					providerId: target.providerId,
					authKind: target.authKind,
					state: "error",
					fetchedAt: Date.now(),
					lastAttemptAt: now,
				});
			})
			.finally(() => {
				if (fetchId === providerUsageInvalidation) onUpdate();
			});

		providerUsageCache.set(key, {
			providerId: target.providerId,
			authKind: target.authKind,
			state: entry?.state ?? "unknown",
			scope: entry?.scope,
			fetchedAt: entry?.fetchedAt,
			lastAttemptAt: now,
			pending,
		});
	}
}

function providerShortLabel(providerId: string): string {
	switch (providerFamily(providerId)) {
		case "anthropic":
			return "Anth";
		case "openai":
			return "OAI";
		case "openrouter":
			return "OR";
		case "github-copilot":
			return "GH";
		case "google-gemini-cli":
			return "Gem";
		case "google-antigravity":
			return "AG";
		default:
			return providerId.slice(0, 6);
	}
}

function formatPercentValue(percent: number): string {
	return Math.round(percent).toString();
}

function formatPercent(percent: number): string {
	return `${formatPercentValue(percent)}%`;
}

function formatMoney(value: number): string {
	return `$${value.toFixed(2)}`;
}

function formatProviderScope(
	scope: ProviderUsageScope | undefined,
): string | undefined {
	if (!scope) return undefined;
	const periodPercents = [scope.sessionPercentUsed, scope.weeklyPercentUsed]
		.filter((percent): percent is number => percent !== undefined)
		.map(formatPercent);
	const usageParts = [...periodPercents];
	if (scope.monthlyPercentUsed !== undefined) {
		usageParts.push(`${formatPercent(scope.monthlyPercentUsed)} mo`);
	}
	if (scope.percentUsed !== undefined) {
		usageParts.push(formatPercent(scope.percentUsed));
	}
	if (usageParts.length > 0) return usageParts.join("/");
	if (scope.balanceUsd !== undefined) return formatMoney(scope.balanceUsd);
	if (scope.creditsUsd !== undefined) return formatMoney(scope.creditsUsd);
	return undefined;
}

function renderProviderBadge(
	target: ProviderUsageTarget,
	theme: ThemeLike,
): string | undefined {
	const status = providerUsageCache.get(
		providerCacheKey(target.providerId, target.authKind),
	);
	const scopeText =
		status?.state === "ready" ? formatProviderScope(status.scope) : undefined;
	if (!scopeText && !target.active) return undefined;

	const usageText = scopeText ?? "?";
	const label = providerShortLabel(target.providerId);
	return theme.fg("dim", `${label} ${usageText}`);
}

export function renderProviderUsage(
	targets: ProviderUsageTarget[],
	theme: ThemeLike,
	activeOnly: boolean,
): string | undefined {
	const badges = targets
		.filter((target) => !activeOnly || target.active)
		.map((target) => renderProviderBadge(target, theme))
		.filter((badge): badge is string => Boolean(badge));

	return badges.length > 0 ? badges.join(PROVIDER_BADGE_SEPARATOR) : undefined;
}
