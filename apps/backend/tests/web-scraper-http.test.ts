import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/web-scraper/url-policy', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/services/web-scraper/url-policy')>();
	return {
		...actual,
		assertPublicHttpUrl: vi.fn(async (value: string) => new URL(value)),
	};
});

import { webRobotRecipeSchema } from '@nao/shared/web-robot';

import { AuthoringRequestPolicy, isAuthoringRateLimitError } from '../src/services/web-robot-authoring/request-policy';
import { loadHttpSource, WebRobotLoadError, WebRobotRequestPolicyError } from '../src/services/web-scraper/http-loader';

const recipe = webRobotRecipeSchema.parse({
	version: 1,
	allowedHosts: ['example.com', 'cdn.example.com'],
	respectRobotsTxt: false,
	stages: [
		{
			id: 'products',
			source: { type: 'http', url: 'https://example.com/products' },
			output: 'product',
		},
	],
});

describe('web robot HTTP loader', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('does not forward sensitive headers across redirect origins', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: 'https://cdn.example.com/products' },
				}),
			)
			.mockResolvedValueOnce(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const loaded = await loadHttpSource(
			{
				type: 'http',
				url: 'https://example.com/products',
				method: 'GET',
				headers: {
					authorization: { env: 'WEB_ROBOT_TOKEN' },
					'x-requested-with': 'nao',
				},
			},
			{ recipe, scope: {}, env: { WEB_ROBOT_TOKEN: 'secret' } },
		);

		expect(loaded.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'secret' });
		expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ 'x-requested-with': 'nao' });
	});

	it('retries a 429 honouring the Retry-After header and records attempts', async () => {
		const recipeWithRetry = webRobotRecipeSchema.parse({
			...recipe,
			request: { ...recipe.request, retries: 1 },
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }))
			.mockResolvedValueOnce(
				new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
			);
		vi.stubGlobal('fetch', fetchMock);

		const loaded = await loadHttpSource(
			{ type: 'http', url: 'https://example.com/products', method: 'GET' },
			{ recipe: recipeWithRetry, scope: {}, env: {} },
		);

		expect(loaded.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(loaded.requestAttempts).toHaveLength(2);
		expect(loaded.requestAttempts?.[0]).toMatchObject({ attempt: 0, status: 429, retryAfterMs: 0 });
		expect(loaded.requestAttempts?.[1]).toMatchObject({ attempt: 1, status: 200 });
		expect(loaded.requests).toBe(2);
		expect(loaded.renderedTargetFingerprint).toBeTruthy();
		expect(loaded.responseFingerprint).toBeTruthy();
		expect(loaded.redactedTarget).toBe('GET https://example.com/products');
	});

	it('throws a WebRobotLoadError with sanitized attempts when retries are exhausted', async () => {
		const recipeWithRetry = webRobotRecipeSchema.parse({
			...recipe,
			request: { ...recipe.request, retries: 1 },
		});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oops', { status: 500 })));

		const error = await loadHttpSource(
			{ type: 'http', url: 'https://example.com/products', method: 'GET' },
			{ recipe: recipeWithRetry, scope: {}, env: {} },
		).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(WebRobotLoadError);
		expect((error as WebRobotLoadError).requestAttempts).toHaveLength(2);
		expect((error as WebRobotLoadError).requestAttempts[0]?.status).toBe(500);
	});

	it('does not retry a non-retryable status', async () => {
		const recipeWithRetry = webRobotRecipeSchema.parse({
			...recipe,
			request: { ...recipe.request, retries: 2 },
		});
		const fetchMock = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
		vi.stubGlobal('fetch', fetchMock);

		const loaded = await loadHttpSource(
			{ type: 'http', url: 'https://example.com/products', method: 'GET' },
			{ recipe: recipeWithRetry, scope: {}, env: {} },
		);

		expect(loaded.status).toBe(404);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(loaded.requestAttempts).toHaveLength(1);
	});

	it('retries a request timeout when the external signal is not aborted', async () => {
		const recipeWithRetry = webRobotRecipeSchema.parse({
			...recipe,
			request: { ...recipe.request, retries: 1 },
		});
		const timeoutError = new Error('timed out');
		timeoutError.name = 'TimeoutError';
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(timeoutError)
			.mockResolvedValueOnce(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const loaded = await loadHttpSource(
			{ type: 'http', url: 'https://example.com/products', method: 'GET' },
			{ recipe: recipeWithRetry, scope: {}, env: {} },
		);

		expect(loaded.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(loaded.requestAttempts).toHaveLength(2);
	});

	it('does not retry when the external signal is aborted', async () => {
		const recipeWithRetry = webRobotRecipeSchema.parse({
			...recipe,
			request: { ...recipe.request, retries: 3 },
		});
		const abortError = new Error('aborted');
		abortError.name = 'AbortError';
		const fetchMock = vi.fn().mockRejectedValue(abortError);
		vi.stubGlobal('fetch', fetchMock);

		const error = await loadHttpSource(
			{ type: 'http', url: 'https://example.com/products', method: 'GET' },
			{ recipe: recipeWithRetry, scope: {}, env: {}, signal: AbortSignal.abort() },
		).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(WebRobotLoadError);
		expect((error as WebRobotLoadError).requestAttempts).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('web robot request policy', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('invokes the request policy around every fetch', async () => {
		const order: string[] = [];
		const requestPolicy = {
			beforeRequest: vi.fn(async () => {
				order.push('before');
			}),
			observeResponse: vi.fn(() => {
				order.push('observe');
			}),
		};
		const fetchMock = vi.fn().mockImplementation(async () => {
			order.push('fetch');
			return new Response('ok', { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		await loadHttpSource(
			{ type: 'http', url: 'https://example.com/products', method: 'GET' },
			{ recipe, scope: {}, env: {}, requestPolicy },
		);

		expect(order).toEqual(['before', 'fetch', 'observe']);
		expect(requestPolicy.beforeRequest).toHaveBeenCalledWith('https://example.com/products');
		expect(requestPolicy.observeResponse).toHaveBeenCalledWith(
			'https://example.com/products',
			expect.objectContaining({ status: 200 }),
		);
	});

	it('treats a request-policy rejection as non-retryable', async () => {
		const recipeWithRetry = webRobotRecipeSchema.parse({
			...recipe,
			request: { ...recipe.request, retries: 2 },
		});
		const requestPolicy = {
			beforeRequest: vi.fn(async () => {
				throw new WebRobotRequestPolicyError('Origin is cooling down after rate limiting', true);
			}),
			observeResponse: vi.fn(),
		};
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const error = await loadHttpSource(
			{ type: 'http', url: 'https://example.com/products', method: 'GET' },
			{ recipe: recipeWithRetry, scope: {}, env: {}, requestPolicy },
		).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(WebRobotLoadError);
		expect((error as WebRobotLoadError).requestAttempts).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('stops immediately on a 429 when a request policy is attached', async () => {
		const recipeWithRetry = webRobotRecipeSchema.parse({
			...recipe,
			request: { ...recipe.request, retries: 3 },
		});
		const requestPolicy = {
			beforeRequest: vi.fn(async () => undefined),
			observeResponse: vi.fn(),
		};
		const fetchMock = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }));
		vi.stubGlobal('fetch', fetchMock);

		const error = await loadHttpSource(
			{ type: 'http', url: 'https://example.com/products', method: 'GET' },
			{ recipe: recipeWithRetry, scope: {}, env: {}, requestPolicy },
		).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(WebRobotLoadError);
		expect((error as WebRobotLoadError).requestAttempts).toHaveLength(1);
		expect((error as WebRobotLoadError).requestAttempts[0]?.status).toBe(429);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(requestPolicy.observeResponse).toHaveBeenCalledWith(
			'https://example.com/products',
			expect.objectContaining({ status: 429 }),
		);
	});

	it('waits on the adaptive 429 fallback when Retry-After is absent', async () => {
		vi.useFakeTimers();
		try {
			const recipeWithRetry = webRobotRecipeSchema.parse({
				...recipe,
				request: { ...recipe.request, retries: 1 },
			});
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(new Response('slow down', { status: 429 }))
				.mockResolvedValueOnce(new Response('ok', { status: 200 }));
			vi.stubGlobal('fetch', fetchMock);

			const pending = loadHttpSource(
				{ type: 'http', url: 'https://example.com/products', method: 'GET' },
				{ recipe: recipeWithRetry, scope: {}, env: {} },
			);
			await vi.advanceTimersByTimeAsync(4_999);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const loaded = await pending;
			expect(loaded.status).toBe(200);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('authoring request policy', () => {
	it('marks an origin rate limited after a 429 and rejects further requests', async () => {
		const policy = new AuthoringRequestPolicy({ minIntervalMs: 0 });
		const url = 'https://limited.example.com/products';

		await policy.beforeRequest(url);
		policy.observeResponse(url, new Response('slow down', { status: 429 }));

		expect(policy.rateLimited).toBe(true);
		expect(policy.rateLimitedOrigins.has('https://limited.example.com')).toBe(true);
		await expect(policy.beforeRequest(url)).rejects.toBeInstanceOf(WebRobotRequestPolicyError);
	});

	it('rejects a new analysis while the origin is cooling down', async () => {
		const first = new AuthoringRequestPolicy({ minIntervalMs: 0 });
		const url = 'https://cooling.example.com/products';
		await first.beforeRequest(url);
		first.observeResponse(url, new Response('slow down', { status: 429 }));

		const second = new AuthoringRequestPolicy({ minIntervalMs: 0 });
		const error = await second.beforeRequest(url).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WebRobotRequestPolicyError);
		expect(isAuthoringRateLimitError(error)).toBe(true);
	});

	it('enforces the per-origin request budget', async () => {
		const policy = new AuthoringRequestPolicy({ minIntervalMs: 0, maxRequestsPerOrigin: 2 });
		const url = 'https://budget.example.com/products';

		await policy.beforeRequest(url);
		await policy.beforeRequest(url);
		await expect(policy.beforeRequest(url)).rejects.toBeInstanceOf(WebRobotRequestPolicyError);
		await expect(policy.beforeRequest('https://other.example.com/products')).resolves.toBeUndefined();
	});

	it('caches successful loads under canonical requested and final URLs', () => {
		const policy = new AuthoringRequestPolicy({ minIntervalMs: 0 });
		const loaded = {
			url: 'https://cache.example.com/products',
			finalUrl: 'https://cache.example.com/products/',
			status: 200,
			captures: [],
			requests: 1,
		};
		policy.remember('https://cache.example.com/products#frag', loaded);

		expect(policy.responseCache.get('https://cache.example.com/products')).toBe(loaded);
		expect(policy.responseCache.get('https://cache.example.com/products/')).toBe(loaded);
		policy.remember('https://cache.example.com/missing', { ...loaded, status: 404 });
		expect(policy.responseCache.has('https://cache.example.com/missing')).toBe(false);
	});
});
