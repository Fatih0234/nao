import { type WebRobotRecipe, webRobotRecipeSchema } from '@nao/shared/web-robot';
import type { CatalogueGranularity, CountSignal } from '@nao/shared/web-robot-trust';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCatalogueVerificationPlan } from '../src/services/web-robot-authoring/verification-plan';
import { WebRobotBrowserSession } from '../src/services/web-scraper/browser-loader';
import { runWebRobotVerification } from '../src/services/web-scraper/traversal';

vi.mock('node:dns/promises', () => ({
	default: {
		lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
	},
}));

const jsonResponse = (body: unknown): Response =>
	new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const htmlResponse = (body: string): Response =>
	new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

const planFor = (recipe: WebRobotRecipe, countSignalIds: string[] = []) =>
	createCatalogueVerificationPlan(recipe, 'scope-current', countSignalIds);

const verify = (recipe: WebRobotRecipe, countSignals: CountSignal[] = [], entityGranularity?: CatalogueGranularity) =>
	runWebRobotVerification({
		recipe,
		verificationPlan: planFor(
			recipe,
			countSignals.map((entry) => entry.id),
		),
		countSignals,
		entityGranularity,
	});

const signal = (partial: Partial<CountSignal> & { value: number }): CountSignal => ({
	id: `signal-${partial.value}`,
	unit: 'variant',
	source: 'displayed',
	scopeId: 'scope-current',
	reliability: 'strong',
	observedAt: new Date().toISOString(),
	comparable: true,
	...partial,
});

describe('web robot verification traversal', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	it('completes page pagination at the declared last page', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const page = Number(new URL(url).searchParams.get('page'));
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 2 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		const report = result.traversals[0]!;
		expect(report.selectedAttemptId).toBe('traversal-products-attempt-1');
		expect(report.attempts[0]?.status).toBe('complete');
		expect(report.attempts[0]?.summary.terminalEvidence?.kind).toBe('declared_last_page');
		expect(report.attempts[0]?.summary.newUniqueIdentities).toBe(2);
		expect(result.products.map((product) => product.sku)).toEqual(['SKU-1', 'SKU-2']);
		expect(result.traversalSteps).toHaveLength(2);
		expect(result.traversalSteps.every((step) => step.status === 'complete')).toBe(true);
	});

	it('registers the declared item total as a runtime count signal for page pagination', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const page = Number(new URL(url).searchParams.get('page'));
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 2, totalNumberOfResults: 2 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: {
						type: 'page',
						pageVariable: 'page',
						firstPage: 1,
						totalPagesPath: 'numberOfPages',
						totalItemsPath: 'totalNumberOfResults',
					},
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe, [], 'variant');

		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		const runtimeTotal = result.countSignals.find((entry) => entry.id === 'runtime-traversal-products-total');
		expect(runtimeTotal).toMatchObject({
			value: 2,
			source: 'api',
			unit: 'variant',
			reliability: 'strong',
			comparable: true,
			path: 'totalNumberOfResults',
		});
		expect(runtimeTotal?.scopeId).toBe('scope-current');
	});

	it('fails when the declared item total changes during page traversal', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const page = Number(new URL(String(input)).searchParams.get('page'));
			return jsonResponse({
				result: [{ mpn: `SKU-${page}` }],
				numberOfPages: 2,
				totalNumberOfResults: page === 1 ? 2 : 9,
			});
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: {
						type: 'page',
						pageVariable: 'page',
						firstPage: 1,
						totalPagesPath: 'numberOfPages',
						totalItemsPath: 'totalNumberOfResults',
					},
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'source_changed_during_run')).toBe(true);
	});

	it('fails when the declared item total path is absent from a page response', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const page = Number(new URL(String(input)).searchParams.get('page'));
			return jsonResponse({
				result: [{ mpn: `SKU-${page}` }],
				numberOfPages: 2,
				...(page === 1 ? { totalNumberOfResults: 2 } : {}),
			});
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: {
						type: 'page',
						pageVariable: 'page',
						firstPage: 1,
						totalPagesPath: 'numberOfPages',
						totalItemsPath: 'totalNumberOfResults',
					},
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'count_conflict')).toBe(true);
	});

	it('produces no runtime count signal when page pagination declares no item total', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const page = Number(new URL(url).searchParams.get('page'));
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 2 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.countSignals.some((entry) => entry.id === 'runtime-traversal-products-total')).toBe(false);
	});

	it('refuses a repeated rendered request target before loading', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async () => jsonResponse({ result: [{ mpn: 'SKU-1' }] }));
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog' },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, maxPages: 5 },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
		expect(result.anomalies.some((anomaly) => anomaly.code === 'traversal_loop')).toBe(true);
	});

	it('fails when a page returns empty before the declared final page', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const page = Number(new URL(String(input)).searchParams.get('page'));
			return jsonResponse({ result: page === 2 ? [] : [{ mpn: `SKU-${page}` }], numberOfPages: 3 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'missing_intermediate_page')).toBe(true);
	});

	it('completes offset pagination at the declared total and conflicts on a short page', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const offset = Number(new URL(String(input)).searchParams.get('offset'));
			return jsonResponse({ total: 3, items: [{ mpn: `SKU-${offset}` }] });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items', query: { offset: '{{offset}}' } },
					paginate: { type: 'offset', pageSize: 1, totalPath: 'total', maxPages: 10 },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const success = await verify(recipe, [], 'variant');
		expect(success.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(success.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('offset_reached_total');
		expect(success.products).toHaveLength(3);
		const runtimeTotal = success.countSignals.find((signal) => signal.id === 'runtime-traversal-products-total');
		expect(runtimeTotal).toMatchObject({
			value: 3,
			source: 'api',
			unit: 'variant',
			reliability: 'strong',
			comparable: true,
			path: 'total',
		});
		expect(runtimeTotal?.scopeId).toBe('scope-current');

		vi.mocked(fetch).mockImplementation(async (input) => {
			const offset = Number(new URL(String(input)).searchParams.get('offset'));
			return jsonResponse({ total: 10, items: offset === 1 ? [] : [{ mpn: `SKU-${offset}` }] });
		});
		const conflict = await verify(recipe);
		expect(conflict.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(conflict.anomalies.some((anomaly) => anomaly.code === 'count_conflict')).toBe(true);
	});

	it('completes cursor pagination on exhaustion and detects repeated cursors', async () => {
		vi.mocked(fetch).mockImplementation(async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? '{}')) as { cursor?: string };
			const cursor = body.cursor ?? '';
			const next = cursor === 'cursor-2' ? '' : `cursor-${cursor === '' ? 1 : 2}`;
			return jsonResponse({ nodes: [{ mpn: `SKU-${cursor || 'first'}` }], endCursor: next });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['api.example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: {
						type: 'api',
						url: 'https://api.example.com/graphql',
						method: 'POST',
						body: { cursor: '{{cursor}}' },
					},
					paginate: { type: 'cursor', nextCursorPath: 'endCursor', maxPages: 10 },
					extract: { type: 'json', itemsPath: 'nodes', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const success = await verify(recipe);
		expect(success.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(success.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('cursor_exhausted');
		expect(JSON.stringify(success.traversalSteps)).not.toContain('cursor-1');

		vi.mocked(fetch).mockImplementation(async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? '{}')) as { cursor?: string };
			const cursor = body.cursor ?? '';
			return jsonResponse({ nodes: [{ mpn: `SKU-${cursor || 'first'}-new` }], endCursor: 'cursor-1' });
		});
		const loop = await verify(recipe);
		expect(loop.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(loop.anomalies.some((anomaly) => anomaly.code === 'traversal_loop')).toBe(true);
		expect(JSON.stringify(loop.anomalies)).not.toContain('cursor-1');
	});

	it('stalls after two consecutive cursor pages with no new identities', async () => {
		vi.mocked(fetch).mockImplementation(async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? '{}')) as { cursor?: string };
			const cursor = body.cursor ?? '';
			const next = cursor === '' ? 'c-1' : cursor === 'c-1' ? 'c-2' : 'c-3';
			return jsonResponse({ nodes: [{ mpn: 'SAME-SKU' }], endCursor: next });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['api.example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: {
						type: 'api',
						url: 'https://api.example.com/graphql',
						method: 'POST',
						body: { cursor: '{{cursor}}' },
					},
					paginate: { type: 'cursor', nextCursorPath: 'endCursor', maxPages: 10 },
					extract: { type: 'json', itemsPath: 'nodes', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('stalled');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'traversal_stalled')).toBe(true);
	});

	it('fails when the declared total changes during the run', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const page = Number(new URL(String(input)).searchParams.get('page'));
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: page === 1 ? 2 : 5 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'source_changed_during_run')).toBe(true);
	});

	it('follows HTML next links and terminates when the control is absent', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			return htmlResponse(
				url.includes('page=2')
					? '<main><div class="card"><a href="/p/b">B</a></div></main>'
					: '<main><div class="card"><a href="/p/a">A</a></div><a class="next" href="/products?page=2">Next</a></main>',
			);
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['url'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'http', url: 'https://example.com/products' },
					paginate: { type: 'nextLink', selector: 'a.next', attr: 'href', maxPages: 10 },
					extract: {
						type: 'dom',
						itemSelector: '.card',
						fields: { url: { selector: 'a', attr: 'href', required: true, transforms: ['absoluteUrl'] } },
					},
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('next_control_absent');
		expect(result.products).toHaveLength(2);
	});

	it('blocks next links that drop active filters or leave the scope host', async () => {
		const recipeFor = () =>
			webRobotRecipeSchema.parse({
				version: 2,
				allowedHosts: ['example.com', 'other.example.com'],
				identity: { strategy: 'first_present', fields: ['url'] },
				request: { delayMs: 0, retries: 0 },
				stages: [
					{
						id: 'products',
						source: { type: 'http', url: 'https://example.com/products?category=pumps' },
						paginate: { type: 'nextLink', selector: 'a.next', attr: 'href', maxPages: 10 },
						extract: {
							type: 'dom',
							itemSelector: '.card',
							fields: {
								url: { selector: 'a', attr: 'href', required: true, transforms: ['absoluteUrl'] },
							},
						},
						output: 'product',
					},
				],
			});

		vi.mocked(fetch).mockImplementation(async () =>
			htmlResponse(
				'<main><div class="card"><a href="/p/a">A</a></div><a class="next" href="/products?page=2">Next</a></main>',
			),
		);
		const filtered = await verify(recipeFor());
		expect(filtered.anomalies.some((anomaly) => anomaly.code === 'filter_lost')).toBe(true);
		expect(filtered.traversals[0]?.attempts[0]?.status).toBe('failed');

		vi.mocked(fetch).mockImplementation(async () =>
			htmlResponse(
				'<main><div class="card"><a href="/p/a">A</a></div><a class="next" href="https://other.example.com/products?category=pumps&page=2">Next</a></main>',
			),
		);
		const offsite = await verify(recipeFor());
		expect(offsite.anomalies.some((anomaly) => anomaly.code === 'out_of_scope_redirect')).toBe(true);
	});

	it('reconciles a finite listing against a matching count signal', async () => {
		vi.mocked(fetch).mockImplementation(async () => jsonResponse({ items: [{ mpn: 'A' }, { mpn: 'B' }] }));
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items' },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const reconciled = await verify(recipe, [signal({ value: 2 })]);
		expect(reconciled.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('count_reconciled');

		const unreconciled = await verify(recipe);
		expect(unreconciled.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(unreconciled.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('next_control_absent');
		expect(unreconciled.anomalies.some((anomaly) => anomaly.code === 'no_independent_count')).toBe(true);
	});

	it('fails a finite listing when a selected strong count signal mismatches', async () => {
		vi.mocked(fetch).mockImplementation(async () => jsonResponse({ items: [{ mpn: 'A' }, { mpn: 'B' }] }));
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items' },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe, [signal({ value: 9, reliability: 'strong' })]);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
		expect(result.anomalies.some((anomaly) => anomaly.code === 'count_conflict')).toBe(true);
	});

	it('ignores count signals not selected by the verification plan', async () => {
		vi.mocked(fetch).mockImplementation(async () => jsonResponse({ items: [{ mpn: 'A' }, { mpn: 'B' }] }));
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items' },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await runWebRobotVerification({
			recipe,
			verificationPlan: planFor(recipe),
			countSignals: [signal({ value: 99 })],
		});
		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'no_independent_count')).toBe(true);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'count_conflict')).toBe(false);
	});

	it('never completes on an HTTP 200 blocker shell', async () => {
		vi.mocked(fetch).mockImplementation(async () =>
			htmlResponse('<title>Attention Required</title><main>Please complete the CAPTCHA to continue.</main>'),
		);
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['url'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'http', url: 'https://example.com/products' },
					extract: { type: 'dom', itemSelector: '.card', fields: { url: { selector: 'a', attr: 'href' } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
		expect(result.anomalies.some((anomaly) => anomaly.code === 'source_blocked')).toBe(true);
	});

	it('reports limit_reached when the recipe page limit is hit with pending targets', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const page = Number(new URL(String(input)).searchParams.get('page'));
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 50 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: {
						type: 'page',
						pageVariable: 'page',
						firstPage: 1,
						totalPagesPath: 'numberOfPages',
						maxPages: 2,
					},
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('limit_reached');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'limit_reached')).toBe(true);
		expect(result.traversalSteps.at(-1)?.status).toBe('limit_reached');
	});

	it('preserves enumeration count when a detail target fails', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			if (url.startsWith('https://example.com/catalog')) {
				return jsonResponse({
					items: [
						{ mpn: 'A', uri: '/products/a' },
						{ mpn: 'B', uri: '/products/b' },
					],
				});
			}
			if (url.endsWith('/products/b')) {
				return new Response('missing', { status: 404 });
			}
			return htmlResponse('<main><h1>Product A</h1></main>');
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'catalogue',
					source: { type: 'api', url: 'https://example.com/catalog' },
					extract: {
						type: 'json',
						itemsPath: 'items',
						fields: {
							sku: { path: 'mpn', required: true },
							url: { path: 'uri', transforms: ['absoluteUrl'], required: true },
						},
					},
					emit: 'products',
					output: 'product',
				},
				{
					id: 'details',
					forEach: { from: 'products' },
					source: { type: 'http', url: '{{ products.url }}' },
					extract: { type: 'dom', fields: { name: { selector: 'h1', required: true } } },
					emit: 'enriched',
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.products).toHaveLength(2);
		expect(result.traversals[1]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'enrichment_incomplete')).toBe(true);
	});

	it('keeps enumeration entities when a detail overlay target fails', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			if (url.startsWith('https://example.com/catalog')) {
				return jsonResponse({
					items: [
						{ mpn: 'A', uri: '/products/a' },
						{ mpn: 'B', uri: '/products/b' },
					],
				});
			}
			if (url.endsWith('/products/b')) {
				return new Response('missing', { status: 404 });
			}
			return htmlResponse('<main><h1>Product A</h1></main>');
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'catalogue',
					source: { type: 'api', url: 'https://example.com/catalog' },
					extract: {
						type: 'json',
						itemsPath: 'items',
						fields: {
							sku: { path: 'mpn', required: true },
							url: { path: 'uri', transforms: ['absoluteUrl'], required: true },
						},
					},
					emit: 'products',
				},
				{
					id: 'details',
					forEach: { from: 'products' },
					source: { type: 'http', url: '{{ products.url }}' },
					extract: { type: 'dom', fields: { name: { selector: 'h1', required: true } } },
					emit: 'enriched',
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.products.map((product) => product.sku)).toEqual(['A', 'B']);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.traversals[1]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'enrichment_incomplete')).toBe(true);
	});

	it('reports a disabled next control even when it still carries an href', async () => {
		vi.mocked(fetch).mockImplementation(async () =>
			htmlResponse(
				'<main><div class="card"><a href="/p/a">A</a></div>' +
					'<a class="next disabled" aria-disabled="true" href="/products?page=2">Next</a></main>',
			),
		);
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['url'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'http', url: 'https://example.com/products' },
					paginate: { type: 'nextLink', selector: 'a.next', attr: 'href', maxPages: 10 },
					extract: {
						type: 'dom',
						itemSelector: '.card',
						fields: { url: { selector: 'a', attr: 'href', required: true, transforms: ['absoluteUrl'] } },
					},
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('next_control_disabled');
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
	});

	it('fails offset reconciliation when unique identities do not reach the declared total', async () => {
		vi.mocked(fetch).mockImplementation(async () => jsonResponse({ total: 2, items: [{ mpn: 'SKU-0' }] }));
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items', query: { offset: '{{offset}}' } },
					paginate: { type: 'offset', pageSize: 1, totalPath: 'total', maxPages: 10 },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'count_conflict')).toBe(true);
	});

	it('fails when an offset window returns more records than the declared total', async () => {
		vi.mocked(fetch).mockImplementation(async () =>
			jsonResponse({ total: 2, items: [{ mpn: 'A' }, { mpn: 'B' }, { mpn: 'C' }] }),
		);
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items', query: { offset: '{{offset}}' } },
					paginate: { type: 'offset', pageSize: 3, totalPath: 'total', maxPages: 10 },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'count_conflict')).toBe(true);
	});

	it('blocks nextPath targets that leave the scope host or drop filters', async () => {
		const build = () =>
			webRobotRecipeSchema.parse({
				version: 2,
				allowedHosts: ['example.com', 'other.example.com'],
				identity: { strategy: 'first_present', fields: ['sku'] },
				request: { delayMs: 0, retries: 0 },
				stages: [
					{
						id: 'products',
						source: { type: 'api', url: 'https://example.com/items?category=pumps' },
						paginate: { type: 'nextPath', path: 'next', maxPages: 10 },
						extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
						output: 'product',
					},
				],
			});

		vi.mocked(fetch).mockImplementation(async () =>
			jsonResponse({ items: [{ mpn: 'A' }], next: 'https://other.example.com/items?category=pumps&page=2' }),
		);
		const offHost = await verify(build());
		expect(offHost.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(offHost.anomalies.some((anomaly) => anomaly.code === 'out_of_scope_redirect')).toBe(true);

		vi.mocked(fetch).mockImplementation(async () => jsonResponse({ items: [{ mpn: 'A' }], next: '/items?page=2' }));
		const lostFilter = await verify(build());
		expect(lostFilter.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(lostFilter.anomalies.some((anomaly) => anomaly.code === 'filter_lost')).toBe(true);
	});

	it('never leaks raw sensitive request values into evidence on failure', async () => {
		vi.mocked(fetch).mockImplementation(async () => new Response('oops', { status: 500 }));
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items?token=SECRET123&category=pumps' },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		const serialized = JSON.stringify({
			steps: result.traversalSteps,
			anomalies: result.anomalies,
			events: result.events,
			errors: result.stats.errors,
		});
		expect(serialized).not.toContain('SECRET123');
		expect(serialized).toContain('pumps');
	});

	it('limits a single response that overflows maxItems', async () => {
		vi.mocked(fetch).mockImplementation(async () => jsonResponse({ items: [{ mpn: 'A' }, { mpn: 'B' }] }));
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			limits: { maxItems: 1 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items' },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.status).toBe('limit_reached');
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
	});

	it('counts exactly one failure for a single failed request', async () => {
		vi.mocked(fetch).mockImplementation(async () => new Response('oops', { status: 500 }));
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items' },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[0]?.attempts[0]?.summary.failures).toBe(1);
	});

	it('extracts network captures from a browser finite traversal', async () => {
		const loadSpy = vi.spyOn(WebRobotBrowserSession.prototype, 'load').mockImplementation(async () => ({
			url: 'https://example.com/products',
			finalUrl: 'https://example.com/products',
			status: 200,
			contentType: 'text/html',
			bodyText: '<main></main>',
			captures: [
				{
					name: 'products',
					url: 'https://example.com/api/products',
					status: 200,
					body: { items: [{ mpn: 'A' }] },
				},
			],
			requests: 1,
		}));
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: {
						type: 'browser',
						url: 'https://example.com/products',
						capture: [{ name: 'products', urlPattern: '/api/products' }],
					},
					extract: {
						type: 'network',
						capture: 'products',
						itemsPath: 'items',
						fields: { sku: { path: 'mpn', required: true } },
					},
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		loadSpy.mockRestore();
		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.products.map((product) => product.sku)).toEqual(['A']);
	});

	it('does not count a 200 blocker detail page as successful enrichment', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.startsWith('https://example.com/catalog')) {
				return jsonResponse({ items: [{ mpn: 'A', uri: '/products/a' }] });
			}
			return htmlResponse('<title>Attention Required</title><main>Please complete the CAPTCHA.</main>');
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'catalogue',
					source: { type: 'api', url: 'https://example.com/catalog' },
					extract: {
						type: 'json',
						itemsPath: 'items',
						fields: {
							sku: { path: 'mpn', required: true },
							url: { path: 'uri', transforms: ['absoluteUrl'], required: true },
						},
					},
					emit: 'products',
				},
				{
					id: 'details',
					forEach: { from: 'products' },
					source: { type: 'http', url: '{{ products.url }}' },
					extract: { type: 'dom', fields: { name: { selector: 'h1', required: true } } },
					emit: 'enriched',
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.products).toHaveLength(1);
		expect(result.traversals[1]?.attempts[0]?.status).toBe('failed');
		expect(result.traversals[1]?.attempts[0]?.summary.successfulTargets).toBe(0);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'enrichment_incomplete')).toBe(true);
	});

	it('fails interactive forEach enrichment explicitly', async () => {
		vi.mocked(fetch).mockImplementation(async () =>
			jsonResponse({ result: [{ mpn: 'SKU-1', url: 'https://example.com/p/1' }] }),
		);
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog' },
					extract: {
						type: 'json',
						itemsPath: 'result',
						fields: { sku: { path: 'mpn', required: true }, url: { path: 'url' } },
					},
					emit: 'products',
				},
				{
					id: 'details',
					forEach: { from: 'products' },
					source: { type: 'browser', url: '{{ products.url }}' },
					paginate: { type: 'click', selector: 'button.more', maxPages: 3 },
					extract: { type: 'dom', fields: { name: { selector: 'h1' } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[1]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'interactive_enrichment_unsupported')).toBe(true);
	});

	it('records exactly one enrichment failure and blocks a last-target overflow', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			if (url.endsWith('/catalog')) {
				return jsonResponse({
					result: [
						{ mpn: 'SKU-1', url: 'https://example.com/p/1' },
						{ mpn: 'SKU-2', url: 'https://example.com/p/2' },
					],
				});
			}
			if (url.endsWith('/p/2')) {
				return new Response('missing', { status: 404 });
			}
			return htmlResponse('<html><body><h1>Detail</h1></body></html>');
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog' },
					extract: {
						type: 'json',
						itemsPath: 'result',
						fields: { sku: { path: 'mpn', required: true }, url: { path: 'url' } },
					},
					emit: 'products',
				},
				{
					id: 'details',
					forEach: { from: 'products' },
					source: { type: 'http', url: '{{ products.url }}' },
					extract: { type: 'dom', fields: { name: { selector: 'h1' } } },
					emit: 'enriched',
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[1]?.attempts[0]?.summary.failures).toBe(1);
	});

	it('records a terminally failed page as a gap and continues to the declared last page', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const page = Number(new URL(url).searchParams.get('page'));
			if (page === 2) {
				return new Response('oops', { status: 500 });
			}
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 3 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('declared_last_page');
		expect(result.traversalSteps.map((step) => step.status)).toEqual(['complete', 'gap', 'complete']);
		expect(result.traversalSteps[1]?.target.redactedTarget).toContain('page=2');
		const gap = result.anomalies.find((anomaly) => anomaly.code === 'traversal_gap');
		expect(gap).toMatchObject({ severity: 'blocking', traversalId: 'traversal-products' });
		expect(String(gap?.details.redactedTarget)).toContain('page=2');
		expect(result.products.map((product) => product.sku)).toEqual(['SKU-1', 'SKU-3']);
	});

	it('records a failed offset window as a gap and skips by page size', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const offset = Number(new URL(url).searchParams.get('offset'));
			if (offset === 2) {
				return new Response('missing', { status: 404 });
			}
			return jsonResponse({
				items: offset === 0 ? [{ mpn: 'SKU-0' }, { mpn: 'SKU-1' }] : [{ mpn: `SKU-${offset}` }],
			});
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/items', query: { offset: '{{offset}}' } },
					paginate: { type: 'offset', pageSize: 2, maxPages: 10 },
					extract: { type: 'json', itemsPath: 'items', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('short_final_page');
		expect(result.traversalSteps.map((step) => step.status)).toEqual(['complete', 'gap', 'complete']);
		expect(result.traversalSteps[1]?.target.redactedTarget).toContain('offset=2');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'traversal_gap')).toBe(true);
		expect(result.products.map((product) => product.sku)).toEqual(['SKU-0', 'SKU-1', 'SKU-4']);
	});

	it('aborts after two consecutive enumeration gaps', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const page = Number(new URL(url).searchParams.get('page'));
			if (page === 2 || page === 3) {
				return new Response('oops', { status: 500 });
			}
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 5 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.traversalSteps.map((step) => step.status)).toEqual(['complete', 'gap', 'gap']);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'gap_tolerance_exceeded')).toBe(true);
		expect(vi.mocked(fetch).mock.calls.filter((call) => String(call[0]).includes('page=4'))).toHaveLength(0);
	});

	it('aborts after more than three total enumeration gaps', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const page = Number(new URL(url).searchParams.get('page'));
			if (page === 2 || page === 4 || page === 6 || page === 8) {
				return new Response('oops', { status: 500 });
			}
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 9 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.traversalSteps.map((step) => step.status)).toEqual([
			'complete',
			'gap',
			'complete',
			'gap',
			'complete',
			'gap',
			'complete',
			'gap',
		]);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'gap_tolerance_exceeded')).toBe(true);
	});

	it('still requires terminal evidence when the declared final page is a gap', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const page = Number(new URL(url).searchParams.get('page'));
			if (page === 3) {
				return new Response('oops', { status: 500 });
			}
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 3 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.traversalSteps.map((step) => step.status)).toEqual(['complete', 'complete', 'gap']);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'traversal_gap')).toBe(true);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'no_terminal_evidence')).toBe(true);
	});

	it('does not gap-tolerate a rate-limited page', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const page = Number(new URL(url).searchParams.get('page'));
			if (page === 2) {
				return new Response('slow down', { status: 429 });
			}
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 3 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.traversalSteps.every((step) => step.status !== 'gap')).toBe(true);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'traversal_gap')).toBe(false);
	});

	it('does not gap-tolerate a blocked page response', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const page = Number(new URL(url).searchParams.get('page'));
			if (page === 2) {
				return htmlResponse('<title>Attention Required</title><main>Please complete the CAPTCHA.</main>');
			}
			return jsonResponse({ result: [{ mpn: `SKU-${page}` }], numberOfPages: 3 });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog', query: { page: '{{page}}' } },
					paginate: { type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'numberOfPages' },
					extract: { type: 'json', itemsPath: 'result', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.traversalSteps.every((step) => step.status !== 'gap')).toBe(true);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'traversal_gap')).toBe(false);
	});

	it('still aborts cursor traversal when a target fails', async () => {
		vi.mocked(fetch).mockImplementation(async (_input, init) => {
			const url = String(_input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			const body = JSON.parse(String(init?.body ?? '{}')) as { cursor?: string };
			if (body.cursor === 'c-1') {
				return new Response('oops', { status: 500 });
			}
			return jsonResponse({ nodes: [{ mpn: 'SKU-first' }], endCursor: 'c-1' });
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['api.example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: {
						type: 'api',
						url: 'https://api.example.com/graphql',
						method: 'POST',
						body: { cursor: '{{cursor}}' },
					},
					paginate: { type: 'cursor', nextCursorPath: 'endCursor', maxPages: 10 },
					extract: { type: 'json', itemsPath: 'nodes', fields: { sku: { path: 'mpn', required: true } } },
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.traversalSteps.every((step) => step.status !== 'gap')).toBe(true);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'traversal_gap')).toBe(false);
	});

	it('stops with limit_reached when the final enrichment target overflows maxItems', async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/robots.txt')) {
				return new Response('not found', { status: 404 });
			}
			if (url.endsWith('/catalog')) {
				return jsonResponse({
					result: [
						{ mpn: 'SKU-1', url: 'https://example.com/p/1' },
						{ mpn: 'SKU-2', url: 'https://example.com/p/2' },
					],
				});
			}
			return htmlResponse('<html><body><h1>Detail</h1></body></html>');
		});
		const recipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			limits: { maxItems: 3 },
			stages: [
				{
					id: 'products',
					source: { type: 'api', url: 'https://example.com/catalog' },
					extract: {
						type: 'json',
						itemsPath: 'result',
						fields: { sku: { path: 'mpn', required: true }, url: { path: 'url' } },
					},
					emit: 'products',
				},
				{
					id: 'details',
					forEach: { from: 'products' },
					source: { type: 'http', url: '{{ products.url }}' },
					extract: { type: 'dom', fields: { name: { selector: 'h1' } } },
					emit: 'enriched',
					output: 'product',
				},
			],
		});

		const result = await verify(recipe);
		expect(result.traversals[1]?.attempts[0]?.status).toBe('limit_reached');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'limit_reached')).toBe(true);
	});
});
