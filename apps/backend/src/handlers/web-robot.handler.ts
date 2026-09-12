import { emptyWebRobotRunStats } from '@nao/shared/web-robot';

import type { DBScheduledJob, DBWebRobotRun } from '../db/abstractSchema';
import * as projectQueries from '../queries/project.queries';
import * as webRobotQueries from '../queries/web-robot.queries';
import { webRobotRunSnapshot } from '../services/web-robot';
import { webRobotRunArtifactPaths, writeWebRobotRunArtifacts } from '../services/web-robot-artifacts';
import { webRobotConfigurationHash } from '../services/web-robot-configuration';
import { reconcileCatalogueTrust } from '../services/web-robot-trust/reconcile';
import { runWebRobotVerification } from '../services/web-scraper/traversal';
import { logger, serializeError } from '../utils/logger';

export const WEB_ROBOT_JOB_NAME = 'web_robot.run';
export const webRobotJobUniqueKey = (robotId: string): string => `web_robot:${robotId}`;

type WebRobotJobPayload = {
	webRobotId?: string;
	runId?: string;
};

const activeRuns = new Map<string, AbortController>();

export const requestWebRobotCancellation = (runId: string): void => {
	activeRuns.get(runId)?.abort();
};

export const webRobotRunJob = async (payload: WebRobotJobPayload, job: DBScheduledJob): Promise<void> => {
	if (!payload.webRobotId) {
		throw new Error('Web robot job is missing webRobotId');
	}

	const robot = await webRobotQueries.getWebRobotById(payload.webRobotId);
	if (!robot) {
		throw new Error(`Web robot not found: ${payload.webRobotId}`);
	}

	await webRobotQueries.failStaleWebRobotRuns();
	const run = payload.runId
		? await webRobotQueries.getWebRobotRunById(payload.runId)
		: await createScheduledRun(robot.id, job.id);
	if (!run || run.robotId !== robot.id) {
		throw new Error(`Web robot run not found for robot ${robot.id}`);
	}
	if (run.status === 'cancelled') {
		return;
	}

	const active = await webRobotQueries.findActiveWebRobotRun(robot.id);
	if (active && active.id !== run.id) {
		await webRobotQueries.cancelQueuedWebRobotRun(run.id);
		throw new Error(`Web robot ${robot.id} already has an active run`);
	}

	const claimed = await webRobotQueries.markWebRobotRunRunning(run.id);
	if (!claimed) {
		return;
	}

	const abort = new AbortController();
	activeRuns.set(run.id, abort);
	try {
		if (
			!claimed.configurationId ||
			!claimed.configurationHash ||
			!claimed.scopeSnapshot ||
			!claimed.contractSnapshot ||
			!claimed.verificationPlanSnapshot
		) {
			throw new Error(
				'This web robot run has no valid verification configuration. Re-analyze the source before running it.',
			);
		}
		const configuration = await webRobotQueries.getWebRobotConfiguration(robot.id, claimed.configurationId);
		if (
			!configuration ||
			configuration.recipeHash !== claimed.definitionHash ||
			configuration.configurationHash !== claimed.configurationHash
		) {
			throw new Error(
				'This web robot run has no valid verification configuration. Re-analyze the source before running it.',
			);
		}
		const snapshotHash = webRobotConfigurationHash({
			recipe: claimed.definition,
			scope: claimed.scopeSnapshot,
			contract: claimed.contractSnapshot,
			verificationPlan: claimed.verificationPlanSnapshot,
			sourceAssessment: configuration.sourceAssessment,
			scopeEvidence: configuration.scopeEvidence,
			countSignals: configuration.countSignals,
		});
		if (snapshotHash !== claimed.configurationHash) {
			throw new Error(
				'This web robot run has no valid verification configuration. Re-analyze the source before running it.',
			);
		}

		const onProgress = createProgressWriter(run.id);
		const envVars = await projectQueries.getEnvVars(robot.projectId);
		const result = await runWebRobotVerification({
			recipe: claimed.definition,
			runId: run.id,
			env: envVars,
			signal: abort.signal,
			verificationPlan: claimed.verificationPlanSnapshot,
			countSignals: configuration.countSignals,
			entityGranularity: claimed.contractSnapshot.entityGranularity,
			onProgress,
		});
		const requested = await webRobotQueries.getWebRobotRunById(run.id);
		if (abort.signal.aborted || requested?.cancelRequestedAt) {
			throw new Error('Web robot run was cancelled');
		}
		const completedAt = new Date();
		const paths = webRobotRunArtifactPaths(robot.slug, run.id);
		const stagedResult = {
			...result,
			traversals: result.traversals.map((traversal) => ({
				...traversal,
				attempts: traversal.attempts.map((attempt) => ({
					...attempt,
					stepArtifactPath: paths.traversalStepsPath,
				})),
			})),
		};

		const previousRun = robot.lastPublishedRunId
			? await webRobotQueries.getWebRobotRunById(robot.lastPublishedRunId)
			: null;
		const report = reconcileCatalogueTrust({
			runId: run.id,
			configurationHash: claimed.configurationHash,
			scope: claimed.scopeSnapshot,
			contract: claimed.contractSnapshot,
			verificationPlan: claimed.verificationPlanSnapshot,
			sourceAssessment: configuration.sourceAssessment,
			result: stagedResult,
			verifiedAt: completedAt,
			previousSummary: previousRun?.trustSummary ?? null,
		});

		const blockedStatus = robot.lastPublishedRunId ? 'retained_previous' : 'blocked_initial';
		const ready = report.summary.status === 'ready';

		let artifactPrefix: string | null = null;
		let trustReportPath: string | null = null;
		let trustReportHash: string | null = null;
		let publicationError: string | null = null;
		try {
			const artifacts = await writeWebRobotRunArtifacts({
				projectId: robot.projectId,
				robotId: robot.id,
				robotName: robot.name,
				robotSlug: robot.slug,
				runId: run.id,
				recipe: claimed.definition,
				definitionHash: claimed.definitionHash,
				normalized: result.normalized,
				events: result.events,
				traversalSteps: result.traversalSteps,
				trustReport: report,
				previousPublishedRunId: robot.lastPublishedRunId,
				stats: result.stats,
				startedAt: claimed.startedAt,
				completedAt,
			});
			artifactPrefix = artifacts.artifactPrefix;
			trustReportPath = artifacts.trustReportPath;
			trustReportHash = artifacts.trustReportHash;
		} catch (stagingError) {
			publicationError = stagingError instanceof Error ? stagingError.message : String(stagingError);
			logger.error(`Web robot run ${run.id} artifact staging failed: ${publicationError}`, {
				source: 'system',
				projectId: robot.projectId,
				context: { robotId: robot.id, runId: run.id, error: serializeError(stagingError) },
			});
			await webRobotQueries.completeWebRobotTrustEvaluation(run.id, {
				executionStatus: 'succeeded',
				trustStatus: report.summary.status,
				trustBasis: report.summary.basis,
				trustSummary: report.summary,
				publicationStatus: ready ? 'publication_failed' : blockedStatus,
				publicationErrorMessage: publicationError,
				stats: result.stats,
			});
			return;
		}

		await webRobotQueries.completeWebRobotTrustEvaluation(run.id, {
			executionStatus: 'succeeded',
			trustStatus: report.summary.status,
			trustBasis: report.summary.basis,
			trustSummary: report.summary,
			publicationStatus: ready ? 'pending' : blockedStatus,
			trustReportPath,
			trustReportHash,
			artifactPrefix,
			stats: result.stats,
		});

		if (ready) {
			try {
				await webRobotQueries.activateWebRobotPublication({
					robotId: robot.id,
					runId: run.id,
					configurationId: configuration.id,
					productCount: result.normalized.products.length,
					entityUnit: report.summary.granularity,
					completedAt,
				});
			} catch (activationError) {
				const message = activationError instanceof Error ? activationError.message : String(activationError);
				logger.error(`Web robot run ${run.id} publication activation failed: ${message}`, {
					source: 'system',
					projectId: robot.projectId,
					context: { robotId: robot.id, runId: run.id, error: serializeError(activationError) },
				});
				await webRobotQueries.markWebRobotPublicationFailed(run.id, message);
				return;
			}
		}

		logger.info(`Web robot run ${run.id} finished`, {
			source: 'system',
			projectId: robot.projectId,
			context: {
				robotId: robot.id,
				runId: run.id,
				executionStatus: 'succeeded',
				trustStatus: report.summary.status,
				trustBasis: report.summary.basis,
				publicationStatus: ready ? 'published' : blockedStatus,
				artifactPrefix,
				entityCount: result.normalized.products.length,
				stats: result.stats,
			},
		});
	} catch (error) {
		const latest = await webRobotQueries.getWebRobotRunById(run.id);
		const cancelled = abort.signal.aborted || latest?.cancelRequestedAt;
		const message = cancelled ? 'Cancelled by user.' : error instanceof Error ? error.message : String(error);
		if (!cancelled) {
			logger.error(`Web robot run ${run.id} failed: ${message}`, {
				source: 'system',
				context: { robotId: robot.id, runId: run.id, error: serializeError(error) },
			});
		}
		await webRobotQueries.completeWebRobotTrustEvaluation(run.id, {
			executionStatus: cancelled ? 'cancelled' : 'failed',
			trustStatus: null,
			trustBasis: null,
			trustSummary: null,
			publicationStatus: robot.lastPublishedRunId ? 'retained_previous' : 'blocked_initial',
			executionErrorMessage: message,
			artifactPrefix: latest?.artifactPrefix ?? null,
			stats: latest?.stats ?? emptyWebRobotRunStats(),
		});
		if (!cancelled) {
			throw error;
		}
	} finally {
		activeRuns.delete(run.id);
	}
};

const createProgressWriter = (runId: string) => {
	let lastWriteAt = 0;
	return async (progress: Record<string, unknown>): Promise<void> => {
		const now = Date.now();
		if (now - lastWriteAt < 1_000) {
			return;
		}
		lastWriteAt = now;
		await webRobotQueries.updateWebRobotRunProgress(runId, progress);
	};
};

const createScheduledRun = async (robotId: string, scheduledJobId: string): Promise<DBWebRobotRun> => {
	const active = await webRobotQueries.findActiveWebRobotRun(robotId);
	if (active) {
		throw new Error(`Web robot ${robotId} already has an active run`);
	}

	const robot = await webRobotQueries.getWebRobotById(robotId);
	if (!robot) {
		throw new Error(`Web robot not found: ${robotId}`);
	}

	const configuration = await webRobotQueries.getActiveWebRobotConfiguration(robotId);
	return webRobotQueries.createWebRobotRun({
		robotId,
		scheduledJobId,
		trigger: 'schedule',
		...(configuration
			? webRobotRunSnapshot(configuration)
			: { definition: robot.definition, definitionHash: robot.definitionHash }),
		stats: emptyWebRobotRunStats(),
	});
};
