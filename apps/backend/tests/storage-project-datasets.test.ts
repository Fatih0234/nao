import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webRobotQueries = vi.hoisted(() => ({
	getPublishedWebDatasetBySlug: vi.fn(),
	listPublishedWebDatasets: vi.fn(),
}));

vi.mock('../src/queries/web-robot.queries', () => webRobotQueries);

vi.mock('../src/services/storage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/services/storage')>();
	return { ...actual, getStorage: vi.fn(() => actual.getStorage()) };
});

import { __reloadEnvForTesting } from '../src/env';
import { __resetStorageForTesting, getStorage } from '../src/services/storage';
import {
	findPublishedProjectDatasetFiles,
	listProjectDatasetDirectory,
	listPublishedProjectDatasetDirectory,
	openProjectDatasetFiles,
	openPublishedProjectDatasetFiles,
	publishedProjectDatasetLocations,
	readProjectDataset,
	readPublishedProjectDataset,
	statProjectDataset,
	writeProjectDataset,
} from '../src/services/storage/project-datasets';
import type { StorageProvider } from '../src/services/storage/types';

let root: string;
let originalEnv: typeof process.env;

const publishedRow = (slug: string, runId: string) => ({
	slug,
	name: slug,
	activeRun: { id: runId },
	activeConfiguration: { id: `cfg-${runId}` },
});

const mockPublished = (rows: { slug: string; runId: string }[]) => {
	const datasets = rows.map(({ slug, runId }) => publishedRow(slug, runId));
	webRobotQueries.getPublishedWebDatasetBySlug.mockImplementation(
		async (_projectId: string, slug: string) => datasets.find((row) => row.slug === slug) ?? null,
	);
	webRobotQueries.listPublishedWebDatasets.mockImplementation(async () => datasets);
};

beforeEach(async () => {
	originalEnv = { ...process.env };
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'nao-project-datasets-test-'));
	process.env.NAO_STORAGE_BACKEND = 'local';
	process.env.NAO_STORAGE_LOCAL_PATH = root;
	__reloadEnvForTesting();
	__resetStorageForTesting();
	const actualStorage = await vi.importActual<typeof import('../src/services/storage')>('../src/services/storage');
	vi.mocked(getStorage).mockImplementation(actualStorage.getStorage);
	webRobotQueries.getPublishedWebDatasetBySlug.mockReset();
	webRobotQueries.listPublishedWebDatasets.mockReset();
	mockPublished([]);
});

afterEach(async () => {
	process.env = originalEnv;
	__reloadEnvForTesting();
	__resetStorageForTesting();
	await fs.rm(root, { recursive: true, force: true });
});

describe('project dataset storage', () => {
	it('writes, reads, and lists immutable dataset files directly', async () => {
		await writeProjectDataset('proj-1', 'deublin/versions/run-1/README.md', '# Deublin products\n');
		await writeProjectDataset('proj-1', 'deublin/versions/run-1/products.jsonl', '{"sku":"A-1"}\n');
		await writeProjectDataset('proj-1', 'other/versions/run-1/products.jsonl', '{"sku":"B-2"}\n');

		expect(await readProjectDataset('proj-1', 'deublin/versions/run-1/README.md')).toBe('# Deublin products\n');
		expect(await listProjectDatasetDirectory('proj-1', '')).toEqual([
			{ name: 'deublin', relativePath: 'deublin', type: 'directory', itemCount: 1 },
			{ name: 'other', relativePath: 'other', type: 'directory', itemCount: 1 },
		]);
		expect(await listProjectDatasetDirectory('proj-1', 'deublin/versions/run-1')).toEqual([
			{
				name: 'products.jsonl',
				relativePath: 'deublin/versions/run-1/products.jsonl',
				type: 'file',
				size: 14,
			},
			{
				name: 'README.md',
				relativePath: 'deublin/versions/run-1/README.md',
				type: 'file',
				size: 19,
			},
		]);
	});

	it('keeps project spaces isolated', async () => {
		await writeProjectDataset('proj-1', 'catalog/README.md', 'project 1');

		await expect(readProjectDataset('proj-2', 'catalog/README.md')).rejects.toThrow('No such project dataset file');
	});
});

describe('trusted latest aliases', () => {
	it('reads, stats, and lists through latest using the trusted pointer', async () => {
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/products.jsonl', '{"sku":"A-1"}\n');
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/README.md', 'docs');
		mockPublished([{ slug: 'catalog', runId: 'run-1' }]);

		expect(await readProjectDataset('proj-1', 'catalog/latest/products.jsonl')).toBe('{"sku":"A-1"}\n');

		const stat = await statProjectDataset('proj-1', 'catalog/latest/products.jsonl');
		expect(stat?.size).toBe(14);
		expect(stat?.key.endsWith('catalog/latest/products.jsonl')).toBe(true);

		expect(await listProjectDatasetDirectory('proj-1', 'catalog/latest')).toEqual([
			{
				name: 'products.jsonl',
				relativePath: 'catalog/latest/products.jsonl',
				type: 'file',
				size: 14,
			},
			{ name: 'README.md', relativePath: 'catalog/latest/README.md', type: 'file', size: 4 },
		]);
	});

	it('refuses a physical legacy latest with no trusted pointer', async () => {
		await writeProjectDataset('proj-1', 'catalog/latest/products.jsonl', '{"sku":"A-1"}\n');

		await expect(readProjectDataset('proj-1', 'catalog/latest/products.jsonl')).rejects.toThrow(
			"No trusted published dataset exists for 'catalog'.",
		);
		await expect(statProjectDataset('proj-1', 'catalog/latest/products.jsonl')).rejects.toThrow(
			"No trusted published dataset exists for 'catalog'.",
		);
	});

	it('switches every latest file atomically when the pointer moves', async () => {
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/products.jsonl', '{"sku":"A-1"}\n');
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/changes.jsonl', '{"change":1}\n');
		await writeProjectDataset('proj-1', 'catalog/versions/run-2/products.jsonl', '{"sku":"B-2"}\n');
		await writeProjectDataset('proj-1', 'catalog/versions/run-2/changes.jsonl', '{"change":2}\n');

		mockPublished([{ slug: 'catalog', runId: 'run-1' }]);
		expect(await readProjectDataset('proj-1', 'catalog/latest/products.jsonl')).toBe('{"sku":"A-1"}\n');

		mockPublished([{ slug: 'catalog', runId: 'run-2' }]);
		expect(await readProjectDataset('proj-1', 'catalog/latest/products.jsonl')).toBe('{"sku":"B-2"}\n');
		expect(await readProjectDataset('proj-1', 'catalog/latest/changes.jsonl')).toBe('{"change":2}\n');
	});

	it('still reads immutable versions directly for diagnostics', async () => {
		await writeProjectDataset('proj-1', 'catalog/versions/run-old/products.jsonl', '{"sku":"OLD"}\n');
		mockPublished([{ slug: 'catalog', runId: 'run-1' }]);

		expect(await readProjectDataset('proj-1', 'catalog/versions/run-old/products.jsonl')).toBe('{"sku":"OLD"}\n');
		expect(await listProjectDatasetDirectory('proj-1', 'catalog/versions/run-old')).toEqual([
			{
				name: 'products.jsonl',
				relativePath: 'catalog/versions/run-old/products.jsonl',
				type: 'file',
				size: 14,
			},
		]);
	});
});

describe('agent-facing published dataset access', () => {
	it('rejects non-latest paths, including direct versions', async () => {
		mockPublished([{ slug: 'catalog', runId: 'run-1' }]);

		await expect(readPublishedProjectDataset('proj-1', 'catalog/versions/run-1/products.jsonl')).rejects.toThrow(
			'Only trusted /latest web datasets are available to agents.',
		);
		await expect(openPublishedProjectDatasetFiles('proj-1', ['catalog/versions/run-1/a.parquet'])).rejects.toThrow(
			'Only trusted /latest web datasets are available to agents.',
		);
		await expect(listPublishedProjectDatasetDirectory('proj-1', 'catalog/versions/run-1')).rejects.toThrow(
			'Only trusted /latest web datasets are available to agents.',
		);
	});

	it('lists trusted slugs at the root and latest inside a slug', async () => {
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/products.jsonl', '{}\n');
		await writeProjectDataset('proj-1', 'beta/versions/run-9/products.jsonl', '{}\n');
		mockPublished([
			{ slug: 'catalog', runId: 'run-1' },
			{ slug: 'beta', runId: 'run-9' },
		]);

		expect(await listPublishedProjectDatasetDirectory('proj-1', '')).toEqual([
			{ name: 'beta', relativePath: 'beta', type: 'directory', itemCount: 1 },
			{ name: 'catalog', relativePath: 'catalog', type: 'directory', itemCount: 1 },
		]);
		expect(await listPublishedProjectDatasetDirectory('proj-1', 'catalog')).toEqual([
			{ name: 'latest', relativePath: 'catalog/latest', type: 'directory', itemCount: 1 },
		]);
		expect(await listPublishedProjectDatasetDirectory('proj-1', 'catalog/latest')).toEqual([
			{
				name: 'products.jsonl',
				relativePath: 'catalog/latest/products.jsonl',
				type: 'file',
				size: 3,
			},
		]);
	});

	it('finds only trusted active-version files and reports them as latest', async () => {
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/products.parquet', 'active');
		await writeProjectDataset('proj-1', 'catalog/versions/run-0/products.parquet', 'rejected');
		await writeProjectDataset('proj-1', 'beta/versions/run-9/products.parquet', 'beta');
		mockPublished([
			{ slug: 'catalog', runId: 'run-1' },
			{ slug: 'beta', runId: 'run-9' },
		]);

		const objects = await findPublishedProjectDatasetFiles('proj-1', (relativePath) =>
			relativePath.endsWith('.parquet'),
		);
		const keys = objects.map((object) => object.key).sort();
		expect(keys).toEqual([
			'projects/proj-1/datasets/beta/latest/products.parquet',
			'projects/proj-1/datasets/catalog/latest/products.parquet',
		]);
	});

	it('maps latest paths to the active version for local file access', async () => {
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/products.parquet', Buffer.from('PAR1 test'));
		mockPublished([{ slug: 'catalog', runId: 'run-1' }]);

		const access = await openPublishedProjectDatasetFiles('proj-1', ['catalog/latest/products.parquet']);
		try {
			const realPath = access.realPathOf('catalog/latest/products.parquet');
			expect(realPath).toContain(path.join('catalog', 'versions', 'run-1', 'products.parquet'));
			await expect(fs.readFile(realPath)).resolves.toEqual(Buffer.from('PAR1 test'));
		} finally {
			await access.release();
		}
	});

	it('resolves a whole open batch from one pointer snapshot', async () => {
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/products.parquet', 'products-1');
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/attributes.parquet', 'attributes-1');
		await writeProjectDataset('proj-1', 'catalog/versions/run-2/products.parquet', 'products-2');
		await writeProjectDataset('proj-1', 'catalog/versions/run-2/attributes.parquet', 'attributes-2');
		mockPublished([{ slug: 'catalog', runId: 'run-1' }]);
		webRobotQueries.getPublishedWebDatasetBySlug.mockImplementation(async () => publishedRow('catalog', 'run-2'));

		const access = await openPublishedProjectDatasetFiles('proj-1', [
			'catalog/latest/products.parquet',
			'catalog/latest/attributes.parquet',
		]);
		try {
			for (const requested of ['catalog/latest/products.parquet', 'catalog/latest/attributes.parquet']) {
				const bytes = await fs.readFile(access.realPathOf(requested), 'utf-8');
				expect(bytes.endsWith('-1')).toBe(true);
			}
			expect(webRobotQueries.listPublishedWebDatasets).toHaveBeenCalledTimes(1);
			expect(webRobotQueries.getPublishedWebDatasetBySlug).not.toHaveBeenCalled();
		} finally {
			await access.release();
		}
	});

	it('maps latest glob paths to the active version on the local backend', async () => {
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/products.parquet', Buffer.from('PAR1 test'));
		mockPublished([{ slug: 'catalog', runId: 'run-1' }]);

		const access = await openPublishedProjectDatasetFiles('proj-1', ['catalog/latest/*.parquet']);
		try {
			expect(access.realPathOf('catalog/latest/*.parquet')).toContain(path.join('catalog', 'versions', 'run-1'));
		} finally {
			await access.release();
		}
	});

	it('stages the active immutable object on a non-local backend', async () => {
		const remote: StorageProvider = {
			backend: 's3',
			write: vi.fn(async (key: string, data: Buffer) => ({ key, size: data.length, lastModified: new Date() })),
			read: vi.fn(async () => Buffer.from('PAR1 staged')),
			list: vi.fn(async () => []),
			stat: vi.fn(async () => null),
			exists: vi.fn(async () => false),
			delete: vi.fn(async () => {}),
			healthCheck: vi.fn(async () => ({ ok: true })),
		};
		vi.mocked(getStorage).mockReturnValue(remote);
		mockPublished([{ slug: 'catalog', runId: 'run-1' }]);
		webRobotQueries.getPublishedWebDatasetBySlug.mockImplementation(async () => publishedRow('catalog', 'run-2'));

		const access = await openPublishedProjectDatasetFiles('proj-1', ['catalog/latest/products.parquet']);
		try {
			expect(webRobotQueries.listPublishedWebDatasets).toHaveBeenCalledTimes(1);
			expect(webRobotQueries.getPublishedWebDatasetBySlug).not.toHaveBeenCalled();
			expect(remote.read).toHaveBeenCalledTimes(1);
			expect(remote.read).toHaveBeenCalledWith(
				'projects/proj-1/datasets/catalog/versions/run-1/products.parquet',
			);
			const realPath = access.realPathOf('catalog/latest/products.parquet');
			await expect(fs.readFile(realPath)).resolves.toEqual(Buffer.from('PAR1 staged'));
		} finally {
			await access.release();
		}
	});

	it('resolves grep locations for trusted rows only', async () => {
		mockPublished([
			{ slug: 'catalog', runId: 'run-1' },
			{ slug: 'beta', runId: 'run-9' },
		]);

		expect(await publishedProjectDatasetLocations('proj-1', '')).toEqual([
			{ requestedRelativePath: 'catalog/latest', storageRelativePath: 'catalog/versions/run-1' },
			{ requestedRelativePath: 'beta/latest', storageRelativePath: 'beta/versions/run-9' },
		]);
		expect(await publishedProjectDatasetLocations('proj-1', 'catalog')).toEqual([
			{ requestedRelativePath: 'catalog/latest', storageRelativePath: 'catalog/versions/run-1' },
		]);
		expect(await publishedProjectDatasetLocations('proj-1', 'catalog/latest/products.parquet')).toEqual([
			{
				requestedRelativePath: 'catalog/latest/products.parquet',
				storageRelativePath: 'catalog/versions/run-1/products.parquet',
			},
		]);
		await expect(publishedProjectDatasetLocations('proj-1', 'catalog/versions/run-1')).rejects.toThrow(
			'Only trusted /latest web datasets are available to agents.',
		);
	});

	it('supports a trusted robot slugged versions', async () => {
		mockPublished([{ slug: 'versions', runId: 'run-1' }]);

		expect(await publishedProjectDatasetLocations('proj-1', 'versions/latest/products.parquet')).toEqual([
			{
				requestedRelativePath: 'versions/latest/products.parquet',
				storageRelativePath: 'versions/versions/run-1/products.parquet',
			},
		]);
		expect(await publishedProjectDatasetLocations('proj-1', 'versions')).toEqual([
			{ requestedRelativePath: 'versions/latest', storageRelativePath: 'versions/versions/run-1' },
		]);
	});

	it('maps generated files to local paths for DuckDB', async () => {
		await writeProjectDataset('proj-1', 'catalog/versions/run-1/products.parquet', Buffer.from('PAR1 test'));
		mockPublished([{ slug: 'catalog', runId: 'run-1' }]);
		const access = await openProjectDatasetFiles('proj-1', ['catalog/latest/products.parquet']);

		try {
			const realPath = access.realPathOf('catalog/latest/products.parquet');
			expect(realPath).toContain(path.join('projects', 'proj-1', 'datasets'));
			await expect(fs.readFile(realPath)).resolves.toEqual(Buffer.from('PAR1 test'));
		} finally {
			await access.release();
		}
	});
});
