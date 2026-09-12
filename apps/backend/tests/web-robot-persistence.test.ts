import { webRobotRecipeSchema } from '@nao/shared/web-robot';
import type { CatalogueTrustSummary } from '@nao/shared/web-robot-trust';
import { describe, expect, it, vi } from 'vitest';

import type { DBWebRobot, DBWebRobotConfiguration, DBWebRobotRun } from '../src/db/abstractSchema';
import {
	isWebRobotRunPublishable,
	markWebRobotPublicationFailed,
	projectWebRobotCurrentState,
} from '../src/queries/web-robot.queries';

const dbMock = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('../src/db/db', () => ({ db: dbMock }));

const recipe = webRobotRecipeSchema.parse({
	version: 1,
	allowedHosts: ['example.com'],
	identity: { fields: ['sku', 'url'] },
	stages: [
		{
			id: 'products',
			source: { type: 'api', url: 'https://example.com/products' },
			output: 'product',
		},
	],
});

const trustSummary: CatalogueTrustSummary = {
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
		semantics: { status: 'passed', reasons: [] },
		freshness: { status: 'unknown', reasons: [] },
	},
	limitations: [],
	requiredCoverage: [],
	blockerCodes: [],
};

const robot = (overrides: Partial<DBWebRobot> = {}): DBWebRobot => ({
	id: 'robot-1',
	projectId: 'project-1',
	userId: 'user-1',
	scheduledJobId: null,
	name: 'Catalog',
	slug: 'catalog',
	description: null,
	definition: recipe,
	definitionVersion: 1,
	definitionHash: 'hash-1',
	archivedAt: null,
	lastSuccessfulRunId: null,
	lastSuccessfulRunAt: null,
	lastPublishedProductCount: null,
	activeConfigurationId: null,
	pendingConfigurationId: null,
	lastVerifiedRunId: null,
	lastVerifiedRunAt: null,
	lastPublishedRunId: null,
	lastPublishedRunAt: null,
	lastPublishedEntityCount: null,
	lastPublishedEntityUnit: null,
	createdAt: new Date('2026-01-01T00:00:00.000Z'),
	updatedAt: new Date('2026-01-01T00:00:00.000Z'),
	...overrides,
});

const run = (overrides: Partial<DBWebRobotRun> = {}): DBWebRobotRun => ({
	id: 'run-1',
	robotId: 'robot-1',
	scheduledJobId: null,
	triggeredByUserId: null,
	trigger: 'manual',
	status: 'queued',
	definition: recipe,
	definitionHash: 'hash-1',
	stats: {
		pagesDiscovered: 0,
		pagesFetched: 0,
		requests: 0,
		itemsExtracted: 0,
		productsAdded: 0,
		productsChanged: 0,
		productsRemoved: 0,
		productsUnchanged: 0,
		extractionErrors: 0,
		failedRequests: 0,
		errors: [],
	},
	artifactPrefix: null,
	errorMessage: null,
	cancelRequestedAt: null,
	configurationId: null,
	configurationHash: null,
	scopeSnapshot: null,
	contractSnapshot: null,
	verificationPlanSnapshot: null,
	executionStatus: 'queued',
	trustStatus: null,
	trustBasis: null,
	trustSummary: null,
	progress: null,
	publicationStatus: 'not_evaluated',
	trustReportPath: null,
	trustReportHash: null,
	executionErrorMessage: null,
	publicationErrorMessage: null,
	queuedAt: new Date('2026-01-01T00:00:00.000Z'),
	startedAt: null,
	completedAt: null,
	...overrides,
});

describe('projectWebRobotCurrentState', () => {
	it('reports needs_input without active data when no configuration exists', () => {
		const state = projectWebRobotCurrentState(robot(), null, null);

		expect(state).toEqual({ setupStatus: 'needs_input', latestRefreshFailed: false });
	});

	it('projects a ready active state from the published run', () => {
		const activeRun = run({
			id: 'run-active',
			status: 'completed',
			executionStatus: 'succeeded',
			trustStatus: 'ready',
			trustBasis: 'count_reconciled',
			trustSummary,
			publicationStatus: 'published',
		});
		const state = projectWebRobotCurrentState(
			robot({
				activeConfigurationId: 'config-1',
				lastPublishedRunId: 'run-active',
				lastPublishedRunAt: new Date('2026-01-01T00:01:00.000Z'),
				lastPublishedEntityCount: 30,
				lastPublishedEntityUnit: 'variant',
			}),
			activeRun,
			activeRun,
		);

		expect(state).toEqual({
			setupStatus: 'configured',
			executionStatus: 'succeeded',
			trustStatus: 'ready',
			trustBasis: 'count_reconciled',
			publicationStatus: 'published',
			activeRunId: 'run-active',
			activeSummary: trustSummary,
			latestRefreshFailed: false,
		});
	});

	it('retains the active run and flags latestRefreshFailed after a failed refresh', () => {
		const activeRun = run({
			id: 'run-active',
			status: 'completed',
			executionStatus: 'succeeded',
			trustStatus: 'ready',
			trustSummary,
			publicationStatus: 'published',
		});
		const failedRun = run({
			id: 'run-failed',
			status: 'failed',
			executionStatus: 'failed',
			publicationStatus: 'not_evaluated',
			executionErrorMessage: 'Source unreachable',
		});
		const state = projectWebRobotCurrentState(
			robot({ activeConfigurationId: 'config-1', lastPublishedRunId: 'run-active' }),
			failedRun,
			activeRun,
		);

		expect(state.activeRunId).toBe('run-active');
		expect(state.activeSummary).toEqual(trustSummary);
		expect(state.executionStatus).toBe('failed');
		expect(state.latestRefreshFailed).toBe(true);
	});

	it('flags latestRefreshFailed when the latest refresh needs attention or retained the previous publication', () => {
		const activeRun = run({
			id: 'run-active',
			status: 'completed',
			executionStatus: 'succeeded',
			trustStatus: 'ready',
			trustSummary,
			publicationStatus: 'published',
		});
		const degradedRun = run({
			id: 'run-degraded',
			status: 'partial',
			executionStatus: 'succeeded',
			trustStatus: 'needs_attention',
			trustSummary: { ...trustSummary, status: 'needs_attention', basis: 'none' },
			publicationStatus: 'retained_previous',
		});
		const state = projectWebRobotCurrentState(
			robot({ activeConfigurationId: 'config-1', lastPublishedRunId: 'run-active' }),
			degradedRun,
			activeRun,
		);

		expect(state.latestRefreshFailed).toBe(true);
		expect(state.activeSummary).toEqual(trustSummary);
		expect(state.latestSummary).toEqual({ ...trustSummary, status: 'needs_attention', basis: 'none' });
	});

	it('projects a failed latest verification summary without publishing it', () => {
		const failedSummary: CatalogueTrustSummary = {
			...trustSummary,
			status: 'needs_attention',
			basis: 'none',
			blockerCodes: ['dimension_semantics', 'required_concept_membership'],
		};
		const blockedRun = run({
			id: 'run-blocked',
			status: 'partial',
			executionStatus: 'succeeded',
			trustStatus: 'needs_attention',
			trustBasis: 'none',
			trustSummary: failedSummary,
			publicationStatus: 'blocked_initial',
		});
		const state = projectWebRobotCurrentState(robot({ pendingConfigurationId: 'config-2' }), blockedRun, null);

		expect(state.activeSummary).toBeUndefined();
		expect(state.latestSummary).toEqual(failedSummary);
	});

	it('exposes pendingRunId for a pending initial run without an active publication', () => {
		const pendingRun = run({ id: 'run-pending', status: 'queued', executionStatus: 'queued' });
		const state = projectWebRobotCurrentState(robot({ pendingConfigurationId: 'config-2' }), pendingRun, null);

		expect(state).toEqual({
			setupStatus: 'configured',
			executionStatus: 'queued',
			publicationStatus: 'not_evaluated',
			pendingRunId: 'run-pending',
			latestRefreshFailed: false,
		});
	});
});

describe('isWebRobotRunPublishable', () => {
	const configuration = {
		id: 'cfg-1',
		robotId: 'robot-1',
		userId: 'user-1',
		status: 'draft',
		recipe,
		recipeVersion: 1,
		recipeHash: 'recipe-hash',
		scope: {},
		contract: {},
		verificationPlan: {},
		sourceAssessment: [],
		scopeEvidence: [],
		countSignals: [],
		configurationHash: 'cfg-hash',
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
	} as DBWebRobotConfiguration;

	const publishableRun = (overrides: Partial<DBWebRobotRun> = {}): DBWebRobotRun =>
		run({
			executionStatus: 'succeeded',
			trustStatus: 'ready',
			trustSummary,
			publicationStatus: 'pending',
			configurationId: 'cfg-1',
			configurationHash: 'cfg-hash',
			trustReportPath: '/datasets/catalog/versions/run-1/trust-report.json',
			trustReportHash: 'report-hash',
			...overrides,
		});
	const input = { productCount: 30, entityUnit: 'variant' as const };

	it('accepts a fully publishable run', () => {
		expect(isWebRobotRunPublishable(publishableRun(), configuration, input)).toBe(true);
	});

	it('rejects when the embedded summary status is not ready', () => {
		expect(
			isWebRobotRunPublishable(
				publishableRun({ trustSummary: { ...trustSummary, status: 'needs_attention' } }),
				configuration,
				input,
			),
		).toBe(false);
	});

	it('rejects when the summary has blocker codes or basis none', () => {
		expect(
			isWebRobotRunPublishable(
				publishableRun({ trustSummary: { ...trustSummary, blockerCodes: ['count_conflict'] } }),
				configuration,
				input,
			),
		).toBe(false);
		expect(
			isWebRobotRunPublishable(
				publishableRun({ trustSummary: { ...trustSummary, basis: 'none' } }),
				configuration,
				input,
			),
		).toBe(false);
	});

	it('rejects entity count and granularity mismatches', () => {
		expect(isWebRobotRunPublishable(publishableRun(), configuration, { ...input, productCount: 31 })).toBe(false);
		expect(isWebRobotRunPublishable(publishableRun(), configuration, { ...input, entityUnit: 'family' })).toBe(
			false,
		);
	});

	it('rejects when publication is not pending', () => {
		expect(
			isWebRobotRunPublishable(publishableRun({ publicationStatus: 'blocked_initial' }), configuration, input),
		).toBe(false);
	});

	it('rejects when trust report artifacts are absent or configuration hash differs', () => {
		expect(isWebRobotRunPublishable(publishableRun({ trustReportPath: null }), configuration, input)).toBe(false);
		expect(isWebRobotRunPublishable(publishableRun({ trustReportHash: null }), configuration, input)).toBe(false);
		expect(
			isWebRobotRunPublishable(publishableRun(), { ...configuration, configurationHash: 'other' }, input),
		).toBe(false);
	});
});

describe('markWebRobotPublicationFailed', () => {
	it('writes the failure message to both publication and legacy error fields', async () => {
		const execute = vi.fn(async () => undefined);
		const where = vi.fn(() => ({ execute }));
		const set = vi.fn(() => ({ where }));
		dbMock.update.mockReturnValue({ set } as never);

		await markWebRobotPublicationFailed('run-1', 'activation failed');

		expect(set).toHaveBeenCalledWith({
			publicationStatus: 'publication_failed',
			publicationErrorMessage: 'activation failed',
			errorMessage: 'activation failed',
		});
		expect(execute).toHaveBeenCalled();
	});
});
