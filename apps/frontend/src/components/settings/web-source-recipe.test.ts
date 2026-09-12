import { describe, expect, it } from 'vitest';

import {
	catalogueGranularityLabel,
	catalogueQualityPresentation,
	catalogueTrustBasisLabel,
	catalogueTrustPresentation,
	DEFAULT_WEB_SOURCE_RECIPE_TEXT,
	parseBrowserActions,
	parseBrowserCaptures,
	parseWebSourceRecipe,
	recipeSummary,
	schedulePresetForCron,
	slugifyWebSourceName,
	webRobotRunBadgeVariant,
	webSourcePrimaryActionLabel,
} from './web-source-recipe';

import type { CatalogueCurrentState, CatalogueTrustSummary } from '@nao/shared/web-robot-trust';

describe('web source recipe helpers', () => {
	it('parses the default recipe', () => {
		const result = parseWebSourceRecipe(DEFAULT_WEB_SOURCE_RECIPE_TEXT);
		expect(result.errors).toEqual([]);
		expect(result.recipe?.stages).toHaveLength(1);
		expect(result.recipe?.stages[0]?.output).toBe('product');
		expect(recipeSummary(result.recipe)?.sourceTypes).toEqual(['api']);
	});

	it('reports JSON and schema errors separately', () => {
		expect(parseWebSourceRecipe('{').errors[0]).toMatch(/^JSON:/);

		const invalid = parseWebSourceRecipe('{"version":1,"allowedHosts":[],"stages":[]}');
		expect(invalid.recipe).toBeUndefined();
		expect(invalid.errors.some((error) => error.includes('allowedHosts'))).toBe(true);
	});

	it('parses browser actions and captures', () => {
		expect(parseBrowserActions('[{"type":"delay","ms":250}]').actions).toEqual([{ type: 'delay', ms: 250 }]);
		expect(parseBrowserCaptures('[{"name":"api","urlPattern":"/products","body":"json"}]').captures).toEqual([
			{ name: 'api', urlPattern: '/products', body: 'json' },
		]);
		expect(parseBrowserActions('[{"type":"unknown"}]').errors).toHaveLength(1);
	});

	it('maps common cron presets and slugs', () => {
		expect(schedulePresetForCron('')).toBe('manual');
		expect(schedulePresetForCron('0 2 * * *')).toBe('daily');
		expect(schedulePresetForCron('0 2 * * 1')).toBe('weekly');
		expect(schedulePresetForCron('*/15 * * * *')).toBe('custom');
		expect(slugifyWebSourceName(' Deublin Products! ')).toBe('deublin-products');
	});

	it('maps run states to badge variants', () => {
		expect(webRobotRunBadgeVariant('completed')).toBe('success');
		expect(webRobotRunBadgeVariant('partial')).toBe('context_admin');
		expect(webRobotRunBadgeVariant('failed')).toBe('destructive');
		expect(webRobotRunBadgeVariant('running')).toBe('secondary');
	});
});

describe('catalogue trust presentation', () => {
	const activeSummary: CatalogueTrustSummary = {
		policyVersion: 1,
		status: 'ready',
		basis: 'count_reconciled',
		scopeLabel: 'Products',
		entityCount: 30,
		granularity: 'variant',
		verifiedAt: '2025-01-01T00:00:00.000Z',
		dimensions: {
			scope: { status: 'passed', reasons: [] },
			records: { status: 'passed', reasons: [] },
			identity: { status: 'passed', reasons: [] },
			semantics: { status: 'passed', reasons: [] },
			freshness: { status: 'passed', reasons: [] },
		},
		limitations: [],
		requiredCoverage: [],
		blockerCodes: [],
	};
	const baseState: CatalogueCurrentState = { setupStatus: 'configured', latestRefreshFailed: false };

	it('presents setup required when the source is not configured and has no active data', () => {
		const presentation = catalogueTrustPresentation({
			setupStatus: 'needs_input',
			latestRefreshFailed: false,
		});
		expect(presentation.label).toBe('Setup required');
		expect(presentation.variant).toBe('outline');
		expect(presentation.detail).toBe('Complete source setup before loading data.');
	});

	it('presents ready refreshing while a refresh runs on active data', () => {
		for (const executionStatus of ['queued', 'running'] as const) {
			const presentation = catalogueTrustPresentation({
				...baseState,
				activeSummary,
				activeRunId: 'run-1',
				executionStatus,
			});
			expect(presentation.label).toBe('Ready · Refreshing');
			expect(presentation.variant).toBe('secondary');
			expect(presentation.detail).toBe('Agents continue using the active dataset while the new data is checked.');
		}
	});

	it('presents ready checking update while a pending configuration refreshes', () => {
		const presentation = catalogueTrustPresentation(
			{ ...baseState, activeSummary, activeRunId: 'run-1', executionStatus: 'running' },
			{ hasPendingConfiguration: true },
		);
		expect(presentation.label).toBe('Ready · Checking update');
		expect(presentation.variant).toBe('secondary');
	});

	it('presents retained previous data when the latest refresh failed', () => {
		const presentation = catalogueTrustPresentation({
			...baseState,
			activeSummary,
			activeRunId: 'run-1',
			latestRefreshFailed: true,
		});
		expect(presentation.label).toBe('Ready · Previous data kept');
		expect(presentation.variant).toBe('context_admin');
		expect(presentation.detail).toBe(
			'The latest refresh did not pass its quality checks. Agents continue using the active dataset.',
		);
	});

	it('presents ready active data with its verification basis', () => {
		const presentation = catalogueTrustPresentation({
			...baseState,
			activeSummary,
			activeRunId: 'run-1',
		});
		expect(presentation.label).toBe('Ready');
		expect(presentation.variant).toBe('success');
		expect(presentation.detail).toBe('Quality checks passed using source count reconciliation.');
	});

	it('presents first refresh running while queued, running, or publication pending', () => {
		for (const extra of [
			{ executionStatus: 'queued' as const },
			{ executionStatus: 'running' as const },
			{ publicationStatus: 'pending' as const },
		]) {
			const presentation = catalogueTrustPresentation({ ...baseState, ...extra });
			expect(presentation.label).toBe('First refresh running');
			expect(presentation.variant).toBe('secondary');
			expect(presentation.detail).toBe(
				'No data is available to agents until the first refresh passes its quality checks.',
			);
		}
	});

	it('presents activation failed when publication fails after passing checks', () => {
		const presentation = catalogueTrustPresentation({
			...baseState,
			executionStatus: 'succeeded',
			publicationStatus: 'publication_failed',
		});
		expect(presentation.label).toBe('Activation failed');
		expect(presentation.variant).toBe('destructive');
		expect(presentation.detail).toBe('The data passed its checks but could not be made available to agents.');
	});

	it('presents needs attention when the first refresh did not pass checks', () => {
		expect(catalogueTrustPresentation({ ...baseState, publicationStatus: 'blocked_initial' }).label).toBe(
			'Needs attention',
		);
		expect(catalogueTrustPresentation({ ...baseState, trustStatus: 'needs_attention' }).label).toBe(
			'Needs attention',
		);
		const presentation = catalogueTrustPresentation({ ...baseState, publicationStatus: 'blocked_initial' });
		expect(presentation.variant).toBe('destructive');
		expect(presentation.detail).toBe(
			'The first refresh did not pass its quality checks, so no dataset is available to agents.',
		);
	});

	it('presents first refresh failed when the initial refresh fails', () => {
		const presentation = catalogueTrustPresentation({
			...baseState,
			executionStatus: 'failed',
			publicationStatus: 'blocked_initial',
		});
		expect(presentation.label).toBe('First refresh failed');
		expect(presentation.variant).toBe('destructive');
		expect(presentation.detail).toBe('The first refresh could not complete, so no dataset is available to agents.');
	});

	it('falls back to not refreshed', () => {
		const presentation = catalogueTrustPresentation(baseState);
		expect(presentation.label).toBe('Not refreshed');
		expect(presentation.variant).toBe('outline');
		expect(presentation.detail).toBe('Start the first refresh before agents can use this source.');
	});

	it('prioritizes retained data over the verifying state', () => {
		const presentation = catalogueTrustPresentation({
			...baseState,
			activeSummary,
			latestRefreshFailed: true,
			executionStatus: 'succeeded',
		});
		expect(presentation.label).toBe('Ready · Previous data kept');
	});

	it('labels basis and granularity', () => {
		expect(catalogueTrustBasisLabel('count_reconciled')).toBe('source count reconciliation');
		expect(catalogueTrustBasisLabel('traversal_complete')).toBe('complete traversal');
		expect(catalogueTrustBasisLabel('none')).toBe('not established');
		expect(catalogueTrustBasisLabel(undefined)).toBe('not established');
		expect(catalogueGranularityLabel('source_record')).toBe('source record');
		expect(catalogueGranularityLabel('variant')).toBe('variant');
	});
});

describe('web source primary action label', () => {
	const summary: CatalogueTrustSummary = {
		policyVersion: 1,
		status: 'ready',
		basis: 'count_reconciled',
		scopeLabel: 'Products',
		entityCount: 30,
		granularity: 'variant',
		verifiedAt: '2025-01-01T00:00:00.000Z',
		dimensions: {
			scope: { status: 'passed', reasons: [] },
			records: { status: 'passed', reasons: [] },
			identity: { status: 'passed', reasons: [] },
			semantics: { status: 'passed', reasons: [] },
			freshness: { status: 'passed', reasons: [] },
		},
		limitations: [],
		requiredCoverage: [],
		blockerCodes: [],
	};
	const configured: CatalogueCurrentState = { setupStatus: 'configured', latestRefreshFailed: false };
	const active: CatalogueCurrentState = { ...configured, activeSummary: summary, activeRunId: 'run-1' };

	it.each([
		[{ setupStatus: 'needs_input', latestRefreshFailed: false } satisfies CatalogueCurrentState, {}, null],
		[configured, {}, 'Start first refresh'],
		[
			{ ...configured, executionStatus: 'succeeded', publicationStatus: 'blocked_initial' },
			{},
			'Retry first refresh',
		],
		[active, {}, 'Refresh now'],
		[{ ...active, latestRefreshFailed: true }, {}, 'Retry refresh'],
		[active, { hasPendingConfiguration: true }, 'Retry configuration update'],
		[{ ...configured, executionStatus: 'running' }, {}, 'First refresh running…'],
		[{ ...active, executionStatus: 'running' }, {}, 'Refreshing…'],
		[
			{ ...active, executionStatus: 'running' },
			{ hasPendingConfiguration: true },
			'Checking configuration update…',
		],
		[configured, { isActionPending: true }, 'First refresh running…'],
	] as const)('returns %j -> %s', (state, options, expected) => {
		expect(webSourcePrimaryActionLabel({ state, ...options })).toBe(expected);
	});
});

describe('catalogue quality presentation', () => {
	const readySummary: CatalogueTrustSummary = {
		policyVersion: 1,
		status: 'ready',
		basis: 'count_reconciled',
		scopeLabel: 'Products',
		entityCount: 30,
		granularity: 'variant',
		verifiedAt: '2025-01-01T00:00:00.000Z',
		dimensions: {
			scope: { status: 'passed', reasons: [] },
			records: { status: 'passed', reasons: [] },
			identity: { status: 'passed', reasons: [] },
			semantics: { status: 'passed', reasons: [] },
			freshness: { status: 'passed', reasons: [] },
		},
		limitations: [],
		requiredCoverage: [],
		blockerCodes: [],
	};
	const failedSummary: CatalogueTrustSummary = { ...readySummary, status: 'needs_attention', basis: 'none' };
	const configured: CatalogueCurrentState = { setupStatus: 'configured', latestRefreshFailed: false };

	it.each([
		[{ ...configured, executionStatus: 'running' as const }, 'Checks running', 'secondary'],
		[
			{ ...configured, executionStatus: 'succeeded' as const, latestSummary: failedSummary },
			'Checks need attention',
			'destructive',
		],
		[
			{
				...configured,
				executionStatus: 'succeeded' as const,
				activeSummary: readySummary,
				activeRunId: 'run-1',
				latestSummary: failedSummary,
				latestRefreshFailed: true,
			},
			'Checks need attention',
			'context_admin',
		],
		[
			{
				...configured,
				executionStatus: 'succeeded' as const,
				activeSummary: readySummary,
				activeRunId: 'run-1',
				latestSummary: readySummary,
			},
			'Checks passed',
			'success',
		],
		[
			{ ...configured, executionStatus: 'succeeded' as const, activeSummary: readySummary, activeRunId: 'run-1' },
			'Checks passed',
			'success',
		],
		[{ ...configured, executionStatus: 'failed' as const }, 'Checks not completed', 'destructive'],
		[configured, 'Checks not run', 'outline'],
	] as const)('presents %j', (state, label, variant) => {
		const presentation = catalogueQualityPresentation(state);
		expect(presentation.label).toBe(label);
		expect(presentation.variant).toBe(variant);
	});

	it('names the active dataset basis when checks passed', () => {
		const presentation = catalogueQualityPresentation({
			...configured,
			executionStatus: 'succeeded',
			activeSummary: readySummary,
			activeRunId: 'run-1',
		});
		expect(presentation.detail).toBe('The active dataset passed using source count reconciliation.');
	});
});
