import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { documentMediaType } from '@nao/shared/attachments';

import { toReadableText } from '../file-text';
import { getStorage, isStorageEnabled, STORAGE_DISABLED_MESSAGE } from '.';
import type { StorageFileAccess } from './file-access';
import { projectDatasetKey, projectDatasetRelativePathFromKey, projectDatasetRoot, sanitizeRelativePath } from './keys';
import { LocalStorageProvider } from './local.provider';
import type { StorageObject } from './types';
import type { StorageDirectoryEntry } from './user-files';

export type ResolvedProjectDatasetPath = {
	requestedRelativePath: string;
	storageRelativePath: string;
};

const AGENT_DATASET_MESSAGE = 'Only trusted /latest web datasets are available to agents.';

export const resolveProjectDatasetPath = async (
	projectId: string,
	relativePath: string,
): Promise<ResolvedProjectDatasetPath> => {
	const requestedRelativePath = sanitizeRelativePath(relativePath);
	const alias = latestAliasParts(requestedRelativePath);
	if (!alias) {
		return { requestedRelativePath, storageRelativePath: requestedRelativePath };
	}
	const webRobotQueries = await import('../../queries/web-robot.queries');
	const published = await webRobotQueries.getPublishedWebDatasetBySlug(projectId, alias.slug);
	if (!published) {
		throw new Error(`No trusted published dataset exists for '${alias.slug}'.`);
	}
	const versionRoot = `${alias.slug}/versions/${published.activeRun.id}`;
	return {
		requestedRelativePath,
		storageRelativePath: alias.suffix ? `${versionRoot}/${alias.suffix}` : versionRoot,
	};
};

export const readProjectDataset = async (projectId: string, relativePath: string): Promise<string> => {
	return toReadableText(relativePath, await readProjectDatasetBytes(projectId, relativePath));
};

export const readProjectDatasetBytes = async (projectId: string, relativePath: string): Promise<Buffer> => {
	const resolved = await resolveProjectDatasetPath(projectId, relativePath);
	const key = projectDatasetKey(projectId, resolved.storageRelativePath);
	try {
		return await getStorage().read(key);
	} catch (error) {
		if (isMissing(error)) {
			throw new Error(`No such project dataset file: ${resolved.requestedRelativePath}`);
		}
		throw error;
	}
};

export const writeProjectDataset = async (
	projectId: string,
	relativePath: string,
	data: string | Buffer,
): Promise<StorageObject> => {
	const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
	return getStorage().write(projectDatasetKey(projectId, relativePath), bytes, {
		contentType: documentMediaType(relativePath) ?? 'application/octet-stream',
	});
};

export const statProjectDataset = async (projectId: string, relativePath: string): Promise<StorageObject | null> => {
	const resolved = await resolveProjectDatasetPath(projectId, relativePath);
	const object = await getStorage().stat(projectDatasetKey(projectId, resolved.storageRelativePath));
	if (object && resolved.storageRelativePath !== resolved.requestedRelativePath) {
		return { ...object, key: projectDatasetKey(projectId, resolved.requestedRelativePath) };
	}
	return object;
};

export const deleteProjectDataset = async (projectId: string, relativePath: string): Promise<void> => {
	await getStorage().delete(projectDatasetKey(projectId, relativePath));
};

export const canGrepProjectDatasets = (): boolean => {
	return isStorageEnabled() && getStorage() instanceof LocalStorageProvider;
};

export const grepRootForProjectDatasets = (projectId: string, relativePath = ''): string => {
	const storage = getStorage();
	if (!(storage instanceof LocalStorageProvider)) {
		throw new Error('Searching generated dataset contents requires the `local` storage backend.');
	}
	return storage.toFilePath(
		relativePath ? projectDatasetKey(projectId, relativePath) : projectDatasetRoot(projectId),
	);
};

export const findProjectDatasetFiles = async (
	projectId: string,
	predicate: (relativePath: string) => boolean,
): Promise<StorageObject[]> => {
	const objects = await getStorage().list(projectDatasetRoot(projectId));
	return objects.filter((object) => predicate(projectDatasetRelativePathFromKey(projectId, object.key)));
};

export const listProjectDatasetDirectory = async (
	projectId: string,
	relativeDir: string,
): Promise<StorageDirectoryEntry[]> => {
	const resolved = relativeDir === '' ? null : await resolveProjectDatasetPath(projectId, relativeDir);
	const storageDir = resolved ? resolved.storageRelativePath : relativeDir;
	const entries = await listDatasetDirectory(projectId, storageDir);
	if (!resolved || resolved.storageRelativePath === resolved.requestedRelativePath) {
		return entries;
	}
	return entries.map((entry) => ({
		...entry,
		relativePath: `${resolved.requestedRelativePath}${entry.relativePath.slice(resolved.storageRelativePath.length)}`,
	}));
};

const listDatasetDirectory = async (projectId: string, relativeDir: string): Promise<StorageDirectoryEntry[]> => {
	const base = relativeDir === '' ? '' : `${relativeDir}/`;
	const objects = await getStorage().list(
		relativeDir === '' ? projectDatasetRoot(projectId) : projectDatasetKey(projectId, relativeDir),
	);

	const files: StorageDirectoryEntry[] = [];
	const directoryChildren = new Map<string, Set<string>>();

	for (const object of objects) {
		const relativePath = projectDatasetRelativePathFromKey(projectId, object.key);
		if (!relativePath.startsWith(base)) {
			continue;
		}

		const [name, ...rest] = relativePath.slice(base.length).split('/');
		if (!name) {
			continue;
		}
		if (rest.length === 0) {
			files.push({ name, relativePath, type: 'file', size: object.size });
			continue;
		}

		const children = directoryChildren.get(name) ?? new Set<string>();
		children.add(rest[0]!);
		directoryChildren.set(name, children);
	}

	const directories = [...directoryChildren].map(([name, children]) => ({
		name,
		relativePath: `${base}${name}`,
		type: 'directory' as const,
		itemCount: children.size,
	}));

	return [...sortByName(directories), ...sortByName(files)];
};

export const openProjectDatasetFiles = async (
	projectId: string,
	relativePaths: string[],
): Promise<StorageFileAccess> => {
	if (!isStorageEnabled()) {
		throw new Error(STORAGE_DISABLED_MESSAGE);
	}

	const resolutions = await resolveProjectDatasetPaths(projectId, relativePaths);

	const storage = getStorage();
	if (storage instanceof LocalStorageProvider) {
		for (const [relativePath, resolved] of resolutions) {
			if (hasGlob(relativePath)) {
				continue;
			}
			if (!(await getStorage().stat(projectDatasetKey(projectId, resolved.storageRelativePath)))) {
				throw new Error(`No such project dataset file: ${relativePath}`);
			}
		}
		return {
			realPathOf: (relativePath) =>
				storage.toFilePath(
					projectDatasetKey(projectId, resolutions.get(relativePath)?.storageRelativePath ?? relativePath),
				),
			directory: storage.toFilePath(projectDatasetRoot(projectId)),
			release: async () => {},
		};
	}

	return stageDatasetFiles(projectId, resolutions);
};

export const readPublishedProjectDataset = async (projectId: string, relativePath: string): Promise<string> => {
	assertLatestAlias(relativePath);
	return readProjectDataset(projectId, relativePath);
};

export const listPublishedProjectDatasetDirectory = async (
	projectId: string,
	relativeDir: string,
): Promise<StorageDirectoryEntry[]> => {
	const trimmed = relativeDir.replace(/^\/+|\/+$/g, '');
	if (trimmed === '') {
		const webRobotQueries = await import('../../queries/web-robot.queries');
		const published = await webRobotQueries.listPublishedWebDatasets(projectId);
		return published
			.map((row) => ({
				name: row.slug,
				relativePath: row.slug,
				type: 'directory' as const,
				itemCount: 1,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}
	const parts = trimmed.split('/');
	if (parts.length === 1 && parts[0]) {
		const webRobotQueries = await import('../../queries/web-robot.queries');
		const published = await webRobotQueries.getPublishedWebDatasetBySlug(projectId, parts[0]);
		if (!published) {
			throw new Error(`No trusted published dataset exists for '${parts[0]}'.`);
		}
		return [{ name: 'latest', relativePath: `${parts[0]}/latest`, type: 'directory', itemCount: 1 }];
	}
	assertLatestAlias(trimmed);
	return listProjectDatasetDirectory(projectId, trimmed);
};

export const findPublishedProjectDatasetFiles = async (
	projectId: string,
	predicate: (relativePath: string) => boolean,
): Promise<StorageObject[]> => {
	const webRobotQueries = await import('../../queries/web-robot.queries');
	const published = await webRobotQueries.listPublishedWebDatasets(projectId);
	const objects: StorageObject[] = [];
	for (const row of published) {
		const versionPrefix = `${row.slug}/versions/${row.activeRun.id}`;
		const stored = await getStorage().list(projectDatasetKey(projectId, versionPrefix));
		for (const object of stored) {
			const relativePath = projectDatasetRelativePathFromKey(projectId, object.key);
			if (!relativePath.startsWith(`${versionPrefix}/`)) {
				continue;
			}
			const virtualPath = `${row.slug}/latest${relativePath.slice(versionPrefix.length)}`;
			if (predicate(virtualPath)) {
				objects.push({ ...object, key: projectDatasetKey(projectId, virtualPath) });
			}
		}
	}
	return objects;
};

export const openPublishedProjectDatasetFiles = async (
	projectId: string,
	relativePaths: string[],
): Promise<StorageFileAccess> => {
	for (const relativePath of relativePaths) {
		assertLatestAlias(relativePath);
	}
	return openProjectDatasetFiles(projectId, relativePaths);
};

export const publishedProjectDatasetLocations = async (
	projectId: string,
	relativePath: string,
): Promise<ResolvedProjectDatasetPath[]> => {
	const webRobotQueries = await import('../../queries/web-robot.queries');
	const trimmed = relativePath.replace(/^\/+|\/+$/g, '');
	if (trimmed === '') {
		const published = await webRobotQueries.listPublishedWebDatasets(projectId);
		return published.map((row) => ({
			requestedRelativePath: `${row.slug}/latest`,
			storageRelativePath: `${row.slug}/versions/${row.activeRun.id}`,
		}));
	}
	const parts = trimmed.split('/');
	if (parts[1] === 'versions') {
		throw new Error(AGENT_DATASET_MESSAGE);
	}
	if (parts.length === 1 && parts[0]) {
		const published = await webRobotQueries.getPublishedWebDatasetBySlug(projectId, parts[0]);
		if (!published) {
			throw new Error(`No trusted published dataset exists for '${parts[0]}'.`);
		}
		return [
			{
				requestedRelativePath: `${parts[0]}/latest`,
				storageRelativePath: `${parts[0]}/versions/${published.activeRun.id}`,
			},
		];
	}
	assertLatestAlias(trimmed);
	return [await resolveProjectDatasetPath(projectId, trimmed)];
};

const resolveProjectDatasetPaths = async (
	projectId: string,
	relativePaths: string[],
): Promise<Map<string, ResolvedProjectDatasetPath>> => {
	const requested = new Map<string, string>();
	for (const relativePath of new Set(relativePaths)) {
		requested.set(relativePath, sanitizeRelativePath(relativePath));
	}

	if (![...requested.values()].some((path) => latestAliasParts(path))) {
		return new Map(
			[...requested].map(([relativePath, requestedRelativePath]) => [
				relativePath,
				{ requestedRelativePath, storageRelativePath: requestedRelativePath },
			]),
		);
	}

	const webRobotQueries = await import('../../queries/web-robot.queries');
	const published = await webRobotQueries.listPublishedWebDatasets(projectId);
	const activeRunBySlug = new Map(published.map((row) => [row.slug, row.activeRun.id]));

	const resolutions = new Map<string, ResolvedProjectDatasetPath>();
	for (const [relativePath, requestedRelativePath] of requested) {
		const alias = latestAliasParts(requestedRelativePath);
		if (!alias) {
			resolutions.set(relativePath, { requestedRelativePath, storageRelativePath: requestedRelativePath });
			continue;
		}
		const activeRunId = activeRunBySlug.get(alias.slug);
		if (!activeRunId) {
			throw new Error(`No trusted published dataset exists for '${alias.slug}'.`);
		}
		const versionRoot = `${alias.slug}/versions/${activeRunId}`;
		resolutions.set(relativePath, {
			requestedRelativePath,
			storageRelativePath: alias.suffix ? `${versionRoot}/${alias.suffix}` : versionRoot,
		});
	}
	return resolutions;
};

const stageDatasetFiles = async (
	projectId: string,
	resolutions: Map<string, ResolvedProjectDatasetPath>,
): Promise<StorageFileAccess> => {
	const directory = await mkdtemp(join(tmpdir(), 'nao-datasets-'));
	const stagedPaths = new Map<string, string>();

	try {
		for (const [relativePath, resolved] of resolutions) {
			assertNotGlob(relativePath);
			const stagedPath = join(directory, crypto.randomUUID(), basename(resolved.storageRelativePath));
			await mkdir(dirname(stagedPath), { recursive: true });
			let bytes: Buffer;
			try {
				bytes = await getStorage().read(projectDatasetKey(projectId, resolved.storageRelativePath));
			} catch (error) {
				if (isMissing(error)) {
					throw new Error(`No such project dataset file: ${resolved.requestedRelativePath}`);
				}
				throw error;
			}
			await writeFile(stagedPath, bytes);
			stagedPaths.set(relativePath, stagedPath);
		}
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}

	return {
		realPathOf: (relativePath) => {
			const stagedPath = stagedPaths.get(relativePath);
			if (!stagedPath) {
				throw new Error(`File was not staged from project datasets: ${relativePath}`);
			}
			return stagedPath;
		},
		directory,
		release: () => rm(directory, { recursive: true, force: true }),
	};
};

const latestAliasParts = (relativePath: string): { slug: string; suffix: string } | null => {
	const parts = relativePath.split('/');
	if (parts.length < 2 || parts[1] !== 'latest') {
		return null;
	}
	const slug = parts[0]!;
	return { slug, suffix: parts.slice(2).join('/') };
};

const assertLatestAlias = (relativePath: string): void => {
	const parts = relativePath.split('/').filter(Boolean);
	if (parts.length < 2 || parts[1] !== 'latest') {
		throw new Error(AGENT_DATASET_MESSAGE);
	}
};

const assertNotGlob = (relativePath: string): void => {
	if (hasGlob(relativePath)) {
		throw new Error(
			'Wildcards in project datasets only work on the local storage backend. Name each file instead.',
		);
	}
};

const hasGlob = (relativePath: string): boolean => /[*?[\]]/.test(relativePath);

const isMissing = (error: unknown): boolean => {
	const candidate = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
	return (
		candidate?.code === 'ENOENT' ||
		candidate?.name === 'NoSuchKey' ||
		candidate?.name === 'NotFound' ||
		candidate?.$metadata?.httpStatusCode === 404
	);
};

const sortByName = <T extends { name: string }>(entries: T[]): T[] => {
	return [...entries].sort((a, b) => a.name.localeCompare(b.name));
};
