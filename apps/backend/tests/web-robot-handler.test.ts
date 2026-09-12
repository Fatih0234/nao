import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	activateWebRobotPublication: vi.fn(),
	completeWebRobotTrustEvaluation: vi.fn(),
	createWebRobotRun: vi.fn(),
	failStaleWebRobotRuns: vi.fn(),
	findActiveWebRobotRun: vi.fn(),
	getActiveWebRobotConfiguration: vi.fn(),
	getPendingWebRobotConfiguration: vi.fn(),
	getWebRobotById: vi.fn(),
	getWebRobotConfiguration: vi.fn(),
	getWebRobotRunById: vi.fn(),
	getEnvVars: vi.fn(),
	markWebRobotPublicationFailed: vi.fn(),
	markWebRobotRunRunning: vi.fn(),
	reconcileCatalogueTrust: vi.fn(),
	runWebRobotVerification: vi.fn(),
	updateWebRobotRunProgress: vi.fn(),
	writeWebRobotRunArtifacts: vi.fn(),
}));

vi.mock('../src/queries/web-robot.queries', () => ({
	activateWebRobotPublication: mocks.activateWebRobotPublication,
	completeWebRobotTrustEvaluation: mocks.completeWebRobotTrustEvaluation,
	createWebRobotRun: mocks.createWebRobotRun,
	failStaleWebRobotRuns: mocks.failStaleWebRobotRuns,
	findActiveWebRobotRun: mocks.findActiveWebRobotRun,
	getActiveWebRobotConfiguration: mocks.getActiveWebRobotConfiguration,
	getPendingWebRobotConfiguration: mocks.getPendingWebRobotConfiguration,
	getWebRobotById: mocks.getWebRobotById,
	getWebRobotConfiguration: mocks.getWebRobotConfiguration,
	getWebRobotRunById: mocks.getWebRobotRunById,
	markWebRobotPublicationFailed: mocks.markWebRobotPublicationFailed,
	markWebRobotRunRunning: mocks.markWebRobotRunRunning,
	updateWebRobotRunProgress: mocks.updateWebRobotRunProgress,
}));

vi.mock('../src/queries/project.queries', () => ({
	getEnvVars: mocks.getEnvVars,
}));

vi.mock('../src/services/web-robot-artifacts', () => ({
	webRobotRunArtifactPaths: (slug: string, runId: string) => ({
		artifactPrefix: `/datasets/${slug}/versions/${runId}`,
		latestPrefix: `/datasets/${slug}/latest`,
		trustReportPath: `/datasets/${slug}/versions/${runId}/trust-report.json`,
		traversalStepsPath: `/datasets/${slug}/versions/${runId}/traversal-steps.jsonl`,
	}),
	writeWebRobotRunArtifacts: mocks.writeWebRobotRunArtifacts,
}));

vi.mock('../src/services/web-robot', () => ({
	webRobotRunSnapshot: vi.fn(),
}));

vi.mock('../src/services/web-scraper/traversal', () => ({
	runWebRobotVerification: mocks.runWebRobotVerification,
}));

vi.mock('../src/services/web-robot-trust/reconcile', () => ({
	reconcileCatalogueTrust: mocks.reconcileCatalogueTrust,
}));

vi.mock('../src/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	serializeError: (error: unknown) => String(error),
}));

import { webRobotRunJob } from '../src/handlers/web-robot.handler';
import { webRobotConfigurationHash } from '../src/services/web-robot-configuration';

const scope = {
	version: 1,
	id: 'scope-1',
	label: 'All products',
	entryUrl: 'https://example.com/products',
	includedUrls: ['https://example.com/products'],
	activeFilters: {},
	selection: { mode: 'automatic', candidateId: 'api-1', confidence: 'high', rationale: [] },
};
const contract = {
	version: 1,
	entityGranularity: 'variant',
	requiredConcepts: [{ concept: 'name', required: true, minimumCoverage: 1 }],
	publishWhenReady: true,
	createdAt: '2026-01-01T00:00:00.000Z',
};
const plan = {
	version: 1,
	scopeId: 'scope-1',
	traversals: [],
	countSignalIds: [],
};
const recipe = { version: 2, allowedHosts: ['example.com'], stages: [] };

const configurationHash = webRobotConfigurationHash({
	recipe,
	scope,
	contract,
	verificationPlan: plan,
	sourceAssessment: [],
	scopeEvidence: [],
	countSignals: [],
});

const configuration = {
	id: 'cfg-1',
	robotId: 'robot-1',
	configurationHash,
	recipeHash: 'recipe-hash',
	recipe,
	sourceAssessment: [],
	scopeEvidence: [],
	countSignals: [],
};

const claimedRun = (over: Record<string, unknown> = {}) => ({
	id: 'run-1',
	robotId: 'robot-1',
	status: 'running',
	definition: recipe,
	definitionHash: 'recipe-hash',
	configurationId: 'cfg-1',
	configurationHash,
	scopeSnapshot: scope,
	contractSnapshot: contract,
	verificationPlanSnapshot: plan,
	cancelRequestedAt: null,
	startedAt: new Date('2026-01-01T00:00:00.000Z'),
	stats: { errors: [] },
	artifactPrefix: null,
	...over,
});

const robot = (over: Record<string, unknown> = {}) => ({
	id: 'robot-1',
	projectId: 'proj-1',
	name: 'Catalog',
	slug: 'catalog',
	lastPublishedRunId: null,
	...over,
});

const verificationResult = () => ({
	stats: { errors: [] },
	stageRecords: new Map(),
	products: [{ product_key: 'key:1' }],
	events: [],
	normalized: {
		products: [{ product_key: 'key:1' }],
		attributes: [],
		documents: [],
		identityMetrics: {
			totalEntities: 1,
			configuredFieldUsage: {},
			fallbackUrlCount: 0,
			recordHashFallbackCount: 0,
			collisionCount: 0,
			collisions: [],
		},
	},
	traversals: [],
	traversalSteps: [],
	anomalies: [],
	countSignals: [],
});

const report = (status: 'ready' | 'needs_attention') => ({
	summary: {
		status,
		basis: 'traversal_complete',
		granularity: 'variant',
		entityCount: 1,
	},
});

const artifacts = {
	artifactPrefix: '/datasets/catalog/versions/run-1',
	latestPrefix: '/datasets/catalog/latest',
	trustReportPath: '/datasets/catalog/versions/run-1/trust-report.json',
	trustReportHash: 'report-hash',
	traversalStepsPath: '/datasets/catalog/versions/run-1/traversal-steps.jsonl',
	diff: { added: [], changed: [], removed: [], unchanged: [], changes: [] },
};

const job = { id: 'job-1' } as never;

const setup = (over: { robot?: Record<string, unknown>; run?: Record<string, unknown> } = {}) => {
	const robotRow = robot(over.robot);
	const run = claimedRun(over.run);
	mocks.getWebRobotById.mockResolvedValue(robotRow);
	mocks.getWebRobotRunById.mockResolvedValue(run);
	mocks.markWebRobotRunRunning.mockResolvedValue(run);
	mocks.getWebRobotConfiguration.mockResolvedValue(configuration);
	mocks.getEnvVars.mockResolvedValue({});
	mocks.runWebRobotVerification.mockResolvedValue(verificationResult());
	mocks.writeWebRobotRunArtifacts.mockResolvedValue(artifacts);
	mocks.findActiveWebRobotRun.mockResolvedValue(null);
	return { robotRow, run };
};

beforeEach(() => {
	vi.resetAllMocks();
});

describe('web robot handler trust orchestration', () => {
	it('verifies, reconciles, stages, completes pending, and activates a ready run', async () => {
		setup();
		mocks.reconcileCatalogueTrust.mockReturnValue(report('ready'));

		await webRobotRunJob({ webRobotId: 'robot-1', runId: 'run-1' }, job);

		expect(mocks.runWebRobotVerification).toHaveBeenCalledWith(
			expect.objectContaining({
				recipe,
				runId: 'run-1',
				verificationPlan: plan,
				entityGranularity: 'variant',
			}),
		);
		expect(mocks.reconcileCatalogueTrust).toHaveBeenCalledWith(
			expect.objectContaining({ runId: 'run-1', configurationHash }),
		);
		expect(mocks.writeWebRobotRunArtifacts).toHaveBeenCalledWith(
			expect.objectContaining({ runId: 'run-1', trustReport: report('ready') }),
		);
		expect(mocks.completeWebRobotTrustEvaluation).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				executionStatus: 'succeeded',
				trustStatus: 'ready',
				publicationStatus: 'pending',
				trustReportPath: artifacts.trustReportPath,
				trustReportHash: 'report-hash',
			}),
		);
		expect(mocks.activateWebRobotPublication).toHaveBeenCalledWith(
			expect.objectContaining({ robotId: 'robot-1', runId: 'run-1', configurationId: 'cfg-1' }),
		);
	});

	it('retains the previous publication when a run needs attention', async () => {
		setup({ robot: { lastPublishedRunId: 'run-0' } });
		mocks.reconcileCatalogueTrust.mockReturnValue(report('needs_attention'));

		await webRobotRunJob({ webRobotId: 'robot-1', runId: 'run-1' }, job);

		expect(mocks.completeWebRobotTrustEvaluation).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				executionStatus: 'succeeded',
				trustStatus: 'needs_attention',
				publicationStatus: 'retained_previous',
			}),
		);
		expect(mocks.activateWebRobotPublication).not.toHaveBeenCalled();
	});

	it('blocks the initial publication when the first run needs attention', async () => {
		setup();
		mocks.reconcileCatalogueTrust.mockReturnValue(report('needs_attention'));

		await webRobotRunJob({ webRobotId: 'robot-1', runId: 'run-1' }, job);

		expect(mocks.completeWebRobotTrustEvaluation).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({ publicationStatus: 'blocked_initial' }),
		);
		expect(mocks.activateWebRobotPublication).not.toHaveBeenCalled();
	});

	it('marks publication_failed when activation throws after a ready evaluation', async () => {
		setup();
		mocks.reconcileCatalogueTrust.mockReturnValue(report('ready'));
		mocks.activateWebRobotPublication.mockRejectedValue(new Error('hash mismatch'));

		await webRobotRunJob({ webRobotId: 'robot-1', runId: 'run-1' }, job);

		expect(mocks.completeWebRobotTrustEvaluation).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({ executionStatus: 'succeeded', trustStatus: 'ready' }),
		);
		expect(mocks.markWebRobotPublicationFailed).toHaveBeenCalledWith('run-1', 'hash mismatch');
	});

	it('rejects runs whose stored snapshot no longer matches the configuration hash', async () => {
		setup({ run: { scopeSnapshot: { ...scope, label: 'Tampered scope' } } });

		await expect(webRobotRunJob({ webRobotId: 'robot-1', runId: 'run-1' }, job)).rejects.toThrow(
			'no valid verification configuration',
		);
		expect(mocks.runWebRobotVerification).not.toHaveBeenCalled();
		expect(mocks.writeWebRobotRunArtifacts).not.toHaveBeenCalled();
	});

	it('throttles progress writes to at most one update per second', async () => {
		setup();
		mocks.reconcileCatalogueTrust.mockReturnValue(report('ready'));
		mocks.runWebRobotVerification.mockImplementation(
			async (options: { onProgress?: (progress: Record<string, unknown>) => Promise<void> }) => {
				await options.onProgress?.({ step: 1 });
				await options.onProgress?.({ step: 2 });
				return verificationResult();
			},
		);
		await webRobotRunJob({ webRobotId: 'robot-1', runId: 'run-1' }, job);

		expect(mocks.updateWebRobotRunProgress).toHaveBeenCalledTimes(1);
	});

	it('fails unconfigured runs without verification or staging', async () => {
		setup({
			run: {
				configurationId: null,
				configurationHash: null,
				scopeSnapshot: null,
				contractSnapshot: null,
				verificationPlanSnapshot: null,
			},
		});

		await expect(webRobotRunJob({ webRobotId: 'robot-1', runId: 'run-1' }, job)).rejects.toThrow(
			'no valid verification configuration',
		);

		expect(mocks.runWebRobotVerification).not.toHaveBeenCalled();
		expect(mocks.writeWebRobotRunArtifacts).not.toHaveBeenCalled();
		expect(mocks.activateWebRobotPublication).not.toHaveBeenCalled();
		expect(mocks.completeWebRobotTrustEvaluation).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({ executionStatus: 'failed', publicationStatus: 'blocked_initial' }),
		);
	});
});
