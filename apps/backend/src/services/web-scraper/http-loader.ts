import type { WebRobotRecipe, WebRobotSource } from '@nao/shared/web-robot';

import { delay, headersForOrigin, readResponseWithLimit, renderHttpRequest } from './request';
import type { TemplateScope } from './template';
import { renderedRequestEvidence, responseFingerprint, sanitizeTraversalError } from './traversal-evidence';
import type { WebRobotLoadedSource, WebRobotRequestAttempt, WebRobotRequestPolicy } from './types';
import { assertPublicHttpUrl, WebRobotUrlError } from './url-policy';

type HttpLikeSource = Extract<WebRobotSource, { type: 'http' | 'api' }>;

const MAX_RETRY_AFTER_MS = 30_000;

class RetryableHttpError extends Error {
	status?: number;
	retryAfterMs?: number;
}

export class WebRobotRequestPolicyError extends Error {
	readonly rateLimited: boolean;

	constructor(message: string, rateLimited = false) {
		super(message);
		this.name = 'WebRobotRequestPolicyError';
		this.rateLimited = rateLimited;
	}
}

export class WebRobotLoadError extends Error {
	readonly requestAttempts: WebRobotRequestAttempt[];
	readonly targetFingerprint?: string;
	readonly redactedTarget?: string;

	constructor(
		message: string,
		requestAttempts: WebRobotRequestAttempt[],
		target?: { fingerprint: string; redactedTarget: string },
	) {
		super(message);
		this.name = 'WebRobotLoadError';
		this.requestAttempts = requestAttempts;
		this.targetFingerprint = target?.fingerprint;
		this.redactedTarget = target?.redactedTarget;
	}
}

export type HttpLoaderOptions = {
	recipe: WebRobotRecipe;
	scope: TemplateScope;
	env: Record<string, string>;
	signal?: AbortSignal;
	requestPolicy?: WebRobotRequestPolicy;
};

export const loadHttpSource = async (
	source: HttpLikeSource,
	options: HttpLoaderOptions,
): Promise<WebRobotLoadedSource> => {
	const rendered = renderHttpRequest(source, options.scope, options.env);
	const target = renderedRequestEvidence(rendered);
	const request = {
		method: rendered.method,
		headers: {
			...(options.recipe.request.userAgent ? { 'user-agent': options.recipe.request.userAgent } : {}),
			...rendered.headers,
		},
		body: rendered.body,
	};

	return fetchWithPolicy(rendered.url, request, options, target);
};

const fetchWithPolicy = async (
	initialUrl: URL,
	request: { method: string; headers: Record<string, string>; body?: BodyInit },
	options: HttpLoaderOptions,
	target: { fingerprint: string; redactedTarget: string },
): Promise<WebRobotLoadedSource> => {
	const url = initialUrl;
	let requestCount = 0;
	let lastError: unknown;
	const requestAttempts: WebRobotRequestAttempt[] = [];

	for (let attempt = 0; attempt <= options.recipe.request.retries; attempt += 1) {
		const startedAt = new Date().toISOString();
		try {
			const result = await fetchFollowingRedirects(url, request, options, () => {
				requestCount += 1;
			});
			requestAttempts.push({
				attempt,
				startedAt,
				completedAt: new Date().toISOString(),
				status: result.status,
			});
			return {
				...result,
				requests: requestCount,
				renderedTargetFingerprint: target.fingerprint,
				redactedTarget: target.redactedTarget,
				responseFingerprint: responseFingerprint(result),
				requestAttempts,
			};
		} catch (error) {
			lastError = error;
			const retryable = error instanceof RetryableHttpError ? error : undefined;
			requestAttempts.push({
				attempt,
				startedAt,
				completedAt: new Date().toISOString(),
				status: retryable?.status,
				error: sanitizeTraversalError(error),
				retryAfterMs: retryable?.retryAfterMs,
			});
			if (retryable?.status === 429 && options.requestPolicy) {
				break;
			}
			if (!isRetryable(error, options.signal) || attempt === options.recipe.request.retries) {
				break;
			}
			const fallbackMs =
				retryable?.status === 429
					? Math.min(30_000, 5_000 * 2 ** attempt)
					: Math.min(2_000, 250 * 2 ** attempt);
			await delay(retryable?.retryAfterMs ?? fallbackMs, options.signal);
		}
	}

	throw new WebRobotLoadError(sanitizeTraversalError(lastError), requestAttempts, target);
};

const fetchFollowingRedirects = async (
	initialUrl: URL,
	request: { method: string; headers: Record<string, string>; body?: BodyInit },
	options: HttpLoaderOptions,
	onRequest: () => void,
): Promise<WebRobotLoadedSource> => {
	let url = initialUrl;
	let method = request.method;
	let body = request.body;

	const initialOrigin = initialUrl.origin;
	for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
		await assertPublicHttpUrl(url.toString(), options.recipe.allowedHosts);
		await options.requestPolicy?.beforeRequest(url.toString());
		onRequest();

		const response = await fetch(url, {
			method,
			headers: headersForOrigin(request.headers, url.origin, initialOrigin),
			body,
			redirect: 'manual',
			signal: requestSignal(options),
		});
		options.requestPolicy?.observeResponse(url.toString(), response);

		if (!isRedirect(response.status)) {
			if (response.status === 408 || response.status === 429 || response.status >= 500) {
				await response.body?.cancel().catch(() => undefined);
				const error = new RetryableHttpError(`HTTP ${response.status} while fetching request target`);
				error.status = response.status;
				error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'));
				throw error;
			}
			return toLoadedSource(response, url, options.recipe.limits.maxResponseBytes);
		}

		const location = response.headers.get('location');
		if (!location) {
			return toLoadedSource(response, url, options.recipe.limits.maxResponseBytes);
		}

		url = await assertPublicHttpUrl(location, options.recipe.allowedHosts, { baseUrl: url.toString() });
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
			method = 'GET';
			body = undefined;
		}
	}

	throw new Error(`Too many redirects while fetching ${initialUrl.toString()}`);
};

export const retryAfterMs = (header: string | null): number | undefined => {
	if (!header) {
		return undefined;
	}
	const seconds = Number(header);
	if (Number.isFinite(seconds)) {
		return Math.min(Math.max(seconds * 1_000, 0), MAX_RETRY_AFTER_MS);
	}
	const date = Date.parse(header);
	if (!Number.isNaN(date)) {
		return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
	}
	return undefined;
};

const toLoadedSource = async (
	response: Response,
	url: URL,
	maxResponseBytes: number,
): Promise<WebRobotLoadedSource> => {
	const bodyText = await readResponseWithLimit(response, maxResponseBytes);
	const contentType = response.headers.get('content-type') ?? undefined;
	const bodyJson = parseJsonBody(bodyText, contentType);

	return {
		url: url.toString(),
		finalUrl: response.url || url.toString(),
		status: response.status,
		contentType,
		bodyText,
		bodyJson,
		captures: [],
		requests: 0,
	};
};

const parseJsonBody = (bodyText: string, contentType?: string): unknown => {
	if (!contentType?.includes('json') && !looksLikeJson(bodyText)) {
		return undefined;
	}
	try {
		return JSON.parse(bodyText);
	} catch {
		return undefined;
	}
};

const looksLikeJson = (body: string): boolean => {
	const trimmed = body.trim();
	return trimmed.startsWith('{') || trimmed.startsWith('[');
};

const requestSignal = (options: HttpLoaderOptions): AbortSignal => {
	const timeout = AbortSignal.timeout(options.recipe.request.timeoutMs);
	return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
};

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);

const isRetryable = (error: unknown, signal?: AbortSignal): boolean => {
	if (signal?.aborted) {
		return false;
	}
	if (error instanceof WebRobotRequestPolicyError) {
		return false;
	}
	if (error instanceof RetryableHttpError) {
		return true;
	}
	if (error instanceof WebRobotUrlError) {
		return false;
	}
	if (error instanceof Error && error.message.includes('byte limit')) {
		return false;
	}
	return true;
};
