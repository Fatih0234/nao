import { type WebRobotRecipe, webRobotRecipeSchema } from '@nao/shared/web-robot';
import type { CatalogueGranularity, CountSignal } from '@nao/shared/web-robot-trust';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCatalogueVerificationPlan } from '../src/services/web-robot-authoring/verification-plan';
import { WebRobotBrowserSession } from '../src/services/web-scraper/browser-loader';
import { runWebRobotVerification } from '../src/services/web-scraper/traversal';
import {
	browserStateStable,
	virtualizationObserved,
	virtualRangeGap,
} from '../src/services/web-scraper/traversal-browser';
import type {
	WebRobotBrowserControlState,
	WebRobotBrowserScrollState,
	WebRobotBrowserTraversalSnapshot,
	WebRobotInteractiveBrowser,
} from '../src/services/web-scraper/types';

vi.mock('node:dns/promises', () => ({
	default: {
		lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
	},
}));

const BASE = 'https://example.com/products';

const scrollState = (partial: Partial<WebRobotBrowserScrollState> = {}): WebRobotBrowserScrollState => ({
	scrollTop: 0,
	scrollExtent: 1_000,
	viewportExtent: 500,
	atEffectiveBottom: false,
	loadingIndicatorPresent: false,
	relevantNetworkIdle: true,
	...partial,
});

const bottomState = (partial: Partial<WebRobotBrowserScrollState> = {}): WebRobotBrowserScrollState =>
	scrollState({ scrollTop: 500, atEffectiveBottom: true, ...partial });

const snapshot = (
	html: string,
	scroll: Partial<WebRobotBrowserScrollState> = {},
	loaded: Record<string, unknown> = {},
): WebRobotBrowserTraversalSnapshot => ({
	loaded: {
		url: BASE,
		finalUrl: BASE,
		status: 200,
		contentType: 'text/html',
		bodyText: html,
		captures: [],
		requests: 0,
		...loaded,
	},
	scroll: scrollState(scroll),
});

const enabled: WebRobotBrowserControlState = { present: true, enabled: true, selector: 'button.more' };
const absent: WebRobotBrowserControlState = { present: false, enabled: false };

type FakeHandle = {
	handle: WebRobotInteractiveBrowser;
	calls: { clicks: number; scrolls: number; closes: number };
};

const fakeHandle = (input: {
	snapshots: WebRobotBrowserTraversalSnapshot[];
	controls?: WebRobotBrowserControlState[];
}): FakeHandle => {
	const snapshots = [...input.snapshots];
	const controls = [...(input.controls ?? [])];
	const calls = { clicks: 0, scrolls: 0, closes: 0 };
	const next = <T>(queue: T[], fallback: T): T => (queue.length > 1 ? queue.shift()! : (queue[0] ?? fallback));
	const handle: WebRobotInteractiveBrowser = {
		snapshot: vi.fn(async () => next(snapshots, snapshots.at(-1)!)),
		inspectControl: vi.fn(async () => next(controls, controls.at(-1) ?? absent)),
		click: vi.fn(async () => {
			calls.clicks += 1;
			return next(controls, controls.at(-1) ?? absent);
		}),
		scrollIncrement: vi.fn(async () => {
			calls.scrolls += 1;
		}),
		settle: vi.fn(async () => undefined),
		close: vi.fn(async () => {
			calls.closes += 1;
		}),
	};
	return { handle, calls };
};

const cards = (...skus: string[]): string =>
	`<html><body>${skus
		.map((sku) => `<div class="card"><span class="sku">${sku}</span></div>`)
		.join('')}</body></html>`;

const browserRecipe = (
	paginate: Record<string, unknown>,
	extra: Record<string, unknown> = {},
	requiredSku = true,
): WebRobotRecipe =>
	webRobotRecipeSchema.parse({
		version: 2,
		allowedHosts: ['example.com'],
		identity: { strategy: 'first_present', fields: ['sku'] },
		request: { delayMs: 0, retries: 0 },
		stages: [
			{
				id: 'products',
				source: { type: 'browser', url: BASE },
				paginate,
				extract: {
					type: 'dom',
					itemSelector: '.card',
					fields: { sku: { selector: '.sku', required: requiredSku } },
				},
				output: 'product',
			},
		],
		...extra,
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

const verify = (
	recipe: WebRobotRecipe,
	countSignals: CountSignal[] = [],
	signalInput?: AbortSignal,
	entityGranularity?: CatalogueGranularity,
) =>
	runWebRobotVerification({
		recipe,
		verificationPlan: createCatalogueVerificationPlan(
			recipe,
			'scope-current',
			countSignals.map((entry) => entry.id),
		),
		countSignals,
		signal: signalInput,
		entityGranularity,
	});

describe('web robot interactive browser traversal', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not found', { status: 404 })),
		);
	});

	it('completes cumulative load-more clicks until the control disappears', async () => {
		const { handle, calls } = fakeHandle({
			snapshots: [snapshot(cards('A')), snapshot(cards('A', 'B')), snapshot(cards('A', 'B', 'C'))],
			controls: [enabled, enabled, enabled, enabled, absent],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'click', selector: 'button.more', maxPages: 10 }));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.traversals[0]?.selectedAttemptId).toBeDefined();
		expect(result.traversals[0]?.attempts[0]?.summary.newUniqueIdentities).toBe(3);
		expect(result.traversals[0]?.attempts[0]?.summary.duplicateAppearances).toBe(3);
		expect(result.products).toHaveLength(3);
		expect(calls.clicks).toBe(2);
		expect(calls.closes).toBe(1);
	});

	it('stalls an inert enabled load-more control after three stable observations', async () => {
		const { handle, calls } = fakeHandle({
			snapshots: [snapshot(cards('A'))],
			controls: [enabled],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'click', selector: 'button.more', maxPages: 20 }));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('stalled');
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
		expect(result.anomalies.some((anomaly) => anomaly.code === 'traversal_stalled')).toBe(true);
		expect(calls.clicks).toBe(1);
	});

	it('reports count_conflict when a total-reaching load-more probe reveals extra records', async () => {
		const { handle, calls } = fakeHandle({
			snapshots: [snapshot(cards('A', 'B')), snapshot(cards('A', 'B', 'C'))],
			controls: [enabled],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'click', selector: 'button.more', maxPages: 10 }), [
			signal({ value: 2 }),
		]);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'count_conflict')).toBe(true);
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
		expect(calls.clicks).toBe(1);
	});

	it('resets observation windows when late load-more records arrive', async () => {
		const { handle, calls } = fakeHandle({
			snapshots: [
				snapshot(cards('A')),
				snapshot(cards('A')),
				snapshot(cards('A')),
				snapshot(cards('A', 'B')),
				snapshot(cards('A', 'B', 'C')),
			],
			controls: [enabled, enabled, enabled, enabled, enabled, absent],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'click', selector: 'button.more', maxPages: 10 }));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.traversals[0]?.attempts[0]?.summary.newUniqueIdentities).toBe(3);
		expect(calls.clicks).toBe(2);
	});

	it('completes infinite scroll after three stable bottom observations', async () => {
		const html = cards('A', 'B');
		const { handle, calls } = fakeHandle({
			snapshots: [
				snapshot(cards('A')),
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true }),
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true }),
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true }),
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true }),
			],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'scroll', maxPages: 10, waitMs: 0 }));

		const attempt = result.traversals[0]?.attempts[0];
		expect(attempt?.status).toBe('complete');
		expect(attempt?.summary.terminalEvidence?.kind).toBe('stable_no_progress');
		expect(attempt?.summary.terminalEvidence?.details).toMatchObject({ confirmations: 3 });
		expect(calls.scrolls).toBe(1);
	});

	it('reconciles an exact infinite-scroll total after a confirmed bottom observation', async () => {
		const html = cards('A', 'B');
		const { handle } = fakeHandle({
			snapshots: [
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true }),
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true }),
			],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'scroll', maxPages: 10, waitMs: 0 }), [signal({ value: 2 })]);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('count_reconciled');
	});

	it('fails with count_conflict when infinite scroll stabilizes below the expected total', async () => {
		const html = cards('A');
		const { handle } = fakeHandle({
			snapshots: [
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true }),
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true }),
			],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'scroll', maxPages: 10, waitMs: 0 }), [signal({ value: 3 })]);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'count_conflict')).toBe(true);
	});

	it('reconciles a virtualized list against aria setsize with contiguous ranges', async () => {
		const { handle } = fakeHandle({
			snapshots: [
				snapshot(cards('A', 'B'), { scrollTop: 0, rangeStart: 1, rangeEnd: 2, setSize: 4 }),
				snapshot(cards('C', 'D'), { scrollTop: 250, rangeStart: 3, rangeEnd: 4, setSize: 4 }),
				snapshot(cards('C', 'D'), {
					scrollTop: 500,
					atEffectiveBottom: true,
					rangeStart: 3,
					rangeEnd: 4,
					setSize: 4,
				}),
			],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(
			browserRecipe({ type: 'scroll', maxPages: 10, waitMs: 0 }),
			[],
			undefined,
			'variant',
		);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('complete');
		expect(result.traversals[0]?.attempts[0]?.summary.terminalEvidence?.kind).toBe('count_reconciled');
		expect(result.traversals[0]?.attempts[0]?.summary.newUniqueIdentities).toBe(4);
		expect(result.countSignals.find((signal) => signal.id === 'runtime-traversal-products-setsize')).toMatchObject({
			value: 4,
			source: 'pagination',
			unit: 'variant',
			reliability: 'strong',
			comparable: true,
			path: 'aria-setsize',
		});
	});

	it('blocks a virtualized aria range gap', async () => {
		const { handle } = fakeHandle({
			snapshots: [
				snapshot(cards('A', 'B'), { rangeStart: 1, rangeEnd: 2, setSize: 8 }),
				snapshot(cards('E', 'F'), { scrollTop: 250, rangeStart: 5, rangeEnd: 6, setSize: 8 }),
			],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'scroll', maxPages: 10, waitMs: 0 }));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'virtualized_range_gap')).toBe(true);
	});

	it('blocks virtualized record-hash-only identities', async () => {
		const anonymous = (labels: string[]) =>
			`<html><body>${labels.map((label) => `<div class="card"><span class="sku"></span>${label}</div>`).join('')}</body></html>`;
		const { handle } = fakeHandle({
			snapshots: [
				snapshot(anonymous(['one', 'two']), { rangeStart: 1, rangeEnd: 2, setSize: 4 }),
				snapshot(anonymous(['three', 'four']), { scrollTop: 250, rangeStart: 3, rangeEnd: 4, setSize: 4 }),
			],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const noFieldRecipe = webRobotRecipeSchema.parse({
			version: 2,
			allowedHosts: ['example.com'],
			identity: { strategy: 'first_present', fields: ['sku'] },
			request: { delayMs: 0, retries: 0 },
			stages: [
				{
					id: 'products',
					source: { type: 'browser', url: BASE },
					paginate: { type: 'scroll', maxPages: 10, waitMs: 0 },
					extract: { type: 'dom', itemSelector: '.card', fields: {} },
					output: 'product',
				},
			],
		});

		const result = await verify(noFieldRecipe);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'unreliable_virtualized_identity')).toBe(true);
	});

	it('never completes while a loading indicator stays present', async () => {
		const busy = snapshot(cards('A'), { scrollTop: 500, atEffectiveBottom: true, loadingIndicatorPresent: true });
		const { handle } = fakeHandle({ snapshots: [busy] });
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'scroll', maxPages: 4, waitMs: 0 }));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('limit_reached');
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
		expect(result.anomalies.some((anomaly) => anomaly.code === 'limit_reached')).toBe(true);
	});

	it('hits the safety page limit instead of completing', async () => {
		const { handle } = fakeHandle({
			snapshots: [
				snapshot(cards('A')),
				snapshot(cards('A', 'B'), { scrollTop: 250 }),
				snapshot(cards('A', 'B', 'C'), { scrollTop: 500 }),
			],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'scroll', maxPages: 2, waitMs: 0 }));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('limit_reached');
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
	});

	it('never treats a post-interaction blocker shell as terminal', async () => {
		const loginShell = snapshot('<html><body>sign in</body></html>', {}, { finalUrl: 'https://example.com/login' });
		const { handle } = fakeHandle({
			snapshots: [snapshot(cards('A')), loginShell],
			controls: [enabled],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'click', selector: 'button.more', maxPages: 10 }, {}, false));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'source_blocked')).toBe(true);
	});

	it('fails count_conflict when aria setsize exceeds the stable identity count', async () => {
		const html = cards('A', 'B');
		const { handle } = fakeHandle({
			snapshots: [
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true, setSize: 4 }),
				snapshot(html, { scrollTop: 500, atEffectiveBottom: true, setSize: 4 }),
			],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'scroll', maxPages: 10, waitMs: 0 }));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'count_conflict')).toBe(true);
		expect(result.anomalies.some((anomaly) => anomaly.code === 'stable_no_progress')).toBe(false);
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
	});

	it('fails source_changed_during_run when aria setsize changes mid-traversal', async () => {
		const { handle } = fakeHandle({
			snapshots: [
				snapshot(cards('A', 'B'), { setSize: 4 }),
				snapshot(cards('A', 'B', 'C'), { scrollTop: 250, setSize: 8 }),
			],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'scroll', maxPages: 10, waitMs: 0 }));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('failed');
		expect(result.anomalies.some((anomaly) => anomaly.code === 'source_changed_during_run')).toBe(true);
	});

	it('limits traversal when the captured response cap was reached', async () => {
		const { handle } = fakeHandle({
			snapshots: [snapshot(cards('A'), {}, { captureLimitReached: true })],
			controls: [absent],
		});
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(browserRecipe({ type: 'click', selector: 'button.more', maxPages: 10 }));

		expect(result.traversals[0]?.attempts[0]?.status).toBe('limit_reached');
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
		expect(result.anomalies.some((anomaly) => anomaly.code === 'limit_reached')).toBe(true);
	});

	it('cancels cleanly, closes the handle, and selects no attempt', async () => {
		const { handle, calls } = fakeHandle({ snapshots: [snapshot(cards('A'))], controls: [absent] });
		vi.spyOn(WebRobotBrowserSession.prototype, 'openInteractive').mockResolvedValue(handle);

		const result = await verify(
			browserRecipe({ type: 'click', selector: 'button.more', maxPages: 10 }),
			[],
			AbortSignal.abort(),
		);

		expect(result.traversals[0]?.attempts[0]?.status).toBe('cancelled');
		expect(result.traversals[0]?.selectedAttemptId).toBeUndefined();
		expect(calls.closes).toBe(1);
	});
});

describe('browser traversal pure helpers', () => {
	it('detects stable browser state only when idle and unchanged', () => {
		const before = bottomState({ rangeStart: 1, rangeEnd: 2 });
		expect(browserStateStable(before, bottomState({ rangeStart: 1, rangeEnd: 2 }))).toBe(true);
		expect(browserStateStable(before, bottomState({ scrollExtent: 1_500 }))).toBe(false);
		expect(browserStateStable(before, bottomState({ loadingIndicatorPresent: true }))).toBe(false);
		expect(browserStateStable(before, bottomState({ relevantNetworkIdle: false }))).toBe(false);
	});

	it('tolerates sub-pixel scroll deltas but not larger moves', () => {
		const before = bottomState();
		expect(browserStateStable(before, bottomState({ scrollTop: 501, scrollExtent: 1_001 }))).toBe(true);
		expect(browserStateStable(before, bottomState({ scrollTop: 502 }))).toBe(false);
		expect(browserStateStable(before, bottomState({ scrollExtent: 1_002 }))).toBe(false);
	});

	it('flags virtualized range gaps and allows contiguous ranges', () => {
		const before = scrollState({ rangeStart: 1, rangeEnd: 2 });
		expect(virtualRangeGap(before, scrollState({ rangeStart: 3, rangeEnd: 4 }))).toBe(false);
		expect(virtualRangeGap(before, scrollState({ rangeStart: 5, rangeEnd: 6 }))).toBe(true);
		expect(virtualRangeGap(before, scrollState({}))).toBe(false);
	});

	it('detects virtualization from rotated windows or aria ranges', () => {
		const before = new Set(['a', 'b']);
		expect(
			virtualizationObserved(before, new Set(['c', 'd']), scrollState(), scrollState({ scrollTop: 250 })),
		).toBe(true);
		expect(virtualizationObserved(before, new Set(['a', 'b']), scrollState(), scrollState())).toBe(false);
		expect(virtualizationObserved(before, before, scrollState(), scrollState({ rangeStart: 3 }))).toBe(true);
	});
});
