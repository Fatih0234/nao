import { describe, expect, it } from 'vitest';

import {
	catalogueBaseRequiredConcepts,
	catalogueContractSchema,
	catalogueCurrentStateSchema,
	catalogueRequiredConceptSchema,
	catalogueTrustReportSchema,
	catalogueTrustSummarySchema,
	traversalStepEvidenceSchema,
} from '../src/web-robot-trust';

const scope = {
	version: 1,
	id: 'scope-1',
	label: 'All products',
	entryUrl: 'https://www.example.com/products',
	includedUrls: ['https://www.example.com/products'],
	selection: {
		mode: 'user_confirmed',
		candidateId: 'candidate-1',
		confidence: 'high',
		confirmedAt: '2026-01-01T00:00:00.000Z',
	},
};

const contract = {
	version: 1,
	entityGranularity: 'variant',
	requiredConcepts: [
		{ concept: 'name', minimumCoverage: 1 },
		{ concept: 'source_url', minimumCoverage: 1 },
		{ concept: 'stable_identity', minimumCoverage: 1 },
		{ concept: 'price', required: true, minimumCoverage: 0.95 },
	],
	publishWhenReady: true,
	createdAt: '2026-01-01T00:00:00.000Z',
};

const traversal = {
	definition: {
		id: 'traversal-1',
		stageId: 'products',
		role: 'enumeration',
		sourceType: 'api',
		mode: 'page',
	},
	attempts: [
		{
			attemptId: 'attempt-1',
			status: 'complete',
			startedAt: '2026-01-01T00:00:00.000Z',
			completedAt: '2026-01-01T00:01:00.000Z',
			summary: {
				plannedTargets: 3,
				attemptedTargets: 3,
				successfulTargets: 3,
				rawRecords: 30,
				acceptedRecords: 30,
				rejectedRecords: 0,
				newUniqueIdentities: 30,
				duplicateAppearances: 0,
				retries: 0,
				failures: 0,
				terminalEvidence: { kind: 'declared_last_page', summary: 'Page 3 declared itself last' },
			},
		},
	],
	selectedAttemptId: 'attempt-1',
};

const summary = {
	policyVersion: 1,
	status: 'ready',
	basis: 'count_reconciled',
	scopeLabel: 'All products',
	entityCount: 30,
	granularity: 'variant',
	verifiedAt: '2026-01-01T00:01:00.000Z',
	dimensions: {
		scope: { status: 'passed', reasons: [] },
		records: { status: 'passed', reasons: [] },
		identity: { status: 'passed', reasons: [] },
		semantics: { status: 'limited', reasons: ['price coverage below target'] },
		freshness: { status: 'unknown', reasons: [] },
	},
	limitations: ['price coverage below target'],
	requiredCoverage: [],
	blockerCodes: [],
};

const report = {
	version: 1,
	policyVersion: 1,
	runId: 'run-1',
	configurationHash: 'sha256:abc',
	scope,
	contract,
	verificationPlan: {
		version: 1,
		scopeId: 'scope-1',
		traversals: [traversal.definition],
		countSignalIds: ['signal-1'],
	},
	sourceAssessment: [
		{
			candidateId: 'candidate-1',
			role: 'primary_enumerator',
			relation: 'exact',
			entityKind: 'product_variant',
			granularity: 'variant',
		},
	],
	traversals: [traversal],
	countSignals: [
		{
			id: 'signal-1',
			value: 30,
			unit: 'variant',
			source: 'displayed',
			scopeId: 'scope-1',
			reliability: 'strong',
			observedAt: '2026-01-01T00:00:30.000Z',
		},
	],
	countComparisons: [{ status: 'match', signalIds: ['signal-1'], observedUniqueCount: 30, expectedCount: 30 }],
	identity: {
		totalEntities: 30,
		configuredFieldUsage: { sku: 30 },
		fallbackUrlCount: 0,
		recordHashFallbackCount: 0,
		collisionCount: 0,
		collisions: [],
	},
	semantics: {
		concepts: [
			{ concept: 'name', covered: 30, total: 30, coverage: 1, required: true, minimumCoverage: 1 },
			{ concept: 'price', covered: 24, total: 30, coverage: 0.8, required: true, minimumCoverage: 0.95 },
		],
	},
	anomalies: [
		{
			code: 'price_coverage',
			severity: 'limitation',
			summary: 'Price coverage 0.8 is below the required 0.95',
		},
	],
	summary,
};

describe('catalogue trust contracts', () => {
	it('exposes base required concepts for name, source_url, and stable_identity', () => {
		expect(catalogueBaseRequiredConcepts).toEqual([
			{ concept: 'name', required: true, minimumCoverage: 1 },
			{ concept: 'source_url', required: true, minimumCoverage: 1 },
			{ concept: 'stable_identity', required: true, minimumCoverage: 1 },
		]);
	});

	it('parses a full trust report and applies defaults', () => {
		const parsed = catalogueTrustReportSchema.parse(report);

		expect(parsed.scope.excludedPatterns).toEqual([]);
		expect(parsed.scope.activeFilters).toEqual({});
		expect(parsed.scope.selection.rationale).toEqual([]);
		expect(parsed.sourceAssessment[0]?.blockers).toEqual([]);
		expect(parsed.traversals[0]?.definition.required).toBe(true);
		expect(parsed.countSignals[0]?.comparable).toBe(true);
		expect(parsed.identity.totalEntities).toBe(30);
		expect(parsed.summary.status).toBe('ready');
		expect(parsed.summary.requiredCoverage).toEqual([]);
	});

	it('accepts required coverage metrics on a trust summary', () => {
		const metric = { concept: 'specifications', covered: 19, total: 20, coverage: 0.95, minimumCoverage: 0.95 };
		const parsed = catalogueTrustSummarySchema.parse({ ...summary, requiredCoverage: [metric] });
		expect(parsed.requiredCoverage).toEqual([metric]);
	});

	it('parses current state with defaults', () => {
		const parsed = catalogueCurrentStateSchema.parse({
			setupStatus: 'configured',
			executionStatus: 'succeeded',
			trustStatus: 'ready',
			trustBasis: 'traversal_complete',
			publicationStatus: 'published',
			activeRunId: 'run-1',
			activeSummary: summary,
		});

		expect(parsed.latestRefreshFailed).toBe(false);
		expect(parsed.activeSummary?.entityCount).toBe(30);
	});

	it('parses a current state carrying a latest non-active summary', () => {
		const latestSummary = { ...summary, status: 'needs_attention' as const, blockerCodes: ['dimension_semantics'] };
		const parsed = catalogueCurrentStateSchema.parse({
			setupStatus: 'configured',
			executionStatus: 'succeeded',
			trustStatus: 'needs_attention',
			publicationStatus: 'blocked_initial',
			latestSummary,
		});

		expect(parsed.latestSummary?.status).toBe('needs_attention');
		expect(parsed.latestSummary?.blockerCodes).toEqual(['dimension_semantics']);
	});

	it('parses a minimal current state', () => {
		expect(catalogueCurrentStateSchema.parse({ setupStatus: 'needs_input' })).toEqual({
			setupStatus: 'needs_input',
			latestRefreshFailed: false,
		});
	});

	it('rejects coverage values outside 0..1', () => {
		expect(catalogueRequiredConceptSchema.safeParse({ concept: 'name', minimumCoverage: 1.5 }).success).toBe(false);
		expect(
			catalogueContractSchema.safeParse({
				...contract,
				requiredConcepts: [{ concept: 'name', minimumCoverage: -0.1 }],
			}).success,
		).toBe(false);
	});

	it('rejects invalid trust and setup statuses', () => {
		expect(catalogueTrustSummarySchema.safeParse({ ...summary, status: 'unknown' }).success).toBe(false);
		expect(catalogueCurrentStateSchema.safeParse({ setupStatus: 'ready' }).success).toBe(false);
	});

	it('rejects reports without publishWhenReady and with malformed datetimes', () => {
		expect(
			catalogueTrustReportSchema.safeParse({
				...report,
				contract: { ...contract, publishWhenReady: false },
			}).success,
		).toBe(false);
		expect(
			catalogueTrustReportSchema.safeParse({
				...report,
				contract: { ...contract, createdAt: 'not-a-date' },
			}).success,
		).toBe(false);
	});

	it('parses traversal step evidence and rejects malformed entries', () => {
		const step = {
			traversalId: 'traversal-products',
			attemptId: 'traversal-products-attempt-1',
			sequence: 0,
			status: 'complete',
			target: { sequence: 0, fingerprint: 'a'.repeat(64), redactedTarget: 'GET https://example.com/products' },
			startedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			response: {
				status: 200,
				finalUrl: 'https://example.com/products',
				surfaceValid: true,
				responseFingerprint: 'b'.repeat(64),
			},
			rawRecords: 10,
			acceptedRecords: 9,
			rejectedRecords: 1,
			newUniqueIdentities: 9,
			duplicateAppearances: 0,
			terminalEvidence: { kind: 'next_control_absent', summary: 'Done', details: {} },
		};
		expect(traversalStepEvidenceSchema.safeParse(step).success).toBe(true);
		expect(traversalStepEvidenceSchema.safeParse({ ...step, status: 'gap' }).success).toBe(true);
		expect(traversalStepEvidenceSchema.safeParse({ ...step, status: 'loading' }).success).toBe(false);
		expect(traversalStepEvidenceSchema.safeParse({ ...step, rawRecords: -1 }).success).toBe(false);
	});
});
