import type { CatalogueCurrentState, CatalogueGranularity, CatalogueTrustSummary } from '@nao/shared/web-robot-trust';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';

import s, {
	type DBScheduledJob,
	type DBWebRobot,
	type DBWebRobotConfiguration,
	type DBWebRobotRun,
	type NewWebRobot,
	type NewWebRobotConfiguration,
	type NewWebRobotRun,
} from '../db/abstractSchema';
import { db } from '../db/db';
import {
	WEB_ROBOT_ACTIVE_RUN_STATUSES,
	type WebRobotExecutionStatus,
	type WebRobotPublicationStatus,
	type WebRobotRunStatus,
	type WebRobotTrustBasis,
	type WebRobotTrustStatus,
} from '../types/web-robot';

export type WebRobotWithSchedule = DBWebRobot & {
	cron: string | null;
	enabled: boolean;
	scheduledJob: DBScheduledJob | null;
};

export type WebRobotCurrentState = CatalogueCurrentState;

export type WebRobotListItem = WebRobotWithSchedule & {
	lastRunStatus: DBWebRobotRun['status'] | null;
	lastRunStartedAt: Date | null;
	currentState: WebRobotCurrentState;
};

export type CompleteWebRobotTrustInput = {
	executionStatus: Exclude<WebRobotExecutionStatus, 'queued' | 'running'>;
	trustStatus: WebRobotTrustStatus | null;
	trustBasis: WebRobotTrustBasis | null;
	trustSummary: CatalogueTrustSummary | null;
	publicationStatus: WebRobotPublicationStatus;
	progress?: Record<string, unknown> | null;
	trustReportPath?: string | null;
	trustReportHash?: string | null;
	executionErrorMessage?: string | null;
	publicationErrorMessage?: string | null;
	artifactPrefix?: string | null;
	stats: NewWebRobotRun['stats'];
};

const WEB_ROBOT_RUN_STALE_MS = 6 * 60 * 60_000;
const WEB_ROBOT_RUN_STALE_MESSAGE = 'Web robot run did not finish before the stale-run timeout.';

export const failStaleWebRobotRuns = async (): Promise<number> => {
	const cutoff = new Date(Date.now() - WEB_ROBOT_RUN_STALE_MS);
	const rows = await db
		.update(s.webRobotRun)
		.set({
			status: 'failed',
			executionStatus: 'failed',
			errorMessage: WEB_ROBOT_RUN_STALE_MESSAGE,
			completedAt: new Date(),
		})
		.where(
			or(
				and(eq(s.webRobotRun.status, 'running'), lt(s.webRobotRun.startedAt, cutoff)),
				and(eq(s.webRobotRun.status, 'queued'), lt(s.webRobotRun.queuedAt, cutoff)),
			),
		)
		.returning({ id: s.webRobotRun.id })
		.execute();
	return rows.length;
};

export const listWebRobots = async (projectId: string): Promise<WebRobotListItem[]> => {
	await failStaleWebRobotRuns();
	const rows = await db
		.select({ robot: s.webRobot, scheduledJob: s.scheduledJob })
		.from(s.webRobot)
		.leftJoin(s.scheduledJob, eq(s.scheduledJob.id, s.webRobot.scheduledJobId))
		.where(and(eq(s.webRobot.projectId, projectId), isNull(s.webRobot.archivedAt)))
		.orderBy(desc(s.webRobot.updatedAt))
		.execute();

	return Promise.all(
		rows.map(async ({ robot, scheduledJob }) => ({
			...mapRobotWithSchedule(robot, scheduledJob),
			...(await latestRunSummary(robot)),
		})),
	);
};

export type PublishedWebDataset = DBWebRobot & {
	activeRun: DBWebRobotRun;
	activeConfiguration: DBWebRobotConfiguration;
};

const publishedWebDatasetQuery = () =>
	db
		.select({
			robot: s.webRobot,
			run: s.webRobotRun,
			configuration: s.webRobotConfiguration,
		})
		.from(s.webRobot)
		.innerJoin(
			s.webRobotRun,
			and(eq(s.webRobotRun.id, s.webRobot.lastPublishedRunId), eq(s.webRobotRun.robotId, s.webRobot.id)),
		)
		.innerJoin(
			s.webRobotConfiguration,
			and(
				eq(s.webRobotConfiguration.id, s.webRobot.activeConfigurationId),
				eq(s.webRobotConfiguration.robotId, s.webRobot.id),
				eq(s.webRobotRun.configurationId, s.webRobotConfiguration.id),
				eq(s.webRobotRun.configurationHash, s.webRobotConfiguration.configurationHash),
			),
		);

const publishedWebDatasetConditions = (projectId: string) =>
	and(
		eq(s.webRobot.projectId, projectId),
		isNull(s.webRobot.archivedAt),
		isNotNull(s.webRobot.lastPublishedRunId),
		isNotNull(s.webRobot.activeConfigurationId),
		eq(s.webRobotRun.executionStatus, 'succeeded'),
		eq(s.webRobotRun.trustStatus, 'ready'),
		eq(s.webRobotRun.publicationStatus, 'published'),
		isNotNull(s.webRobotRun.trustSummary),
		isNotNull(s.webRobotRun.trustReportPath),
		isNotNull(s.webRobotRun.trustReportHash),
		eq(s.webRobotConfiguration.status, 'active'),
	);

export const getPublishedWebDatasetBySlug = async (
	projectId: string,
	slug: string,
): Promise<PublishedWebDataset | null> => {
	const [row] = await publishedWebDatasetQuery()
		.where(and(publishedWebDatasetConditions(projectId), eq(s.webRobot.slug, slug)))
		.execute();
	return row ? { ...row.robot, activeRun: row.run, activeConfiguration: row.configuration } : null;
};

export const listPublishedWebDatasets = async (projectId: string): Promise<PublishedWebDataset[]> => {
	const rows = await publishedWebDatasetQuery()
		.where(publishedWebDatasetConditions(projectId))
		.orderBy(s.webRobot.name)
		.execute();
	return rows.map((row) => ({ ...row.robot, activeRun: row.run, activeConfiguration: row.configuration }));
};

export type AgentWebDataset = PublishedWebDataset & {
	latestRun: DBWebRobotRun;
	currentState: CatalogueCurrentState;
};

export const listAgentWebDatasets = async (projectId: string): Promise<AgentWebDataset[]> => {
	const published = await listPublishedWebDatasets(projectId);
	return Promise.all(
		published.map(async (row) => {
			const [latestRun] = await db
				.select()
				.from(s.webRobotRun)
				.where(eq(s.webRobotRun.robotId, row.id))
				.orderBy(desc(s.webRobotRun.queuedAt))
				.limit(1)
				.execute();
			const latest = latestRun ?? row.activeRun;
			return { ...row, latestRun: latest, currentState: projectWebRobotCurrentState(row, latest, row.activeRun) };
		}),
	);
};

export const getWebRobot = async (projectId: string, id: string): Promise<WebRobotWithSchedule | null> => {
	const [row] = await db
		.select({ robot: s.webRobot, scheduledJob: s.scheduledJob })
		.from(s.webRobot)
		.leftJoin(s.scheduledJob, eq(s.scheduledJob.id, s.webRobot.scheduledJobId))
		.where(and(eq(s.webRobot.id, id), eq(s.webRobot.projectId, projectId), isNull(s.webRobot.archivedAt)))
		.execute();
	return row ? mapRobotWithSchedule(row.robot, row.scheduledJob) : null;
};

export type WebRobotDetail = WebRobotWithSchedule & {
	activeConfiguration: DBWebRobotConfiguration | null;
	pendingConfiguration: DBWebRobotConfiguration | null;
	currentState: CatalogueCurrentState;
};

export const getWebRobotDetail = async (projectId: string, id: string): Promise<WebRobotDetail | null> => {
	const robot = await getWebRobot(projectId, id);
	if (!robot) {
		return null;
	}
	const [activeConfiguration, pendingConfiguration, [latestRun]] = await Promise.all([
		getActiveWebRobotConfiguration(robot.id),
		getPendingWebRobotConfiguration(robot.id),
		db
			.select()
			.from(s.webRobotRun)
			.where(eq(s.webRobotRun.robotId, robot.id))
			.orderBy(desc(s.webRobotRun.queuedAt))
			.limit(1)
			.execute(),
	]);
	const activeRun = robot.lastPublishedRunId
		? ((await db.select().from(s.webRobotRun).where(eq(s.webRobotRun.id, robot.lastPublishedRunId)).execute())[0] ??
			null)
		: null;
	return {
		...robot,
		activeConfiguration,
		pendingConfiguration,
		currentState: projectWebRobotCurrentState(robot, latestRun ?? null, activeRun),
	};
};

export const getWebRobotById = async (id: string): Promise<WebRobotWithSchedule | null> => {
	const [row] = await db
		.select({ robot: s.webRobot, scheduledJob: s.scheduledJob })
		.from(s.webRobot)
		.leftJoin(s.scheduledJob, eq(s.scheduledJob.id, s.webRobot.scheduledJobId))
		.where(and(eq(s.webRobot.id, id), isNull(s.webRobot.archivedAt)))
		.execute();
	return row ? mapRobotWithSchedule(row.robot, row.scheduledJob) : null;
};

export const createWebRobot = async (data: NewWebRobot): Promise<DBWebRobot> => {
	const [created] = await db.insert(s.webRobot).values(data).returning().execute();
	return created;
};

export const updateWebRobot = async (
	projectId: string,
	id: string,
	data: Partial<
		Pick<
			NewWebRobot,
			'name' | 'description' | 'definition' | 'definitionVersion' | 'definitionHash' | 'scheduledJobId'
		>
	>,
): Promise<DBWebRobot | null> => {
	const [updated] = await db
		.update(s.webRobot)
		.set(data)
		.where(and(eq(s.webRobot.id, id), eq(s.webRobot.projectId, projectId), isNull(s.webRobot.archivedAt)))
		.returning()
		.execute();
	return updated ?? null;
};

export const archiveWebRobot = async (projectId: string, id: string): Promise<DBWebRobot | null> => {
	const [archived] = await db
		.update(s.webRobot)
		.set({ archivedAt: new Date() })
		.where(and(eq(s.webRobot.id, id), eq(s.webRobot.projectId, projectId), isNull(s.webRobot.archivedAt)))
		.returning()
		.execute();
	return archived ?? null;
};

export const markWebRobotPublish = async (
	id: string,
	runId: string,
	productCount: number,
	completedAt: Date,
): Promise<void> => {
	await db
		.update(s.webRobot)
		.set({ lastSuccessfulRunId: runId, lastSuccessfulRunAt: completedAt, lastPublishedProductCount: productCount })
		.where(eq(s.webRobot.id, id))
		.execute();
};

export const createWebRobotRun = async (data: NewWebRobotRun): Promise<DBWebRobotRun> => {
	const [created] = await db.insert(s.webRobotRun).values(data).returning().execute();
	return created;
};

export const getWebRobotRun = async (projectId: string, id: string): Promise<DBWebRobotRun | null> => {
	await failStaleWebRobotRuns();
	const [row] = await db
		.select({ run: s.webRobotRun })
		.from(s.webRobotRun)
		.innerJoin(s.webRobot, eq(s.webRobot.id, s.webRobotRun.robotId))
		.where(and(eq(s.webRobotRun.id, id), eq(s.webRobot.projectId, projectId)))
		.execute();
	return row?.run ?? null;
};

export const getWebRobotRunById = async (id: string): Promise<DBWebRobotRun | null> => {
	const [run] = await db.select().from(s.webRobotRun).where(eq(s.webRobotRun.id, id)).execute();
	return run ?? null;
};

export const listWebRobotRuns = async (projectId: string, robotId: string, limit = 20): Promise<DBWebRobotRun[]> => {
	await failStaleWebRobotRuns();
	const rows = await db
		.select({ run: s.webRobotRun })
		.from(s.webRobotRun)
		.innerJoin(s.webRobot, eq(s.webRobot.id, s.webRobotRun.robotId))
		.where(and(eq(s.webRobotRun.robotId, robotId), eq(s.webRobot.projectId, projectId)))
		.orderBy(desc(s.webRobotRun.queuedAt))
		.limit(limit)
		.execute();
	return rows.map((row) => row.run);
};

export const findActiveWebRobotRun = async (robotId: string): Promise<DBWebRobotRun | null> => {
	return (await listActiveWebRobotRuns(robotId, 1))[0] ?? null;
};

export const listActiveWebRobotRuns = async (robotId: string, limit = 20): Promise<DBWebRobotRun[]> => {
	return db
		.select()
		.from(s.webRobotRun)
		.where(and(eq(s.webRobotRun.robotId, robotId), inArray(s.webRobotRun.status, WEB_ROBOT_ACTIVE_RUN_STATUSES)))
		.orderBy(desc(s.webRobotRun.queuedAt))
		.limit(limit)
		.execute();
};

export const setWebRobotRunScheduledJob = async (id: string, scheduledJobId: string | null): Promise<void> => {
	await db.update(s.webRobotRun).set({ scheduledJobId }).where(eq(s.webRobotRun.id, id)).execute();
};

export const markWebRobotRunRunning = async (id: string): Promise<DBWebRobotRun | null> => {
	const [run] = await db
		.update(s.webRobotRun)
		.set({ status: 'running', executionStatus: 'running', startedAt: new Date() })
		.where(and(eq(s.webRobotRun.id, id), eq(s.webRobotRun.status, 'queued')))
		.returning()
		.execute();
	return run ?? null;
};

export const completeWebRobotRun = async (
	id: string,
	status: Extract<WebRobotRunStatus, 'completed' | 'partial' | 'failed' | 'cancelled'>,
	stats: NewWebRobotRun['stats'],
	errorMessage: string | null,
	artifactPrefix?: string | null,
): Promise<void> => {
	const executionStatus =
		status === 'completed' || status === 'partial' ? 'succeeded' : status === 'failed' ? 'failed' : 'cancelled';
	await db
		.update(s.webRobotRun)
		.set({ status, executionStatus, stats, errorMessage, artifactPrefix, completedAt: new Date() })
		.where(eq(s.webRobotRun.id, id))
		.execute();
};

export const requestWebRobotRunCancel = async (id: string): Promise<void> => {
	await db
		.update(s.webRobotRun)
		.set({ cancelRequestedAt: new Date() })
		.where(and(eq(s.webRobotRun.id, id), inArray(s.webRobotRun.status, WEB_ROBOT_ACTIVE_RUN_STATUSES)))
		.execute();
};

export const cancelQueuedWebRobotRun = async (id: string): Promise<void> => {
	await db
		.update(s.webRobotRun)
		.set({
			status: 'cancelled',
			executionStatus: 'cancelled',
			completedAt: new Date(),
			errorMessage: 'Cancelled before the run started.',
		})
		.where(and(eq(s.webRobotRun.id, id), eq(s.webRobotRun.status, 'queued')))
		.execute();
};

export const projectWebRobotCurrentState = (
	robot: DBWebRobot,
	latestRun: DBWebRobotRun | null,
	activeRun: DBWebRobotRun | null,
): CatalogueCurrentState => {
	const state: CatalogueCurrentState = {
		setupStatus: robot.activeConfigurationId || robot.pendingConfigurationId ? 'configured' : 'needs_input',
		latestRefreshFailed: false,
	};
	if (latestRun) {
		state.executionStatus = latestRun.executionStatus;
		if (latestRun.trustStatus) {
			state.trustStatus = latestRun.trustStatus;
		}
		if (latestRun.trustBasis) {
			state.trustBasis = latestRun.trustBasis;
		}
		if (latestRun.publicationStatus) {
			state.publicationStatus = latestRun.publicationStatus;
		}
		if (
			latestRun.executionStatus === 'queued' ||
			latestRun.executionStatus === 'running' ||
			latestRun.publicationStatus === 'pending'
		) {
			state.pendingRunId = latestRun.id;
		}
	}
	if (robot.lastPublishedRunId) {
		state.activeRunId = robot.lastPublishedRunId;
	}
	if (activeRun?.trustSummary) {
		state.activeSummary = activeRun.trustSummary;
	}
	if (latestRun?.trustSummary && latestRun.id !== robot.lastPublishedRunId) {
		state.latestSummary = latestRun.trustSummary;
	}
	if (
		activeRun &&
		robot.lastPublishedRunId &&
		latestRun &&
		latestRun.id !== robot.lastPublishedRunId &&
		(latestRun.executionStatus === 'failed' ||
			latestRun.trustStatus === 'needs_attention' ||
			latestRun.publicationStatus === 'retained_previous' ||
			latestRun.publicationStatus === 'publication_failed')
	) {
		state.latestRefreshFailed = true;
	}
	return state;
};

export const createWebRobotConfiguration = async (data: NewWebRobotConfiguration): Promise<DBWebRobotConfiguration> => {
	const [created] = await db.insert(s.webRobotConfiguration).values(data).returning().execute();
	return created;
};

export const getWebRobotConfiguration = async (
	robotId: string,
	id: string,
): Promise<DBWebRobotConfiguration | null> => {
	const [row] = await db
		.select()
		.from(s.webRobotConfiguration)
		.where(and(eq(s.webRobotConfiguration.id, id), eq(s.webRobotConfiguration.robotId, robotId)))
		.execute();
	return row ?? null;
};

export const getActiveWebRobotConfiguration = async (robotId: string): Promise<DBWebRobotConfiguration | null> => {
	const [row] = await db
		.select({ configuration: s.webRobotConfiguration })
		.from(s.webRobot)
		.innerJoin(
			s.webRobotConfiguration,
			and(
				eq(s.webRobotConfiguration.id, s.webRobot.activeConfigurationId),
				eq(s.webRobotConfiguration.robotId, s.webRobot.id),
			),
		)
		.where(eq(s.webRobot.id, robotId))
		.execute();
	return row?.configuration ?? null;
};

export const getPendingWebRobotConfiguration = async (robotId: string): Promise<DBWebRobotConfiguration | null> => {
	const [row] = await db
		.select({ configuration: s.webRobotConfiguration })
		.from(s.webRobot)
		.innerJoin(
			s.webRobotConfiguration,
			and(
				eq(s.webRobotConfiguration.id, s.webRobot.pendingConfigurationId),
				eq(s.webRobotConfiguration.robotId, s.webRobot.id),
			),
		)
		.where(eq(s.webRobot.id, robotId))
		.execute();
	return row?.configuration ?? null;
};

export const createPendingWebRobotConfiguration = async (
	data: Omit<NewWebRobotConfiguration, 'status'>,
): Promise<DBWebRobotConfiguration> => {
	return db.transaction(async (tx) => {
		const [robot] = await tx.select().from(s.webRobot).where(eq(s.webRobot.id, data.robotId)).execute();
		if (!robot) {
			throw new Error(`Web robot '${data.robotId}' not found.`);
		}
		const [existing] = await tx
			.select()
			.from(s.webRobotConfiguration)
			.where(
				and(
					eq(s.webRobotConfiguration.robotId, data.robotId),
					eq(s.webRobotConfiguration.configurationHash, data.configurationHash),
				),
			)
			.execute();
		if (existing) {
			const isActive = existing.id === robot.activeConfigurationId;
			if (!isActive) {
				await tx
					.update(s.webRobotConfiguration)
					.set({ status: 'draft' })
					.where(eq(s.webRobotConfiguration.id, existing.id))
					.execute();
			}
			if (
				robot.pendingConfigurationId &&
				robot.pendingConfigurationId !== robot.activeConfigurationId &&
				robot.pendingConfigurationId !== existing.id
			) {
				await tx
					.update(s.webRobotConfiguration)
					.set({ status: 'superseded' })
					.where(eq(s.webRobotConfiguration.id, robot.pendingConfigurationId))
					.execute();
			}
			await tx
				.update(s.webRobot)
				.set({ pendingConfigurationId: existing.id })
				.where(eq(s.webRobot.id, robot.id))
				.execute();
			return { ...existing, status: isActive ? 'active' : 'draft' };
		}
		if (robot.pendingConfigurationId && robot.pendingConfigurationId !== robot.activeConfigurationId) {
			await tx
				.update(s.webRobotConfiguration)
				.set({ status: 'superseded' })
				.where(eq(s.webRobotConfiguration.id, robot.pendingConfigurationId))
				.execute();
		}
		const [created] = await tx
			.insert(s.webRobotConfiguration)
			.values({ ...data, status: 'draft' })
			.returning()
			.execute();
		await tx
			.update(s.webRobot)
			.set({ pendingConfigurationId: created.id })
			.where(eq(s.webRobot.id, robot.id))
			.execute();
		return created;
	});
};

export const updateWebRobotRunProgress = async (id: string, progress: Record<string, unknown>): Promise<void> => {
	await db.update(s.webRobotRun).set({ progress }).where(eq(s.webRobotRun.id, id)).execute();
};

export const completeWebRobotTrustEvaluation = async (id: string, input: CompleteWebRobotTrustInput): Promise<void> => {
	const status: WebRobotRunStatus =
		input.executionStatus === 'succeeded'
			? input.trustStatus === 'ready'
				? 'completed'
				: 'partial'
			: input.executionStatus === 'failed'
				? 'failed'
				: 'cancelled';
	const completedAt = new Date();
	await db.transaction(async (tx) => {
		const [run] = await tx
			.update(s.webRobotRun)
			.set({
				status,
				executionStatus: input.executionStatus,
				trustStatus: input.trustStatus,
				trustBasis: input.trustBasis,
				trustSummary: input.trustSummary,
				publicationStatus: input.publicationStatus,
				progress: input.progress ?? null,
				trustReportPath: input.trustReportPath ?? null,
				trustReportHash: input.trustReportHash ?? null,
				errorMessage: input.executionErrorMessage ?? input.publicationErrorMessage ?? null,
				executionErrorMessage: input.executionErrorMessage ?? null,
				publicationErrorMessage: input.publicationErrorMessage ?? null,
				artifactPrefix: input.artifactPrefix ?? null,
				stats: input.stats,
				completedAt,
			})
			.where(eq(s.webRobotRun.id, id))
			.returning()
			.execute();
		if (!run) {
			throw new Error(`Web robot run '${id}' not found.`);
		}
		if (input.executionStatus === 'succeeded' && input.trustStatus === 'ready') {
			await tx
				.update(s.webRobot)
				.set({ lastVerifiedRunId: run.id, lastVerifiedRunAt: completedAt })
				.where(eq(s.webRobot.id, run.robotId))
				.execute();
		}
	});
};

export const isWebRobotRunPublishable = (
	run: DBWebRobotRun,
	configuration: DBWebRobotConfiguration,
	input: { productCount: number; entityUnit: CatalogueGranularity },
): boolean =>
	run.executionStatus === 'succeeded' &&
	run.trustStatus === 'ready' &&
	run.publicationStatus === 'pending' &&
	run.trustSummary?.status === 'ready' &&
	run.trustSummary.basis !== 'none' &&
	run.trustSummary.blockerCodes.length === 0 &&
	run.trustSummary.entityCount === input.productCount &&
	run.trustSummary.granularity === input.entityUnit &&
	run.configurationId === configuration.id &&
	run.configurationHash === configuration.configurationHash &&
	Boolean(run.trustReportPath) &&
	Boolean(run.trustReportHash);

export const activateWebRobotPublication = async (input: {
	robotId: string;
	runId: string;
	configurationId: string;
	productCount: number;
	entityUnit: CatalogueGranularity;
	completedAt: Date;
}): Promise<DBWebRobot> => {
	return db.transaction(async (tx) => {
		const [robot] = await tx.select().from(s.webRobot).where(eq(s.webRobot.id, input.robotId)).execute();
		const [run] = await tx.select().from(s.webRobotRun).where(eq(s.webRobotRun.id, input.runId)).execute();
		const [configuration] = await tx
			.select()
			.from(s.webRobotConfiguration)
			.where(eq(s.webRobotConfiguration.id, input.configurationId))
			.execute();
		if (!robot || !run || !configuration || run.robotId !== robot.id || configuration.robotId !== robot.id) {
			throw new Error('Web robot publication requires a matching robot, run, and configuration.');
		}
		if (robot.lastPublishedRunId === run.id && run.publicationStatus === 'published') {
			return robot;
		}
		if (configuration.status !== 'draft' && configuration.status !== 'active') {
			throw new Error('Web robot publication requires a draft or active configuration.');
		}
		if (!isWebRobotRunPublishable(run, configuration, input)) {
			throw new Error('Web robot run is not a verified, publishable run for the target configuration.');
		}
		if (robot.activeConfigurationId && robot.activeConfigurationId !== configuration.id) {
			await tx
				.update(s.webRobotConfiguration)
				.set({ status: 'superseded' })
				.where(eq(s.webRobotConfiguration.id, robot.activeConfigurationId))
				.execute();
		}
		await tx
			.update(s.webRobotConfiguration)
			.set({ status: 'active' })
			.where(eq(s.webRobotConfiguration.id, configuration.id))
			.execute();
		const [updated] = await tx
			.update(s.webRobot)
			.set({
				definition: configuration.recipe,
				definitionVersion: configuration.recipeVersion,
				definitionHash: configuration.recipeHash,
				activeConfigurationId: configuration.id,
				pendingConfigurationId:
					robot.pendingConfigurationId === configuration.id ? null : robot.pendingConfigurationId,
				lastVerifiedRunId: run.id,
				lastVerifiedRunAt: input.completedAt,
				lastPublishedRunId: run.id,
				lastPublishedRunAt: input.completedAt,
				lastPublishedEntityCount: input.productCount,
				lastPublishedEntityUnit: input.entityUnit,
				lastSuccessfulRunId: run.id,
				lastSuccessfulRunAt: input.completedAt,
				lastPublishedProductCount: input.productCount,
			})
			.where(eq(s.webRobot.id, robot.id))
			.returning()
			.execute();
		await tx
			.update(s.webRobotRun)
			.set({ publicationStatus: 'published', publicationErrorMessage: null })
			.where(eq(s.webRobotRun.id, run.id))
			.execute();
		return updated;
	});
};

export const listProtectedWebRobotArtifactRunIds = async (robotId: string): Promise<string[]> => {
	const [robot] = await db.select().from(s.webRobot).where(eq(s.webRobot.id, robotId)).execute();
	const pending = await db
		.select({ id: s.webRobotRun.id })
		.from(s.webRobotRun)
		.where(
			and(
				eq(s.webRobotRun.robotId, robotId),
				or(
					inArray(s.webRobotRun.executionStatus, ['queued', 'running']),
					eq(s.webRobotRun.publicationStatus, 'pending'),
				),
			),
		)
		.execute();
	return [
		...new Set(
			[robot?.lastPublishedRunId, robot?.lastVerifiedRunId, ...pending.map((row) => row.id)].filter(
				(id): id is string => Boolean(id),
			),
		),
	];
};

export const markWebRobotPublicationFailed = async (runId: string, message: string): Promise<void> => {
	await db
		.update(s.webRobotRun)
		.set({ publicationStatus: 'publication_failed', publicationErrorMessage: message, errorMessage: message })
		.where(eq(s.webRobotRun.id, runId))
		.execute();
};

const latestRunSummary = async (
	robot: DBWebRobot,
): Promise<Pick<WebRobotListItem, 'lastRunStatus' | 'lastRunStartedAt' | 'currentState'>> => {
	const [latestRun] = await db
		.select()
		.from(s.webRobotRun)
		.where(eq(s.webRobotRun.robotId, robot.id))
		.orderBy(desc(s.webRobotRun.queuedAt))
		.limit(1)
		.execute();
	const activeRun = robot.lastPublishedRunId
		? ((await db.select().from(s.webRobotRun).where(eq(s.webRobotRun.id, robot.lastPublishedRunId)).execute())[0] ??
			null)
		: null;
	return {
		lastRunStatus: latestRun?.status ?? null,
		lastRunStartedAt: latestRun?.startedAt ?? latestRun?.queuedAt ?? null,
		currentState: projectWebRobotCurrentState(robot, latestRun ?? null, activeRun),
	};
};

const mapRobotWithSchedule = (robot: DBWebRobot, scheduledJob: DBScheduledJob | null): WebRobotWithSchedule => ({
	...robot,
	cron: scheduledJob?.cron ?? null,
	enabled: scheduledJob?.status === 'pending',
	scheduledJob,
});
