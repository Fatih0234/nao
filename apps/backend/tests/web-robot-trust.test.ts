import { emptyWebRobotRunStats } from '@nao/shared/web-robot';
import {
	type CatalogueContract,
	type CatalogueScope,
	type CatalogueTrustDimensions,
	catalogueTrustReportSchema,
	type CatalogueTrustSummary,
	type CatalogueVerificationPlan,
	type CountSignal,
	type ScopeFitnessDecision,
	type TraversalAttempt,
	type TraversalDefinition,
} from '@nao/shared/web-robot-trust';
import { describe, expect, it } from 'vitest';

import { CATALOGUE_TRUST_POLICY_V1, deriveCatalogueTrustVerdict } from '../src/services/web-robot-trust/policy';
import { reconcileCatalogueTrust } from '../src/services/web-robot-trust/reconcile';
import {
	catalogueTrustManifestProjection,
	catalogueTrustReadme,
	catalogueTrustReportHash,
} from '../src/services/web-robot-trust/report';
import type { NormalizedProducts } from '../src/services/web-scraper/records';
import type { WebRobotTraversalReport, WebRobotVerificationExecutionResult } from '../src/services/web-scraper/types';

const NOW = '2026-01-01T00:00:00.000Z';

const scope = (over: Partial<CatalogueScope> = {}): CatalogueScope => ({
	version: 1,
	id: 'scope-1',
	label: 'All products',
	entryUrl: 'https://example.com/products',
	includedUrls: ['https://example.com/products'],
	activeFilters: {},
	selection: { mode: 'automatic', candidateId: 'api-1', confidence: 'high', rationale: [] },
	...over,
});

const contract = (over: Partial<CatalogueContract> = {}): CatalogueContract => ({
	version: 1,
	entityGranularity: 'variant',
	requiredConcepts: [
		{ concept: 'name', required: true, minimumCoverage: 1 },
		{ concept: 'source_url', required: true, minimumCoverage: 1 },
		{ concept: 'stable_identity', required: true, minimumCoverage: 1 },
		{ concept: 'specifications', required: true, minimumCoverage: 0.95 },
		{ concept: 'membership', required: true, minimumCoverage: 0.95 },
	],
	publishWhenReady: true,
	createdAt: NOW,
	...over,
});

const plan = (over: Partial<CatalogueVerificationPlan> = {}): CatalogueVerificationPlan => ({
	version: 1,
	scopeId: 'scope-1',
	traversals: [definition()],
	countSignalIds: [],
	...over,
});

const definition = (over: Partial<TraversalDefinition> = {}): TraversalDefinition => ({
	id: 'traversal-products',
	stageId: 'products',
	role: 'enumeration',
	required: true,
	sourceType: 'api',
	mode: 'page',
	terminalStrategies: ['declared_last_page'],
	...over,
});

const completeAttempt = (): TraversalAttempt => ({
	attemptId: 'traversal-products-attempt-1',
	status: 'complete',
	startedAt: NOW,
	completedAt: NOW,
	summary: {
		plannedTargets: 1,
		attemptedTargets: 1,
		successfulTargets: 1,
		rawRecords: 2,
		acceptedRecords: 2,
		rejectedRecords: 0,
		newUniqueIdentities: 2,
		duplicateAppearances: 0,
		retries: 0,
		failures: 0,
		terminalEvidence: { kind: 'declared_last_page', summary: 'done', details: {} },
	},
});

const traversalReport = (over: Partial<WebRobotTraversalReport> = {}): WebRobotTraversalReport => ({
	definition: definition(),
	attempts: [completeAttempt()],
	selectedAttemptId: 'traversal-products-attempt-1',
	...over,
});

const decision = (over: Partial<ScopeFitnessDecision> = {}): ScopeFitnessDecision => ({
	candidateId: 'api-1',
	role: 'primary_enumerator',
	relation: 'exact',
	entityKind: 'product_variant',
	granularity: 'variant',
	evidenceIds: [],
	blockers: [],
	limitations: [],
	...over,
});

const countSignal = (over: Partial<CountSignal> = {}): CountSignal => ({
	id: 'count-1',
	value: 2,
	unit: 'variant',
	source: 'displayed',
	scopeId: 'scope-1',
	reliability: 'strong',
	observedAt: NOW,
	comparable: true,
	...over,
});

const product = (sku: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
	product_key: `key:${sku}`,
	source_url: `https://example.com/p/${sku}`,
	canonical_url: `https://example.com/p/${sku}`,
	name: `Product ${sku}`,
	sku,
	brand: 'Acme',
	description: 'A product',
	price: 10,
	currency: 'USD',
	categories_json: '["tools"]',
	attributes_json: '{"material":"steel"}',
	raw_json: JSON.stringify({ availability: 'in stock' }),
	...over,
});

const normalized = (
	products: Record<string, unknown>[],
	metrics: Record<string, unknown> = {},
): NormalizedProducts => ({
	products,
	attributes: products.map((entry) => ({
		product_key: String(entry.product_key),
		name: 'material',
		value: 'steel',
	})),
	documents: [],
	identityMetrics: {
		totalEntities: products.length,
		configuredFieldUsage: { sku: products.length },
		fallbackUrlCount: 0,
		recordHashFallbackCount: 0,
		collisionCount: 0,
		collisions: [],
		...metrics,
	} as NormalizedProducts['identityMetrics'],
});

const result = (over: Partial<WebRobotVerificationExecutionResult> = {}): WebRobotVerificationExecutionResult => ({
	stats: emptyWebRobotRunStats(),
	stageRecords: new Map(),
	products: normalized([product('A'), product('B')]).products,
	events: [],
	normalized: normalized([product('A'), product('B')]),
	traversals: [traversalReport()],
	traversalSteps: [],
	anomalies: [],
	countSignals: [],
	...over,
});

const reconcile = (over: Partial<Parameters<typeof reconcileCatalogueTrust>[0]> = {}) =>
	reconcileCatalogueTrust({
		runId: 'run-1',
		configurationHash: 'cfg-1',
		scope: scope(),
		contract: contract(),
		verificationPlan: plan(),
		sourceAssessment: [decision()],
		result: result(),
		verifiedAt: new Date(NOW),
		...over,
	});

const previousSummary = (over: Partial<CatalogueTrustSummary> = {}): CatalogueTrustSummary => ({
	policyVersion: 1,
	status: 'ready',
	basis: 'count_reconciled',
	scopeLabel: 'All products',
	entityCount: 100,
	granularity: 'variant',
	verifiedAt: NOW,
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
	...over,
});

describe('catalogue trust reconciliation', () => {
	it('reports ready with count_reconciled when a strong count matches', () => {
		const report = reconcile({ result: result({ countSignals: [countSignal()] }) });
		expect(report.summary.status).toBe('ready');
		expect(report.summary.basis).toBe('count_reconciled');
		expect(report.countComparisons[0]?.status).toBe('match');
		expect(report.summary.blockerCodes).toEqual([]);
	});

	it('reports ready traversal_complete without an independent count', () => {
		const report = reconcile();
		expect(report.summary.status).toBe('ready');
		expect(report.summary.basis).toBe('traversal_complete');
		expect(report.summary.limitations).toContain('No independent comparable source count was available.');
		const readme = catalogueTrustReadme(report, ['trust/report.json']);
		expect(readme).toContain('Traversal-only basis');
		expect(readme).not.toContain('100% company catalogue');
	});

	it('blocks when a required traversal did not complete', () => {
		const report = reconcile({
			result: result({
				traversals: [
					traversalReport({
						attempts: [{ ...completeAttempt(), status: 'failed' }],
						selectedAttemptId: undefined,
					}),
				],
			}),
		});
		expect(report.summary.status).toBe('needs_attention');
		expect(report.summary.basis).toBe('none');
		expect(report.summary.blockerCodes).toContain('required_traversal_incomplete');
		expect(report.summary.blockerCodes).toContain('dimension_records');
	});

	it('retains blocking traversal anomalies as blockers', () => {
		const report = reconcile({
			result: result({
				anomalies: [
					{
						code: 'limit_reached',
						severity: 'blocking',
						summary: 'page limit',
						traversalId: 'traversal-products',
						evidenceIds: [],
						details: {},
					},
				],
			}),
		});
		expect(report.summary.status).toBe('needs_attention');
		expect(report.summary.blockerCodes).toContain('limit_reached');
	});

	it('blocks publication when a completed enumeration contains gaps', () => {
		const report = reconcile({
			result: result({
				anomalies: [
					{
						code: 'traversal_gap',
						severity: 'blocking',
						summary: 'Enumeration target page 2 failed and was recorded as a gap.',
						traversalId: 'traversal-products',
						evidenceIds: [],
						details: { sequence: 1, redactedTarget: 'GET https://example.com/catalog?page=2' },
					},
				],
			}),
		});
		expect(report.summary.status).toBe('needs_attention');
		expect(report.summary.blockerCodes).toContain('traversal_gap');
		expect(report.summary.entityCount).toBe(2);
	});

	it('publishes a gap fully explained by the declared item total and gap capacity', () => {
		const report = reconcile({
			result: result({
				countSignals: [countSignal({ id: 'runtime-traversal-products-total', value: 3, source: 'api' })],
				anomalies: [
					{
						code: 'traversal_gap',
						severity: 'blocking',
						summary: 'Enumeration target page 2 failed and was recorded as a gap.',
						traversalId: 'traversal-products',
						evidenceIds: [],
						details: {
							sequence: 1,
							redactedTarget: 'GET https://example.com/catalog?page=2',
							error: 'HTTP 500',
							capacity: 1,
						},
					},
				],
			}),
		});
		expect(report.summary.status).toBe('ready');
		expect(report.summary.basis).toBe('count_reconciled');
		expect(report.summary.dimensions.records.status).toBe('passed');
		expect(report.countComparisons[0]?.status).toBe('reconciled');
		expect(report.countComparisons[0]?.expectedCount).toBe(3);
		const gap = report.anomalies.find((entry) => entry.code === 'traversal_gap');
		expect(gap?.severity).toBe('limitation');
		expect(report.summary.limitations.some((entry) => entry.includes('page=2'))).toBe(true);
		expect(report.summary.limitations.some((entry) => entry.includes('1 of 3'))).toBe(true);
		expect(report.summary.blockerCodes).toEqual([]);
	});

	it('keeps blocking when the missing count exceeds the gap capacity', () => {
		const report = reconcile({
			result: result({
				countSignals: [countSignal({ id: 'runtime-traversal-products-total', value: 5, source: 'api' })],
				anomalies: [
					{
						code: 'traversal_gap',
						severity: 'blocking',
						summary: 'Enumeration target page 2 failed and was recorded as a gap.',
						traversalId: 'traversal-products',
						evidenceIds: [],
						details: {
							sequence: 1,
							redactedTarget: 'GET https://example.com/catalog?page=2',
							error: 'HTTP 500',
							capacity: 1,
						},
					},
				],
			}),
		});
		expect(report.summary.status).toBe('needs_attention');
		expect(report.countComparisons[0]?.status).toBe('mismatch');
		expect(report.summary.blockerCodes).toContain('count_conflict');
		expect(report.summary.blockerCodes).toContain('traversal_gap');
	});

	it('keeps a gap blocking when no declared item total exists', () => {
		const report = reconcile({
			result: result({
				anomalies: [
					{
						code: 'traversal_gap',
						severity: 'blocking',
						summary: 'Enumeration target page 2 failed and was recorded as a gap.',
						traversalId: 'traversal-products',
						evidenceIds: [],
						details: {
							sequence: 1,
							redactedTarget: 'GET https://example.com/catalog?page=2',
							error: 'HTTP 500',
							capacity: 10,
						},
					},
				],
			}),
		});
		expect(report.summary.status).toBe('needs_attention');
		expect(report.summary.blockerCodes).toContain('traversal_gap');
	});

	it('keeps gaps blocking when gap bounds were exceeded even with a declared total', () => {
		const report = reconcile({
			result: result({
				countSignals: [countSignal({ id: 'runtime-traversal-products-total', value: 3, source: 'api' })],
				traversals: [
					traversalReport({
						attempts: [{ ...completeAttempt(), status: 'failed' }],
						selectedAttemptId: undefined,
					}),
				],
				anomalies: [
					{
						code: 'traversal_gap',
						severity: 'blocking',
						summary: 'Enumeration target page 2 failed and was recorded as a gap.',
						traversalId: 'traversal-products',
						evidenceIds: [],
						details: {
							sequence: 1,
							redactedTarget: 'GET https://example.com/catalog?page=2',
							error: 'HTTP 500',
							capacity: 10,
						},
					},
					{
						code: 'gap_tolerance_exceeded',
						severity: 'blocking',
						summary: 'Enumeration stopped: gap tolerance exceeded.',
						traversalId: 'traversal-products',
						evidenceIds: [],
						details: {},
					},
				],
			}),
		});
		expect(report.summary.status).toBe('needs_attention');
		expect(report.summary.blockerCodes).toContain('traversal_gap');
		expect(report.summary.blockerCodes).toContain('gap_tolerance_exceeded');
	});

	it('publishes a declared-766 catalogue when one 10-product page failed to load', () => {
		const products = Array.from({ length: 756 }, (_, index) => product(`SKU-${index}`));
		const report = reconcile({
			result: result({
				products: normalized(products).products,
				normalized: normalized(products),
				countSignals: [countSignal({ id: 'runtime-traversal-products-total', value: 766, source: 'api' })],
				anomalies: [
					{
						code: 'traversal_gap',
						severity: 'blocking',
						summary: 'Enumeration target page 22 failed and was recorded as a gap.',
						traversalId: 'traversal-products',
						evidenceIds: [],
						details: {
							sequence: 21,
							redactedTarget: 'GET https://example.com/api/products?page=22',
							error: 'HTTP 500 after retries',
							capacity: 10,
						},
					},
				],
			}),
		});
		expect(report.summary.status).toBe('ready');
		expect(report.summary.basis).toBe('count_reconciled');
		expect(report.summary.entityCount).toBe(756);
		expect(report.countComparisons[0]?.status).toBe('reconciled');
		expect(report.summary.limitations.some((entry) => entry.includes('page=22'))).toBe(true);
		expect(report.anomalies.find((entry) => entry.code === 'traversal_gap')?.severity).toBe('limitation');
	});

	it('blocks when the selected candidate does not match the confirmed scope', () => {
		const report = reconcile({ sourceAssessment: [decision({ relation: 'subset' })] });
		expect(report.summary.dimensions.scope.status).toBe('failed');
		expect(report.summary.blockerCodes).toContain('scope_mismatch');
	});

	it('blocks when no entities were produced', () => {
		const report = reconcile({ result: result({ normalized: normalized([]), products: [] }) });
		expect(report.summary.blockerCodes).toContain('no_entities');
		expect(report.summary.status).toBe('needs_attention');
	});

	it('blocks on count mismatch and on conflicting compatible counts', () => {
		const mismatch = reconcile({ result: result({ countSignals: [countSignal({ value: 5 })] }) });
		expect(mismatch.countComparisons[0]?.status).toBe('mismatch');
		expect(mismatch.summary.blockerCodes).toContain('count_conflict');
		const mismatchReadme = catalogueTrustReadme(mismatch, []);
		expect(mismatchReadme).toContain('Count reconciliation did not pass');
		expect(mismatchReadme).not.toContain('Traversal-only basis');

		const conflict = reconcile({
			result: result({ countSignals: [countSignal(), countSignal({ id: 'count-2', value: 9 })] }),
		});
		expect(conflict.summary.blockerCodes).toContain('count_conflict');
	});

	it('blocks on identity collisions and record-hash fallbacks', () => {
		const collided = reconcile({
			result: result({
				normalized: normalized([product('A'), product('B')], {
					collisionCount: 1,
					collisions: [{ productKey: 'key:x', identityDescriptors: ['a', 'b'] }],
				}),
			}),
		});
		expect(collided.summary.blockerCodes).toContain('identity_collision');

		const unstable = reconcile({
			result: result({
				normalized: normalized([product('A'), product('B')], { recordHashFallbackCount: 1 }),
			}),
		});
		expect(unstable.summary.blockerCodes).toContain('unstable_identity');
	});

	it('blocks when a required concept is below its coverage threshold', () => {
		const report = reconcile({
			result: result({ normalized: normalized([product('A'), product('B', { brand: null })]) }),
			contract: contract({
				requiredConcepts: [
					{ concept: 'name', required: true, minimumCoverage: 1 },
					{ concept: 'brand', required: true, minimumCoverage: 1 },
				],
			}),
		});
		expect(report.summary.blockerCodes).toContain('required_concept_brand');
		expect(report.summary.dimensions.semantics.status).toBe('failed');
	});

	it('keeps ready when only optional concepts or traversals fall short', () => {
		const optionalConcept = reconcile({
			contract: contract({
				requiredConcepts: [
					{ concept: 'name', required: true, minimumCoverage: 1 },
					{ concept: 'availability', required: false, minimumCoverage: 1 },
				],
			}),
			result: result({
				normalized: normalized([product('A', { raw_json: '{}' }), product('B', { raw_json: '{}' })]),
			}),
		});
		expect(optionalConcept.summary.dimensions.semantics.status).toBe('limited');
		expect(optionalConcept.summary.status).toBe('ready');

		const optionalTraversal = reconcile({
			verificationPlan: plan({
				traversals: [
					definition(),
					definition({ id: 'traversal-extra', stageId: 'extra', required: false, role: 'corroboration' }),
				],
			}),
			result: result({
				traversals: [
					traversalReport(),
					{
						definition: definition({ id: 'traversal-extra', stageId: 'extra', required: false }),
						attempts: [{ ...completeAttempt(), status: 'failed' }],
					},
				],
			}),
		});
		expect(optionalTraversal.summary.dimensions.records.status).toBe('limited');
		expect(optionalTraversal.summary.status).toBe('ready');
	});

	it('downgrades blocking anomalies on optional traversals but keeps strong contradictions blocking', () => {
		const optionalPlan = plan({
			traversals: [
				definition(),
				definition({ id: 'traversal-extra', stageId: 'extra', required: false, role: 'corroboration' }),
			],
		});
		const optionalResult = (anomalyCode: string) =>
			result({
				traversals: [
					traversalReport(),
					{
						definition: definition({ id: 'traversal-extra', stageId: 'extra', required: false }),
						attempts: [{ ...completeAttempt(), status: 'limit_reached' }],
					},
				],
				anomalies: [
					{
						code: anomalyCode,
						severity: 'blocking',
						summary: 'optional traversal limit',
						traversalId: 'traversal-extra',
						evidenceIds: [],
						details: {},
					},
				],
			});

		const downgraded = reconcile({
			verificationPlan: optionalPlan,
			result: optionalResult('limit_reached'),
		});
		expect(downgraded.summary.status).toBe('ready');
		expect(downgraded.summary.dimensions.records.status).toBe('limited');
		const downgradedAnomaly = downgraded.anomalies.find((entry) => entry.traversalId === 'traversal-extra');
		expect(downgradedAnomaly?.severity).toBe('limitation');
		expect(
			downgraded.summary.limitations.some((entry) => entry.includes("'traversal-extra' reported limit_reached")),
		).toBe(true);

		const contradiction = reconcile({
			verificationPlan: optionalPlan,
			result: optionalResult('count_conflict'),
		});
		expect(contradiction.summary.status).toBe('needs_attention');
		expect(contradiction.anomalies.find((entry) => entry.traversalId === 'traversal-extra')?.severity).toBe(
			'blocking',
		);
	});

	it('stays ready with unknown granularity but records the limitation', () => {
		const report = reconcile({ contract: contract({ entityGranularity: 'unknown' }) });
		expect(report.summary.status).toBe('ready');
		expect(report.summary.limitations.some((entry) => entry.includes('granularity is source-defined'))).toBe(true);
	});

	it('blocks on granularity drift and large entity drops against a previous ready summary', () => {
		const drift = reconcile({ previousSummary: previousSummary({ granularity: 'family' }) });
		expect(drift.summary.blockerCodes).toContain('granularity_drift');
		expect(drift.summary.status).toBe('needs_attention');

		const drop = reconcile({ previousSummary: previousSummary({ entityCount: 100 }) });
		expect(drop.summary.blockerCodes).toContain('entity_count_drop');
	});

	it('treats wrong-scope or wrong-unit count signals as not comparable', () => {
		const report = reconcile({
			result: result({
				countSignals: [countSignal({ scopeId: 'scope-other' }), countSignal({ id: 'count-2', unit: 'family' })],
			}),
		});
		expect(report.countComparisons.every((comparison) => comparison.status === 'not_comparable')).toBe(true);
		expect(report.summary.basis).toBe('traversal_complete');
	});

	it('produces a schema-valid report with deterministic hash and a complete README', () => {
		const input = { result: result({ countSignals: [countSignal()] }) };
		const first = reconcile(input);
		const second = reconcile(input);
		expect(() => catalogueTrustReportSchema.parse(first)).not.toThrow();
		expect(catalogueTrustReportHash(first)).toBe(catalogueTrustReportHash(second));

		const readme = catalogueTrustReadme(first, ['trust/report.json', 'trust/summary.json']);
		expect(readme).toContain('All products');
		expect(readme).toContain('count_reconciled');
		expect(readme).toContain('Observed 2 unique entities');
		expect(readme).toContain('trust/report.json');

		const manifest = catalogueTrustManifestProjection(first);
		expect(manifest.trustReportHash).toBe(catalogueTrustReportHash(first));
		expect(manifest.scope.id).toBe('scope-1');
		expect(manifest.contract.requiredConcepts).toHaveLength(5);
	});

	it('projects only required concepts into the summary coverage', () => {
		const report = reconcile({
			contract: contract({
				requiredConcepts: [
					{ concept: 'name', required: true, minimumCoverage: 1 },
					{ concept: 'specifications', required: true, minimumCoverage: 0.95 },
					{ concept: 'brand', required: false, minimumCoverage: 0.95 },
				],
			}),
		});

		expect(report.summary.requiredCoverage).toEqual([
			{ concept: 'name', covered: 2, total: 2, coverage: 1, minimumCoverage: 1 },
			{ concept: 'specifications', covered: 2, total: 2, coverage: 1, minimumCoverage: 0.95 },
		]);
	});
});

describe('catalogue trust verdict policy', () => {
	const dimensions = (status: 'passed' | 'failed'): CatalogueTrustDimensions => ({
		scope: { status: 'passed', reasons: [] },
		records: { status, reasons: status === 'failed' ? ['failed'] : [] },
		identity: { status: 'passed', reasons: [] },
		semantics: { status: 'passed', reasons: [] },
		freshness: { status: 'passed', reasons: [] },
	});

	it('marks needs_attention with basis none when any dimension fails', () => {
		const summary = deriveCatalogueTrustVerdict({
			scopeLabel: 'All products',
			granularity: 'variant',
			entityCount: 2,
			verifiedAt: NOW,
			dimensions: dimensions('failed'),
			anomalies: [],
			countSignals: [],
			countComparisons: [],
			limitations: [],
			requiredCoverage: [],
		});
		expect(summary.status).toBe('needs_attention');
		expect(summary.basis).toBe('none');
		expect(summary.blockerCodes).toContain('dimension_records');
	});

	it('marks ready count_reconciled only with a strong matching count', () => {
		const summary = deriveCatalogueTrustVerdict(
			{
				scopeLabel: 'All products',
				granularity: 'variant',
				entityCount: 2,
				verifiedAt: NOW,
				dimensions: dimensions('passed'),
				anomalies: [],
				countSignals: [countSignal()],
				countComparisons: [
					{ status: 'match', signalIds: ['count-1'], observedUniqueCount: 2, expectedCount: 2 },
				],
				limitations: [],
				requiredCoverage: [],
			},
			CATALOGUE_TRUST_POLICY_V1,
		);
		expect(summary.status).toBe('ready');
		expect(summary.basis).toBe('count_reconciled');
	});
});
