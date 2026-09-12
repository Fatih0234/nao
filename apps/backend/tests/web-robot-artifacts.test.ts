import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { webRobotRecipeSchema } from '@nao/shared/web-robot';
import type { CatalogueTrustReport } from '@nao/shared/web-robot-trust';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listProtectedWebRobotArtifactRunIds: vi.fn(async () => [] as string[]),
}));

vi.mock('../src/queries/web-robot.queries', () => ({
	listProtectedWebRobotArtifactRunIds: mocks.listProtectedWebRobotArtifactRunIds,
	getPublishedWebDatasetBySlug: vi.fn(async () => null),
	listPublishedWebDatasets: vi.fn(async () => []),
}));

import { __reloadEnvForTesting } from '../src/env';
import { __resetStorageForTesting } from '../src/services/storage';
import {
	listProjectDatasetDirectory,
	readProjectDataset,
	statProjectDataset,
} from '../src/services/storage/project-datasets';
import { writeWebRobotRunArtifacts } from '../src/services/web-robot-artifacts';
import { reconcileCatalogueTrust } from '../src/services/web-robot-trust/reconcile';
import { catalogueTrustReportHash } from '../src/services/web-robot-trust/report';
import { normalizeProducts } from '../src/services/web-scraper/records';
import type { WebRobotVerificationExecutionResult } from '../src/services/web-scraper/types';

const NOW = '2026-01-01T00:00:00.000Z';

const recipe = webRobotRecipeSchema.parse({
	version: 1,
	allowedHosts: ['example.com'],
	identity: { fields: ['sku'] },
	publish: { minItems: 1, maxRemovedPercent: 50 },
	stages: [
		{
			id: 'products',
			source: { type: 'api', url: 'https://example.com/products' },
			output: 'product',
		},
	],
});

let root: string;
let originalEnv: typeof process.env;

beforeEach(async () => {
	originalEnv = { ...process.env };
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'nao-web-robot-artifacts-test-'));
	process.env.NAO_STORAGE_BACKEND = 'local';
	process.env.NAO_STORAGE_LOCAL_PATH = root;
	__reloadEnvForTesting();
	__resetStorageForTesting();
	mocks.listProtectedWebRobotArtifactRunIds.mockResolvedValue([]);
});

afterEach(async () => {
	process.env = originalEnv;
	__reloadEnvForTesting();
	__resetStorageForTesting();
	await fs.rm(root, { recursive: true, force: true });
});

const trustReport = (status: 'ready' | 'needs_attention', entityCount: number): CatalogueTrustReport =>
	reconcileCatalogueTrust({
		runId: 'run-1',
		configurationHash: 'cfg-1',
		scope: {
			version: 1,
			id: 'scope-1',
			label: 'All products',
			entryUrl: 'https://example.com/products',
			includedUrls: ['https://example.com/products'],
			activeFilters: {},
			selection: { mode: 'automatic', candidateId: 'api-1', confidence: 'high', rationale: [] },
		},
		contract: {
			version: 1,
			entityGranularity: 'variant',
			requiredConcepts: [
				{ concept: 'name', required: true, minimumCoverage: 1 },
				{ concept: 'source_url', required: true, minimumCoverage: 1 },
			],
			publishWhenReady: true,
			createdAt: NOW,
		},
		verificationPlan: {
			version: 1,
			scopeId: 'scope-1',
			traversals: [
				{
					id: 'traversal-products',
					stageId: 'products',
					role: 'enumeration',
					required: status === 'ready',
					sourceType: 'api',
					mode: 'page',
					terminalStrategies: ['declared_last_page'],
				},
			],
			countSignalIds: [],
		},
		sourceAssessment: [
			{
				candidateId: 'api-1',
				role: 'primary_enumerator',
				relation: 'exact',
				entityKind: 'product_variant',
				granularity: 'variant',
				evidenceIds: [],
				blockers: status === 'ready' ? [] : ['no stable count'],
				limitations: [],
			},
		],
		result: verificationResult(entityCount, status === 'ready' ? 'complete' : 'failed'),
		verifiedAt: new Date(NOW),
	});

const verificationResult = (
	entityCount: number,
	attemptStatus: 'complete' | 'failed',
): WebRobotVerificationExecutionResult => {
	const products = Array.from({ length: entityCount }, (_, index) => ({
		product_key: `key:${index}`,
		source_url: `https://example.com/p/${index}`,
		canonical_url: `https://example.com/p/${index}`,
		name: `Product ${index}`,
		sku: `SKU-${index}`,
	}));
	return {
		stats: {
			pagesDiscovered: 1,
			pagesFetched: 1,
			requests: 1,
			itemsExtracted: entityCount,
			productsAdded: 0,
			productsChanged: 0,
			productsRemoved: 0,
			productsUnchanged: 0,
			extractionErrors: 0,
			errors: [],
		},
		stageRecords: new Map(),
		products,
		events: [],
		normalized: {
			products,
			attributes: [],
			documents: [],
			identityMetrics: {
				totalEntities: entityCount,
				configuredFieldUsage: { sku: entityCount },
				fallbackUrlCount: 0,
				recordHashFallbackCount: 0,
				collisionCount: 0,
				collisions: [],
			},
		},
		traversals: [
			{
				definition: {
					id: 'traversal-products',
					stageId: 'products',
					role: 'enumeration',
					required: true,
					sourceType: 'api',
					mode: 'page',
					terminalStrategies: ['declared_last_page'],
				},
				attempts: [
					{
						attemptId: 'traversal-products-attempt-1',
						status: attemptStatus,
						startedAt: NOW,
						completedAt: NOW,
						summary: {
							plannedTargets: 1,
							attemptedTargets: 1,
							successfulTargets: attemptStatus === 'complete' ? 1 : 0,
							rawRecords: entityCount,
							acceptedRecords: entityCount,
							rejectedRecords: 0,
							newUniqueIdentities: entityCount,
							duplicateAppearances: 0,
							retries: 0,
							failures: attemptStatus === 'complete' ? 0 : 1,
						},
					},
				],
				...(attemptStatus === 'complete' ? { selectedAttemptId: 'traversal-products-attempt-1' } : {}),
			},
		],
		traversalSteps: [],
		anomalies: [],
		countSignals: [],
	};
};

const writeArtifacts = (
	runId: string,
	rows: Record<string, unknown>[],
	over: Partial<Parameters<typeof writeWebRobotRunArtifacts>[0]> = {},
) => {
	const report = over.trustReport ?? trustReport('ready', rows.length);
	return writeWebRobotRunArtifacts({
		projectId: 'proj-1',
		robotId: 'robot-1',
		robotName: 'Catalog',
		robotSlug: 'catalog',
		runId,
		recipe,
		definitionHash: `hash_${runId}`,
		normalized: normalizeProducts(
			rows.map((data) => ({ stageId: 'products', url: String(data.url), data })),
			recipe,
			runId,
		),
		events: [],
		traversalSteps: [],
		trustReport: report,
		stats: {
			pagesDiscovered: 1,
			pagesFetched: 1,
			requests: 1,
			itemsExtracted: rows.length,
			productsAdded: 0,
			productsChanged: 0,
			productsRemoved: 0,
			productsUnchanged: 0,
			extractionErrors: 0,
			errors: [],
		},
		completedAt: new Date('2026-01-01T00:01:00.000Z'),
		...over,
	});
};

const row = (sku: string, name = `Product ${sku}`) => ({
	sku,
	name,
	url: `https://example.com/${sku.toLowerCase()}`,
});

describe('web robot artifacts', () => {
	it('writes immutable version artifacts with trust report and never a physical latest', async () => {
		const report = trustReport('ready', 1);
		const result = await writeArtifacts('run_1', [row('A-1')], { trustReport: report });

		expect(result.artifactPrefix).toBe('/datasets/catalog/versions/run_1');
		expect(result.trustReportPath).toBe('/datasets/catalog/versions/run_1/trust-report.json');
		expect(result.trustReportHash).toBe(catalogueTrustReportHash(report));
		await expect(statProjectDataset('proj-1', 'catalog/latest')).rejects.toThrow(
			"No trusted published dataset exists for 'catalog'.",
		);

		const versionDir = 'catalog/versions/run_1';
		for (const name of [
			'products.jsonl',
			'products.parquet',
			'trust-report.json',
			'traversal-steps.jsonl',
			'manifest.json',
			'README.md',
		]) {
			expect(await statProjectDataset('proj-1', `${versionDir}/${name}`), name).not.toBeNull();
		}

		const storedReport = JSON.parse(await readProjectDataset('proj-1', `${versionDir}/trust-report.json`));
		expect(storedReport).toEqual(JSON.parse(JSON.stringify(report)));

		const manifest = JSON.parse(await readProjectDataset('proj-1', `${versionDir}/manifest.json`));
		expect(manifest).toMatchObject({ runId: 'run_1', counts: { products: 1 } });
		expect(manifest.trust.trustReportHash).toBe(result.trustReportHash);
		expect(manifest.trust.trustReportPath).toBe(result.trustReportPath);
		expect(manifest.trust.trustSummary.status).toBe('ready');
		expect(manifest).not.toHaveProperty('published');

		const readme = await readProjectDataset('proj-1', `${versionDir}/README.md`);
		expect(readme).toContain('All products');
		expect(readme).toContain('/datasets/catalog/latest/products.parquet');
		expect(readme).toContain('/datasets/catalog/versions/run_1/trust-report.json');
	});

	it('diffs against the supplied previousPublishedRunId version only', async () => {
		await writeArtifacts('run_1', [row('A-1'), row('B-2')]);
		const second = await writeArtifacts('run_2', [row('A-1', 'Product A-1 updated')], {
			previousPublishedRunId: 'run_1',
		});
		expect(second.diff.changed).toHaveLength(1);
		expect(second.diff.removed).toHaveLength(1);

		const noPointer = await writeArtifacts('run_3', [row('A-1')]);
		expect(noPointer.diff.added).toHaveLength(1);
	});

	it('retains needs-attention diagnostics identically under versions', async () => {
		const report = trustReport('needs_attention', 1);
		const result = await writeArtifacts('run_bad', [row('A-1')], { trustReport: report });

		expect(result.artifactPrefix).toBe('/datasets/catalog/versions/run_bad');
		expect(await statProjectDataset('proj-1', 'catalog/versions/run_bad/trust-report.json')).not.toBeNull();
		await expect(statProjectDataset('proj-1', 'catalog/latest')).rejects.toThrow(
			"No trusted published dataset exists for 'catalog'.",
		);
		const manifest = JSON.parse(await readProjectDataset('proj-1', 'catalog/versions/run_bad/manifest.json'));
		expect(manifest.trust.trustSummary.status).toBe('needs_attention');
	});

	it('keeps the newest unprotected versions plus every protected run', async () => {
		process.env.WEB_ROBOT_ARTIFACT_RETENTION_RUNS = '2';
		__reloadEnvForTesting();
		mocks.listProtectedWebRobotArtifactRunIds.mockResolvedValue(['run_1']);

		for (const [index, runId] of ['run_1', 'run_2', 'run_3', 'run_4', 'run_5'].entries()) {
			await writeArtifacts(runId, [row('A-1')], {
				completedAt: new Date(`2026-01-0${index + 1}T00:01:00.000Z`),
			});
		}

		const versions = await listProjectDatasetDirectory('proj-1', 'catalog/versions');
		expect(versions.map((entry) => entry.name).sort()).toEqual(['run_1', 'run_3', 'run_4', 'run_5']);
		expect(await statProjectDataset('proj-1', 'catalog/versions/run_2/manifest.json')).toBeNull();
	});
});
