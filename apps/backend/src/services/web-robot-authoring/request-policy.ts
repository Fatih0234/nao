import { retryAfterMs, WebRobotLoadError, WebRobotRequestPolicyError } from '../web-scraper/http-loader';
import { delay } from '../web-scraper/request';
import type { WebRobotLoadedSource, WebRobotRequestPolicy } from '../web-scraper/types';
import { canonicalHttpUrl } from '../web-scraper/url-policy';

const DEFAULT_MIN_INTERVAL_MS = 750;
const DEFAULT_MAX_REQUESTS_PER_ORIGIN = 20;
const DEFAULT_COOLDOWN_MS = 30_000;

const originCooldowns = new Map<string, number>();

export type AuthoringRequestPolicyOptions = {
	minIntervalMs?: number;
	maxRequestsPerOrigin?: number;
	cooldownMs?: number;
};

export class AuthoringRequestPolicy implements WebRobotRequestPolicy {
	readonly responseCache = new Map<string, WebRobotLoadedSource>();
	readonly rateLimitedOrigins = new Set<string>();

	private readonly minIntervalMs: number;
	private readonly maxRequestsPerOrigin: number;
	private readonly cooldownMs: number;
	private readonly requestCounts = new Map<string, number>();
	private readonly nextRequestAt = new Map<string, number>();

	constructor(options: AuthoringRequestPolicyOptions = {}) {
		this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
		this.maxRequestsPerOrigin = options.maxRequestsPerOrigin ?? DEFAULT_MAX_REQUESTS_PER_ORIGIN;
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	}

	get rateLimited(): boolean {
		return this.rateLimitedOrigins.size > 0;
	}

	async beforeRequest(url: string): Promise<void> {
		const origin = requestOrigin(url);
		const now = Date.now();
		const cooldownUntil = originCooldowns.get(origin);
		if (cooldownUntil !== undefined) {
			if (cooldownUntil > now) {
				throw new WebRobotRequestPolicyError(`Origin ${origin} is cooling down after rate limiting`, true);
			}
			originCooldowns.delete(origin);
		}
		if (this.rateLimitedOrigins.has(origin)) {
			throw new WebRobotRequestPolicyError(`Origin ${origin} already rate limited this analysis`, true);
		}
		const count = this.requestCounts.get(origin) ?? 0;
		if (count >= this.maxRequestsPerOrigin) {
			throw new WebRobotRequestPolicyError(`Origin ${origin} exceeded the authoring request budget`);
		}
		const nextAt = this.nextRequestAt.get(origin) ?? 0;
		if (nextAt > now) {
			await delay(nextAt - now);
		}
		this.requestCounts.set(origin, count + 1);
		this.nextRequestAt.set(origin, Date.now() + this.minIntervalMs);
	}

	observeResponse(url: string, response: Response): void {
		if (response.status !== 429) {
			return;
		}
		const origin = requestOrigin(url);
		this.rateLimitedOrigins.add(origin);
		const retryAfter = retryAfterMs(response.headers.get('retry-after'));
		originCooldowns.set(origin, Date.now() + Math.max(retryAfter ?? this.cooldownMs, this.cooldownMs));
	}

	remember(requestedUrl: string, loaded: WebRobotLoadedSource): void {
		if (loaded.status < 200 || loaded.status >= 300) {
			return;
		}
		try {
			this.responseCache.set(canonicalHttpUrl(requestedUrl), loaded);
			if (loaded.finalUrl) {
				this.responseCache.set(canonicalHttpUrl(loaded.finalUrl), loaded);
			}
		} catch {
			return;
		}
	}
}

export const isAuthoringRateLimitError = (error: unknown): boolean => {
	if (error instanceof WebRobotRequestPolicyError) {
		return error.rateLimited;
	}
	if (error instanceof WebRobotLoadError) {
		return error.requestAttempts.some((attempt) => attempt.status === 429);
	}
	return false;
};

const requestOrigin = (url: string): string => {
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
};
