import {
	emptyWebRobotRunStats,
	type WebRobotExtract,
	type WebRobotRecipe,
	type WebRobotSource,
	type WebRobotStage,
} from '@nao/shared/web-robot';
import type {
	CatalogueAnomaly,
	CatalogueGranularity,
	CountSignal,
	TraversalAttempt,
	TraversalDefinition,
	TraversalMode,
	TraversalResponseEvidence,
	TraversalStepEvidence,
	TraversalSummary,
	TraversalTerminalEvidence,
} from '@nao/shared/web-robot-trust';

import { detectLoadedSourceBlockers } from './blockers';
import { WebRobotBrowserSession } from './browser-loader';
import { extractDomRecords } from './extract-dom';
import { extractEmbeddedRecords } from './extract-embedded';
import { extractJsonRecords } from './extract-json';
import { extractJsonLdRecords } from './extract-json-ld';
import { loadHttpSource, WebRobotLoadError } from './http-loader';
import { normalizeProducts, productIdentityFor } from './records';
import { readResponseWithLimit } from './request';
import { RobotsTxtPolicy } from './robots-txt';
import { getPathValue, renderStringTemplate, type TemplateScope } from './template';
import { advanceApiTraversal } from './traversal-api';
import { browserStateStable, virtualizationObserved, virtualRangeGap } from './traversal-browser';
import {
	fingerprintEvidence,
	identitySetFingerprint,
	redactedRequestTarget,
	redactedUrlString,
	renderedTargetEvidence,
	responseFingerprint,
	sanitizeTraversalError,
} from './traversal-evidence';
import { deriveHtmlNextTarget, validateScopeUrl } from './traversal-html';
import type {
	ClickPagination,
	WebRobotBrowserScrollState,
	WebRobotBrowserTraversalSnapshot,
	WebRobotInteractiveBrowser,
	WebRobotLoadedSource,
	WebRobotRunEvent,
	WebRobotStageRecord,
	WebRobotTraversalReport,
	WebRobotVerificationExecutionResult,
	WebRobotVerificationOptions,
} from './types';
import { assertPublicHttpUrl, canonicalHttpUrl, isAllowedHostname } from './url-policy';

const MAX_ANOMALIES = 128;
const MAX_CONSECUTIVE_GAPS = 2;
const MAX_TOTAL_GAPS = 3;
const INTERACTIVE_MODES = new Set<TraversalMode>(['load_more', 'infinite_scroll']);

type VerificationContext = {
	recipe: WebRobotRecipe;
	env: Record<string, string>;
	signal?: AbortSignal;
	stats: ReturnType<typeof emptyWebRobotRunStats>;
	events: WebRobotRunEvent[];
	anomalies: CatalogueAnomaly[];
	steps: TraversalStepEvidence[];
	countSignals: CountSignal[];
	runtimeSignals: Map<string, CountSignal>;
	scopeId: string;
	entityGranularity: CatalogueGranularity;
	onEvent?: (event: WebRobotRunEvent) => void | Promise<void>;
	onProgress?: (progress: Record<string, unknown>) => void | Promise<void>;
	startedAt: number;
	robots: RobotsTxtPolicy;
	browser: WebRobotBrowserSession;
	halted: boolean;
};

type TraversalRunState = {
	status: TraversalAttempt['status'];
	summary: TraversalSummary;
	records: WebRobotStageRecord[];
};

type AdvanceResult = {
	nextValue?: unknown;
	nextSource?: WebRobotSource;
	terminalEvidence?: TraversalTerminalEvidence;
	anomaly?: CatalogueAnomaly;
	nextTotal?: number;
	nextItemTotal?: number;
};

export const runWebRobotVerification = async (
	options: WebRobotVerificationOptions,
): Promise<WebRobotVerificationExecutionResult> => {
	const recipe = options.recipe;
	const plan = options.verificationPlan;
	if (!plan.scopeId) {
		throw new Error('Verification plan is missing a scopeId.');
	}
	const stageById = new Map(recipe.stages.map((stage) => [stage.id, stage]));
	const definitions = new Map<string, TraversalDefinition>();
	for (const definition of plan.traversals) {
		if (!stageById.has(definition.stageId)) {
			throw new Error(`Verification plan references unknown stage '${definition.stageId}'.`);
		}
		if (definitions.has(definition.stageId)) {
			throw new Error(`Verification plan maps stage '${definition.stageId}' more than once.`);
		}
		definitions.set(definition.stageId, definition);
	}

	const context = createContext(recipe, options);
	const stageRecords = new Map<string, WebRobotStageRecord[]>();
	const enumerationRecords: WebRobotStageRecord[] = [];
	const overlayRecords: WebRobotStageRecord[] = [];
	const reports: WebRobotTraversalReport[] = [];

	try {
		for (const stage of recipe.stages) {
			const definition = definitions.get(stage.id) ?? defaultDefinition(stage);
			const report = await runTraversal(stage, definition, context, stageRecords);
			reports.push(report);
			const produced = stageRecords.get(stage.emit ?? stage.id) ?? [];
			if (definition.role === 'enumeration') {
				enumerationRecords.push(...produced);
			} else if (stage.output === 'product') {
				overlayRecords.push(...produced);
			}
			if (context.halted) {
				break;
			}
		}
	} finally {
		await context.browser.close();
	}

	const normalized = normalizeProducts([...enumerationRecords, ...overlayRecords], recipe, options.runId);
	return {
		stats: context.stats,
		stageRecords,
		products: normalized.products,
		events: context.events,
		normalized,
		traversals: reports,
		traversalSteps: context.steps,
		anomalies: context.anomalies,
		countSignals: mergeCountSignals(options.countSignals ?? [], context.runtimeSignals),
	};
};

const mergeCountSignals = (configured: CountSignal[], runtime: Map<string, CountSignal>): CountSignal[] => {
	const merged = new Map<string, CountSignal>();
	for (const signal of configured) {
		merged.set(signal.id, signal);
	}
	for (const [id, signal] of runtime) {
		if (!merged.has(id)) {
			merged.set(id, signal);
		}
	}
	return [...merged.values()];
};

const addRuntimeCountSignal = (
	context: VerificationContext,
	id: string,
	value: number,
	source: CountSignal['source'],
	path: string,
): void => {
	if (context.runtimeSignals.has(id)) {
		return;
	}
	context.runtimeSignals.set(id, {
		id,
		value,
		unit: context.entityGranularity,
		source,
		scopeId: context.scopeId,
		reliability: 'strong',
		observedAt: new Date().toISOString(),
		comparable: true,
		path,
	});
};

const runTraversal = async (
	stage: WebRobotStage,
	definition: TraversalDefinition,
	context: VerificationContext,
	stageRecords: Map<string, WebRobotStageRecord[]>,
): Promise<WebRobotTraversalReport> => {
	const attemptId = `${definition.id}-attempt-1`;
	const attempt: TraversalAttempt = {
		attemptId,
		status: 'loading',
		startedAt: new Date().toISOString(),
		summary: emptySummary(),
	};
	const report: WebRobotTraversalReport = { definition, attempts: [attempt] };

	if (context.halted) {
		attempt.status = 'cancelled';
		attempt.completedAt = new Date().toISOString();
		return report;
	}
	if (INTERACTIVE_MODES.has(definition.mode) && stage.forEach) {
		attempt.status = 'failed';
		attempt.completedAt = new Date().toISOString();
		attempt.summary.failures = 1;
		pushAnomaly(
			context,
			blockingAnomaly(
				definition,
				'interactive_enrichment_unsupported',
				`Traversal '${definition.id}' requires interactive enrichment which is not supported.`,
			),
		);
		return report;
	}

	const state = stage.forEach
		? await runEnrichmentTraversal(stage, definition, context, stageRecords, attemptId)
		: INTERACTIVE_MODES.has(definition.mode)
			? await runInteractiveListingTraversal(stage, definition, context, attemptId)
			: await runListingTraversal(stage, definition, context, attemptId);

	stageRecords.set(stage.emit ?? stage.id, state.records);
	attempt.status = state.status;
	attempt.completedAt = new Date().toISOString();
	attempt.summary = state.summary;
	if (state.status === 'complete') {
		report.selectedAttemptId = attemptId;
	}
	return report;
};

const runListingTraversal = async (
	stage: WebRobotStage,
	definition: TraversalDefinition,
	context: VerificationContext,
	attemptId: string,
): Promise<TraversalRunState> => {
	const summary = emptySummary();
	const records: WebRobotStageRecord[] = [];
	const seenTargetFingerprints = new Set<string>();
	const seenCursorFingerprints = new Set<string>();
	const identityKeys = new Set<string>();
	const identityWindows = new Map<string, string>();
	let value = initialPaginationValue(stage.paginate);
	let source: WebRobotSource = stage.source;
	let firstPageSize: number | undefined;
	let previousTotal: number | undefined;
	let previousItemTotal: number | undefined;
	let consecutiveNoProgress = 0;
	let consecutiveGaps = 0;
	let totalGaps = 0;
	let sequence = 0;
	const initialUrl = renderSourceUrl(stage.source, paginationScopeFor(stage, value));
	const gapPagination =
		stage.paginate?.type === 'page' || stage.paginate?.type === 'offset' ? stage.paginate : undefined;

	const recordEnumerationGap = (
		pagination: Extract<NonNullable<WebRobotStage['paginate']>, { type: 'page' | 'offset' }>,
		step: TraversalStepEvidence,
		error: string,
		response?: TraversalResponseEvidence,
	): 'continue' | TraversalRunState => {
		totalGaps += 1;
		consecutiveGaps += 1;
		summary.failures += 1;
		if (response) {
			step.response = response;
		}
		pushAnomaly(context, {
			code: 'traversal_gap',
			severity: 'blocking',
			summary: `Enumeration target ${step.target.redactedTarget.slice(0, 400)} failed and was recorded as a gap.`,
			traversalId: definition.id,
			evidenceIds: [],
			details: {
				sequence: step.sequence,
				redactedTarget: step.target.redactedTarget,
				error: error.slice(0, 1024),
			},
		});
		finishStep(step, 'gap', error);

		const boundsExceeded = consecutiveGaps >= MAX_CONSECUTIVE_GAPS || totalGaps > MAX_TOTAL_GAPS;
		const nextValue = pagination.type === 'page' ? Number(value) + 1 : Number(value) + pagination.pageSize;
		const pastDeclaredEnd = pagination.type === 'page' && previousTotal !== undefined && nextValue > previousTotal;
		if (boundsExceeded || pastDeclaredEnd) {
			context.steps.push(step);
			pushAnomaly(
				context,
				blockingAnomaly(
					definition,
					boundsExceeded ? 'gap_tolerance_exceeded' : 'no_terminal_evidence',
					boundsExceeded
						? `Enumeration stopped: gap tolerance exceeded (${consecutiveGaps} consecutive, ${totalGaps} total).`
						: 'The failed target was the declared final target; no later target can produce terminal evidence.',
				),
			);
			return { status: 'failed', summary, records };
		}
		try {
			step.nextTargetFingerprint = renderedTargetEvidence(
				source,
				paginationScopeFor(stage, nextValue),
				context.env,
			).fingerprint;
		} catch {
			step.nextTargetFingerprint = fingerprintEvidence(String(nextValue));
		}
		context.steps.push(step);
		value = nextValue;
		sequence += 1;
		return 'continue';
	};

	while (true) {
		const step = startStep(definition.id, attemptId, sequence, source);

		if (context.signal?.aborted) {
			return endStep(context, step, 'cancelled', summary, records, 'cancelled');
		}
		const limitReason = limitReached(context, stage, sequence);
		if (limitReason) {
			pushAnomaly(context, blockingAnomaly(definition, 'limit_reached', limitReason));
			context.halted = true;
			return endStep(context, step, 'limit_reached', summary, records, 'limit_reached', limitReason);
		}

		let target: { fingerprint: string; redactedTarget: string; url: string };
		try {
			target = renderedTargetEvidence(source, paginationScopeFor(stage, value), context.env);
		} catch (error) {
			pushAnomaly(context, blockingAnomaly(definition, 'invalid_target', sanitizeTraversalError(error)));
			return endStep(context, step, 'failed', summary, records, 'failed', sanitizeTraversalError(error));
		}
		step.target = { sequence, fingerprint: target.fingerprint, redactedTarget: target.redactedTarget };
		if (seenTargetFingerprints.has(target.fingerprint)) {
			pushAnomaly(
				context,
				blockingAnomaly(definition, 'traversal_loop', 'A repeated rendered request target was refused.'),
			);
			return endStep(
				context,
				step,
				'failed',
				summary,
				records,
				'failed',
				'Repeated request target refused before loading.',
			);
		}
		seenTargetFingerprints.add(target.fingerprint);
		summary.plannedTargets += 1;
		summary.attemptedTargets += 1;

		const outcome = await loadTarget(source, paginationScopeFor(stage, value), context, summary);
		if (!outcome.loaded) {
			const error = context.stats.errors.at(-1) ?? 'Request failed';
			if (context.signal?.aborted) {
				return endStep(context, step, 'cancelled', summary, records, 'cancelled', error);
			}
			if (gapPagination && gapEligibleLoadError(outcome.error)) {
				const gap = recordEnumerationGap(gapPagination, step, error);
				if (gap === 'continue') {
					await requestDelay(context);
					continue;
				}
				return gap;
			}
			return endStep(context, step, 'failed', summary, records, 'failed', error);
		}
		const loaded = outcome.loaded;

		const response: TraversalResponseEvidence = {
			status: loaded.status,
			finalUrl: loaded.finalUrl,
			contentType: loaded.contentType,
			surfaceValid: true,
			responseFingerprint: loaded.responseFingerprint ?? responseFingerprint(loaded),
		};

		if (loaded.captureLimitReached) {
			const message = 'The captured response limit was reached; traversal evidence may be incomplete.';
			response.surfaceValid = false;
			pushAnomaly(context, blockingAnomaly(definition, 'limit_reached', message));
			context.halted = true;
			return endStep(context, step, 'limit_reached', summary, records, 'limit_reached', message, response);
		}

		const invalid = invalidResponse(loaded, stage, context.recipe);
		if (invalid) {
			response.surfaceValid = false;
			if (gapPagination && invalid.code === 'invalid_response') {
				const blockers = detectLoadedSourceBlockers(
					loaded,
					stage.source.type === 'browser' ? 'browser' : 'http',
					false,
				);
				if (blockers.length === 0) {
					const gap = recordEnumerationGap(gapPagination, step, invalid.message, response);
					if (gap === 'continue') {
						await requestDelay(context);
						continue;
					}
					return gap;
				}
				response.blocker = blockers[0]!.kind;
			}
			pushAnomaly(context, blockingAnomaly(definition, invalid.code, invalid.message));
			return endStep(context, step, 'failed', summary, records, 'failed', invalid.message, response);
		}

		let extracted: Record<string, unknown>[];
		try {
			extracted = extractRecords(loaded, stage.extract);
		} catch (error) {
			response.surfaceValid = false;
			context.stats.extractionErrors += 1;
			pushStatsError(context, sanitizeTraversalError(error));
			pushAnomaly(context, blockingAnomaly(definition, 'extraction_failed', sanitizeTraversalError(error)));
			return endStep(
				context,
				step,
				'failed',
				summary,
				records,
				'failed',
				sanitizeTraversalError(error),
				response,
			);
		}

		const blockers = detectLoadedSourceBlockers(
			loaded,
			stage.source.type === 'browser' ? 'browser' : 'http',
			extracted.length > 0,
		);
		const hardBlocker = blockers.find((blocker) => blocker.kind !== 'consent' || extracted.length === 0);
		if (hardBlocker) {
			response.surfaceValid = false;
			response.blocker = hardBlocker.kind;
			pushAnomaly(context, blockingAnomaly(definition, 'source_blocked', hardBlocker.message));
			return endStep(context, step, 'failed', summary, records, 'failed', hardBlocker.message, response);
		}
		for (const blocker of blockers) {
			pushAnomaly(context, {
				code: `limitation_${blocker.kind}`,
				severity: 'limitation',
				summary: blocker.message,
				traversalId: definition.id,
				evidenceIds: [],
				details: {},
			});
		}

		const pageRecords = extracted.map((data) => ({
			stageId: stage.id,
			url: recordUrl(data, loaded),
			data,
		}));
		records.push(...pageRecords);
		const rawRecords = rawRecordCount(loaded, stage.extract, extracted.length);
		const stepKeys = new Set<string>();
		let newUnique = 0;
		for (const record of pageRecords) {
			const identity = productIdentityFor(record.data, context.recipe, record.url);
			stepKeys.add(identity.productKey);
			if (!identityKeys.has(identity.productKey)) {
				identityKeys.add(identity.productKey);
				newUnique += 1;
			}
		}
		const windowFingerprint = stepKeys.size ? identitySetFingerprint([...stepKeys]) : undefined;
		step.rawRecords = rawRecords;
		step.acceptedRecords = pageRecords.length;
		step.rejectedRecords = Math.max(rawRecords - pageRecords.length, 0);
		step.newUniqueIdentities = newUnique;
		step.duplicateAppearances = pageRecords.length - newUnique;
		step.identitySetFingerprint = windowFingerprint;
		step.response = response;
		context.stats.itemsExtracted += pageRecords.length;
		for (const record of pageRecords) {
			await emit(context, {
				type: 'item',
				stageId: stage.id,
				url: record.url,
				data: record.data,
				createdAt: now(),
			});
		}
		summary.successfulTargets += 1;
		summary.rawRecords += step.rawRecords;
		summary.acceptedRecords += step.acceptedRecords;
		summary.rejectedRecords += step.rejectedRecords;
		summary.newUniqueIdentities = identityKeys.size;
		summary.duplicateAppearances += step.duplicateAppearances;

		const overflow = hardOverflow(context);
		if (overflow) {
			pushAnomaly(context, blockingAnomaly(definition, 'limit_reached', overflow));
			context.halted = true;
			return endStep(context, step, 'limit_reached', summary, records, 'limit_reached', overflow, response);
		}

		consecutiveGaps = 0;

		if (firstPageSize === undefined && pageRecords.length > 0) {
			firstPageSize = pageRecords.length;
		}

		const advance = advanceTraversal(stage, definition, context, loaded, pageRecords.length, identityKeys.size, {
			value,
			firstPageSize,
			previousTotal,
			previousItemTotal,
			seenCursorFingerprints,
			consecutiveNoProgress,
			newUniqueIdentities: newUnique,
			initialUrl,
		});

		const declaredTotalPath =
			stage.paginate?.type === 'offset'
				? stage.paginate.totalPath
				: stage.paginate?.type === 'page'
					? stage.paginate.totalItemsPath
					: undefined;
		const declaredTotal =
			stage.paginate?.type === 'offset'
				? advance.nextTotal
				: stage.paginate?.type === 'page'
					? advance.nextItemTotal
					: undefined;
		if (declaredTotalPath && declaredTotal !== undefined) {
			addRuntimeCountSignal(context, `runtime-${definition.id}-total`, declaredTotal, 'api', declaredTotalPath);
		}
		if (advance.anomaly && advance.anomaly.severity !== 'blocking') {
			pushAnomaly(context, { ...advance.anomaly, traversalId: definition.id });
		}
		if (
			advance.terminalEvidence?.kind === 'offset_reached_total' &&
			stage.paginate?.type === 'offset' &&
			stage.paginate.firstOffset === 0 &&
			advance.nextTotal !== undefined &&
			identityKeys.size !== advance.nextTotal
		) {
			const anomaly = blockingAnomaly(
				definition,
				'count_conflict',
				`Unique record count ${identityKeys.size} did not reconcile with the declared total ${advance.nextTotal}.`,
			);
			pushAnomaly(context, anomaly);
			return endStep(context, step, 'failed', summary, records, 'failed', anomaly.summary, response);
		}
		if (advance.terminalEvidence) {
			step.terminalEvidence = advance.terminalEvidence;
			summary.terminalEvidence = advance.terminalEvidence;
			finishStep(step, 'complete');
			context.steps.push(step);
			await progress(context, definition.id, summary, identityKeys.size);
			return { status: 'complete', summary, records };
		}
		if (advance.anomaly && advance.anomaly.severity === 'blocking') {
			pushAnomaly(context, { ...advance.anomaly, traversalId: definition.id });
			const status = advance.anomaly.code === 'traversal_stalled' ? 'stalled' : 'failed';
			return endStep(context, step, status, summary, records, status, advance.anomaly.summary, response);
		}
		if (advance.nextTotal !== undefined) {
			previousTotal = advance.nextTotal;
		}
		if (advance.nextItemTotal !== undefined) {
			previousItemTotal = advance.nextItemTotal;
		}
		consecutiveNoProgress = newUnique === 0 ? consecutiveNoProgress + 1 : 0;

		if (
			windowFingerprint &&
			stage.paginate?.type !== 'cursor' &&
			identityWindows.get(windowFingerprint) !== undefined &&
			identityWindows.get(windowFingerprint) !== target.fingerprint
		) {
			pushAnomaly(
				context,
				blockingAnomaly(
					definition,
					'traversal_loop',
					'An identical record window repeated at a different target.',
				),
			);
			return endStep(context, step, 'failed', summary, records, 'failed', 'Repeated record window detected.');
		}
		if (windowFingerprint) {
			identityWindows.set(windowFingerprint, target.fingerprint);
		}

		if (advance.nextValue === undefined && advance.nextSource === undefined) {
			pushAnomaly(
				context,
				blockingAnomaly(definition, 'no_terminal_evidence', 'Traversal ended without terminal evidence.'),
			);
			return endStep(context, step, 'failed', summary, records, 'failed', 'No terminal evidence reached.');
		}

		const nextSource = advance.nextSource ?? source;
		const nextValue = advance.nextSource === undefined ? advance.nextValue : value;
		try {
			const nextTarget = renderedTargetEvidence(nextSource, paginationScopeFor(stage, nextValue), context.env);
			step.nextTargetFingerprint = nextTarget.fingerprint;
		} catch {
			step.nextTargetFingerprint = fingerprintEvidence(String(advance.nextValue ?? advance.nextSource?.url));
		}
		if (stage.paginate?.type === 'cursor' && advance.nextValue !== undefined) {
			seenCursorFingerprints.add(fingerprintEvidence(String(advance.nextValue)));
		}
		source = nextSource;
		value = nextValue;

		finishStep(step, 'complete');
		context.steps.push(step);
		await progress(context, definition.id, summary, identityKeys.size);
		sequence += 1;
		await requestDelay(context);
	}
};

const runEnrichmentTraversal = async (
	stage: WebRobotStage,
	definition: TraversalDefinition,
	context: VerificationContext,
	stageRecords: Map<string, WebRobotStageRecord[]>,
	attemptId: string,
): Promise<TraversalRunState> => {
	const summary = emptySummary();
	const records: WebRobotStageRecord[] = [];
	const parents = (stageRecords.get(stage.forEach!.from) ?? []).slice(0, stage.forEach!.limit);
	summary.plannedTargets = parents.length;
	let failures = 0;

	for (const [sequence, parent] of parents.entries()) {
		const step = startStep(definition.id, attemptId, sequence, stage.source);
		if (context.signal?.aborted) {
			finishStep(step, 'cancelled', 'Web robot run was cancelled');
			context.steps.push(step);
			return { status: 'cancelled', summary, records };
		}
		const limitReason = limitReached(context, stage, sequence);
		if (limitReason) {
			pushAnomaly(context, blockingAnomaly(definition, 'limit_reached', limitReason));
			finishStep(step, 'limit_reached', limitReason);
			context.steps.push(step);
			context.halted = true;
			return { status: 'limit_reached', summary, records };
		}

		const scope = parentScope(stage, parent);
		let target;
		try {
			target = renderedTargetEvidence(stage.source, scope, context.env);
		} catch (error) {
			finishStep(step, 'failed', sanitizeTraversalError(error));
			context.steps.push(step);
			failures += 1;
			summary.failures += 1;
			continue;
		}
		step.target = { sequence, fingerprint: target.fingerprint, redactedTarget: target.redactedTarget };
		summary.attemptedTargets += 1;

		const { loaded } = await loadTarget(stage.source, scope, context, summary);
		let extracted: Record<string, unknown>[] = [];
		const response: TraversalResponseEvidence | undefined = loaded
			? {
					status: loaded.status,
					finalUrl: loaded.finalUrl,
					contentType: loaded.contentType,
					surfaceValid: true,
					responseFingerprint: loaded.responseFingerprint ?? responseFingerprint(loaded),
				}
			: undefined;
		if (response) {
			step.response = response;
		}

		if (loaded?.captureLimitReached) {
			const message = 'The captured response limit was reached; traversal evidence may be incomplete.';
			pushAnomaly(context, blockingAnomaly(definition, 'limit_reached', message));
			if (response) {
				response.surfaceValid = false;
			}
			finishStep(step, 'limit_reached', message);
			context.steps.push(step);
			context.halted = true;
			return { status: 'limit_reached', summary, records };
		}

		let failed = !loaded;
		let failureReason = context.stats.errors.at(-1) ?? 'Request failed';
		if (loaded) {
			const invalid = invalidResponse(loaded, stage, context.recipe);
			if (invalid) {
				failureReason = invalid.message;
				response!.surfaceValid = false;
				pushAnomaly(context, {
					code: invalid.code,
					severity: 'limitation',
					summary: invalid.message,
					traversalId: definition.id,
					evidenceIds: [],
					details: {},
				});
				failed = true;
			}
		}
		if (loaded && !failed) {
			try {
				extracted = extractRecords(loaded, stage.extract);
			} catch (error) {
				failed = true;
				failureReason = sanitizeTraversalError(error);
				response!.surfaceValid = false;
				context.stats.extractionErrors += 1;
				pushStatsError(context, sanitizeTraversalError(error));
				pushAnomaly(context, {
					code: 'extraction_failed',
					severity: 'limitation',
					summary: sanitizeTraversalError(error),
					traversalId: definition.id,
					evidenceIds: [],
					details: {},
				});
			}
		}
		if (loaded && !failed) {
			const blockers = detectLoadedSourceBlockers(
				loaded,
				stage.source.type === 'browser' ? 'browser' : 'http',
				extracted.length > 0,
			);
			const hardBlocker = blockers.find((blocker) => blocker.kind !== 'consent' || extracted.length === 0);
			if (hardBlocker) {
				failed = true;
				failureReason = hardBlocker.message;
				response!.surfaceValid = false;
				response!.blocker = hardBlocker.kind;
				pushAnomaly(context, {
					code: 'source_blocked',
					severity: 'limitation',
					summary: hardBlocker.message,
					traversalId: definition.id,
					evidenceIds: [],
					details: {},
				});
			}
			for (const blocker of blockers.filter((entry) => entry !== hardBlocker)) {
				pushAnomaly(context, {
					code: `limitation_${blocker.kind}`,
					severity: 'limitation',
					summary: blocker.message,
					traversalId: definition.id,
					evidenceIds: [],
					details: {},
				});
			}
		}

		if (failed) {
			finishStep(step, 'failed', failureReason);
			context.steps.push(step);
			failures += 1;
			summary.failures += 1;
			await progress(context, definition.id, summary, summary.newUniqueIdentities);
			continue;
		}

		for (const data of extracted) {
			const record: WebRobotStageRecord = {
				stageId: stage.id,
				url: recordUrl(data, loaded!),
				data: { ...parent.data, ...data },
			};
			records.push(record);
			context.stats.itemsExtracted += 1;
			await emit(context, {
				type: 'item',
				stageId: stage.id,
				url: record.url,
				data: record.data,
				createdAt: now(),
			});
		}
		step.rawRecords = extracted.length;
		step.acceptedRecords = extracted.length;
		step.newUniqueIdentities = extracted.length;
		summary.successfulTargets += 1;
		summary.rawRecords += extracted.length;
		summary.acceptedRecords += extracted.length;
		summary.newUniqueIdentities += extracted.length;

		const overflow = hardOverflow(context);
		if (overflow) {
			pushAnomaly(context, blockingAnomaly(definition, 'limit_reached', overflow));
			step.response = response;
			finishStep(step, 'limit_reached', overflow);
			context.steps.push(step);
			context.halted = true;
			return { status: 'limit_reached', summary, records };
		}

		finishStep(step, 'complete');
		context.steps.push(step);
		await progress(context, definition.id, summary, summary.newUniqueIdentities);
		await requestDelay(context);
	}

	if (failures > 0) {
		pushAnomaly(context, {
			code: 'enrichment_incomplete',
			severity: definition.required ? 'blocking' : 'limitation',
			summary: `${failures} of ${parents.length} enrichment targets failed.`,
			traversalId: definition.id,
			evidenceIds: [],
			details: {},
		});
		return { status: definition.required ? 'failed' : 'complete', summary, records };
	}
	summary.terminalEvidence = {
		kind: 'all_results_displayed',
		summary: `Processed all ${parents.length} parent records.`,
		details: {},
	};
	return { status: 'complete', summary, records };
};

type InteractiveStepOutcome =
	| {
			kind: 'continue';
			step: TraversalStepEvidence;
			newUnique: number;
			keys: Set<string>;
			scroll: WebRobotBrowserScrollState;
			loaded: WebRobotLoadedSource;
	  }
	| { kind: 'stop'; state: TraversalRunState };

const runInteractiveListingTraversal = async (
	stage: WebRobotStage,
	definition: TraversalDefinition,
	context: VerificationContext,
	attemptId: string,
): Promise<TraversalRunState> => {
	const summary = emptySummary();
	const records: WebRobotStageRecord[] = [];
	const pagination = stage.paginate;
	if (stage.source.type !== 'browser' || (pagination?.type !== 'click' && pagination?.type !== 'scroll')) {
		pushAnomaly(
			context,
			blockingAnomaly(
				definition,
				'invalid_traversal',
				'Interactive traversal requires a browser source with click or scroll pagination.',
			),
		);
		return { status: 'failed', summary, records };
	}
	const clickPagination: ClickPagination | undefined = pagination.type === 'click' ? pagination : undefined;
	const scope = paginationScopeFor(stage, undefined);

	let baseTarget: { fingerprint: string; redactedTarget: string; url: string };
	try {
		baseTarget = renderedTargetEvidence(stage.source, scope, context.env);
	} catch (error) {
		pushAnomaly(context, blockingAnomaly(definition, 'invalid_target', sanitizeTraversalError(error)));
		return { status: 'failed', summary, records };
	}

	const count = selectedExpectedCount(context, definition);
	if (count.conflict) {
		pushAnomaly(context, count.conflict);
		return { status: 'failed', summary, records };
	}
	const expected = count.expected;

	let handle: WebRobotInteractiveBrowser;
	try {
		handle = await context.browser.openInteractive(stage.source, {
			recipe: context.recipe,
			scope,
			env: context.env,
			signal: context.signal,
		});
	} catch (error) {
		pushAnomaly(context, blockingAnomaly(definition, 'load_failed', sanitizeTraversalError(error)));
		return { status: context.signal?.aborted ? 'cancelled' : 'failed', summary, records };
	}

	const identityKeys = new Set<string>();
	const identityFallbacks = new Map<string, 'url' | 'record'>();
	let previousKeys = new Set<string>();
	let previousScroll: WebRobotBrowserScrollState | undefined;
	let lastStep: TraversalStepEvidence | undefined;
	let virtualized = false;
	let observedSetSize: number | undefined;
	let stableConfirmations = 0;
	let sequence = 0;

	const newStep = (action: 'click' | 'scroll' | 'observe', label: string): TraversalStepEvidence => {
		const step = startStep(definition.id, attemptId, sequence, stage.source);
		step.target =
			sequence === 0
				? { sequence, fingerprint: baseTarget.fingerprint, redactedTarget: baseTarget.redactedTarget }
				: {
						sequence,
						fingerprint: fingerprintEvidence({ base: baseTarget.fingerprint, action, sequence }),
						redactedTarget: label,
					};
		sequence += 1;
		return step;
	};

	const finishTerminal = (
		terminalEvidence: TraversalTerminalEvidence,
		extraAnomaly?: CatalogueAnomaly,
	): TraversalRunState => {
		summary.terminalEvidence = terminalEvidence;
		if (lastStep) {
			lastStep.terminalEvidence = terminalEvidence;
			lastStep.status = 'complete';
			lastStep.completedAt = new Date().toISOString();
		}
		if (extraAnomaly) {
			pushAnomaly(context, extraAnomaly);
		}
		return { status: 'complete', summary, records };
	};

	const countTerminal = (kind: 'next_control_absent' | 'next_control_disabled'): TraversalRunState => {
		if (expected !== undefined) {
			if (identityKeys.size === expected) {
				return finishTerminal({
					kind: 'count_reconciled',
					summary: `Unique record count ${expected} reconciled with the selected count signal.`,
					details: {},
				});
			}
			const anomaly = countConflictAnomaly(definition, context, identityKeys.size);
			pushAnomaly(context, anomaly);
			return { status: 'failed', summary, records };
		}
		return finishTerminal(
			{
				kind,
				summary:
					kind === 'next_control_absent'
						? 'No enabled load-more control was found.'
						: 'The load-more control is disabled.',
				details: {},
			},
			{
				code: 'no_independent_count',
				severity: 'limitation',
				summary: 'No independent count signal was available to reconcile the enumeration.',
				traversalId: definition.id,
				evidenceIds: [],
				details: {},
			},
		);
	};

	const failAttempt = (
		anomaly: CatalogueAnomaly,
		status: Exclude<TraversalStepEvidence['status'], 'gap'> = 'failed',
	): TraversalRunState => {
		pushAnomaly(context, { ...anomaly, traversalId: definition.id });
		if (lastStep) {
			lastStep.status = status;
			lastStep.completedAt = new Date().toISOString();
			lastStep.error = anomaly.summary.slice(0, 1024);
		}
		return { status, summary, records };
	};

	const processSnapshot = async (
		action: 'click' | 'scroll' | 'observe',
		label: string,
		snapshot: WebRobotBrowserTraversalSnapshot,
	): Promise<InteractiveStepOutcome> => {
		const step = newStep(action, label);
		lastStep = step;
		summary.plannedTargets += 1;
		summary.attemptedTargets += 1;
		const loaded = snapshot.loaded;
		context.stats.pagesDiscovered += 1;
		context.stats.pagesFetched += 1;
		context.stats.requests += loaded.requests;
		await emit(context, { type: 'page', url: loaded.finalUrl, status: loaded.status, createdAt: now() });

		const response: TraversalResponseEvidence = {
			status: loaded.status,
			finalUrl: loaded.finalUrl,
			contentType: loaded.contentType,
			surfaceValid: true,
			responseFingerprint: loaded.responseFingerprint ?? responseFingerprint(loaded),
		};
		step.response = response;

		if (loaded.captureLimitReached) {
			const message = 'The captured response limit was reached; traversal evidence may be incomplete.';
			response.surfaceValid = false;
			pushAnomaly(context, blockingAnomaly(definition, 'limit_reached', message));
			context.halted = true;
			finishStep(step, 'limit_reached', message);
			context.steps.push(step);
			return { kind: 'stop', state: { status: 'limit_reached', summary, records } };
		}

		const invalid = invalidResponse(loaded, stage, context.recipe);
		if (invalid) {
			response.surfaceValid = false;
			pushAnomaly(context, blockingAnomaly(definition, invalid.code, invalid.message));
			summary.failures += 1;
			finishStep(step, 'failed', invalid.message);
			context.steps.push(step);
			return { kind: 'stop', state: { status: 'failed', summary, records } };
		}

		let extracted: Record<string, unknown>[];
		try {
			extracted = extractRecords(loaded, stage.extract);
		} catch (error) {
			response.surfaceValid = false;
			context.stats.extractionErrors += 1;
			pushStatsError(context, sanitizeTraversalError(error));
			pushAnomaly(context, blockingAnomaly(definition, 'extraction_failed', sanitizeTraversalError(error)));
			summary.failures += 1;
			finishStep(step, 'failed', sanitizeTraversalError(error));
			context.steps.push(step);
			return { kind: 'stop', state: { status: 'failed', summary, records } };
		}

		const blockers = detectLoadedSourceBlockers(loaded, 'browser', extracted.length > 0);
		const hardBlocker = blockers.find((blocker) => blocker.kind !== 'consent' || extracted.length === 0);
		if (hardBlocker) {
			response.surfaceValid = false;
			response.blocker = hardBlocker.kind;
			pushAnomaly(context, blockingAnomaly(definition, 'source_blocked', hardBlocker.message));
			summary.failures += 1;
			finishStep(step, 'failed', hardBlocker.message);
			context.steps.push(step);
			return { kind: 'stop', state: { status: 'failed', summary, records } };
		}
		for (const blocker of blockers) {
			pushAnomaly(context, {
				code: `limitation_${blocker.kind}`,
				severity: 'limitation',
				summary: blocker.message,
				traversalId: definition.id,
				evidenceIds: [],
				details: {},
			});
		}

		const pageRecords = extracted.map((data) => ({ stageId: stage.id, url: recordUrl(data, loaded), data }));
		records.push(...pageRecords);
		const stepKeys = new Set<string>();
		let newUnique = 0;
		for (const record of pageRecords) {
			const fallbackUrl = record.url !== loaded.finalUrl ? record.url : undefined;
			const identity = productIdentityFor(record.data, context.recipe, fallbackUrl);
			stepKeys.add(identity.productKey);
			if (identity.fallback) {
				identityFallbacks.set(identity.productKey, identity.fallback);
			}
			if (!identityKeys.has(identity.productKey)) {
				identityKeys.add(identity.productKey);
				newUnique += 1;
			}
		}
		step.rawRecords = rawRecordCount(loaded, stage.extract, extracted.length);
		step.acceptedRecords = pageRecords.length;
		step.rejectedRecords = Math.max(step.rawRecords - pageRecords.length, 0);
		step.newUniqueIdentities = newUnique;
		step.duplicateAppearances = pageRecords.length - newUnique;
		step.identitySetFingerprint = stepKeys.size ? identitySetFingerprint([...stepKeys]) : undefined;
		context.stats.itemsExtracted += pageRecords.length;
		for (const record of pageRecords) {
			await emit(context, {
				type: 'item',
				stageId: stage.id,
				url: record.url,
				data: record.data,
				createdAt: now(),
			});
		}
		summary.successfulTargets += 1;
		summary.rawRecords += step.rawRecords;
		summary.acceptedRecords += step.acceptedRecords;
		summary.rejectedRecords += step.rejectedRecords;
		summary.newUniqueIdentities = identityKeys.size;
		summary.duplicateAppearances += step.duplicateAppearances;

		const overflow = hardOverflow(context);
		if (overflow) {
			pushAnomaly(context, blockingAnomaly(definition, 'limit_reached', overflow));
			context.halted = true;
			finishStep(step, 'limit_reached', overflow);
			context.steps.push(step);
			return { kind: 'stop', state: { status: 'limit_reached', summary, records } };
		}

		finishStep(step, 'complete');
		context.steps.push(step);
		await progress(context, definition.id, summary, identityKeys.size);
		return { kind: 'continue', step, newUnique, keys: stepKeys, scroll: snapshot.scroll, loaded };
	};

	const limitStop = (): TraversalRunState | undefined => {
		const reason = limitReached(context, stage, sequence);
		if (!reason) {
			return undefined;
		}
		pushAnomaly(context, blockingAnomaly(definition, 'limit_reached', reason));
		context.halted = true;
		if (lastStep) {
			lastStep.status = 'limit_reached';
			lastStep.completedAt = new Date().toISOString();
			lastStep.error = reason.slice(0, 1024);
		}
		return { status: 'limit_reached', summary, records };
	};

	const cancelledStop = (): TraversalRunState => {
		if (lastStep) {
			lastStep.status = 'cancelled';
			lastStep.completedAt = new Date().toISOString();
		}
		return { status: 'cancelled', summary, records };
	};

	const observeStallWindow = async (): Promise<'progress' | TraversalRunState> => {
		let stable = 0;
		while (stable < 3) {
			if (context.signal?.aborted) {
				return cancelledStop();
			}
			const limited = limitStop();
			if (limited) {
				return limited;
			}
			let snapshot: WebRobotBrowserTraversalSnapshot;
			try {
				await handle.settle(pagination.waitMs);
				snapshot = await handle.snapshot(clickPagination);
			} catch (error) {
				return context.signal?.aborted
					? cancelledStop()
					: failAttempt(blockingAnomaly(definition, 'load_failed', sanitizeTraversalError(error)));
			}
			const outcome = await processSnapshot('observe', 'BROWSER observe', snapshot);
			if (outcome.kind === 'stop') {
				return outcome.state;
			}
			if (outcome.newUnique > 0) {
				previousKeys = outcome.keys;
				previousScroll = outcome.scroll;
				return 'progress';
			}
			const identical = setsEqual(previousKeys, outcome.keys);
			const stableNow = previousScroll
				? browserStateStable(previousScroll, outcome.scroll) && identical
				: identical && outcome.scroll.relevantNetworkIdle && !outcome.scroll.loadingIndicatorPresent;
			stable = stableNow ? stable + 1 : 0;
			previousKeys = outcome.keys;
			previousScroll = outcome.scroll;
		}
		return failAttempt(
			blockingAnomaly(
				definition,
				'traversal_stalled',
				'The load-more control stayed enabled but produced no new records.',
			),
			'stalled',
		);
	};

	try {
		let snapshot: WebRobotBrowserTraversalSnapshot;
		try {
			snapshot = await handle.snapshot(clickPagination);
		} catch (error) {
			if (context.signal?.aborted) {
				return cancelledStop();
			}
			return failAttempt(blockingAnomaly(definition, 'load_failed', sanitizeTraversalError(error)));
		}
		const initial = await processSnapshot('observe', baseTarget.redactedTarget, snapshot);
		if (initial.kind === 'stop') {
			return initial.state;
		}
		previousKeys = initial.keys;
		previousScroll = initial.scroll;
		if (initial.scroll.setSize !== undefined) {
			observedSetSize = initial.scroll.setSize;
			addRuntimeCountSignal(
				context,
				`runtime-${definition.id}-setsize`,
				initial.scroll.setSize,
				'pagination',
				'aria-setsize',
			);
		}

		while (true) {
			if (context.signal?.aborted) {
				return cancelledStop();
			}
			const limited = limitStop();
			if (limited) {
				return limited;
			}

			if (clickPagination) {
				const control = await handle.inspectControl(clickPagination);
				if (!control.present || !control.enabled) {
					return countTerminal(control.present ? 'next_control_disabled' : 'next_control_absent');
				}
				const probing = expected !== undefined && identityKeys.size === expected;
				let snapshot: WebRobotBrowserTraversalSnapshot;
				try {
					const clicked = await handle.click(clickPagination);
					await handle.settle(pagination.waitMs);
					snapshot = await handle.snapshot(clickPagination);
					if (!clicked.present || !clicked.enabled) {
						return countTerminal(clicked.present ? 'next_control_disabled' : 'next_control_absent');
					}
				} catch (error) {
					if (context.signal?.aborted) {
						return cancelledStop();
					}
					return failAttempt(blockingAnomaly(definition, 'load_failed', sanitizeTraversalError(error)));
				}
				const outcome = await processSnapshot(
					'click',
					`BROWSER click ${control.selector ?? 'control'}`,
					snapshot,
				);
				if (outcome.kind === 'stop') {
					return outcome.state;
				}
				previousKeys = outcome.keys;
				previousScroll = outcome.scroll;
				if (probing) {
					if (outcome.newUnique > 0) {
						return failAttempt(countConflictAnomaly(definition, context, identityKeys.size));
					}
					const after = await handle.inspectControl(clickPagination);
					if (!after.present || !after.enabled) {
						return finishTerminal({
							kind: 'count_reconciled',
							summary: `Unique record count ${expected} reconciled with the selected count signal.`,
							details: {},
						});
					}
					const observed = await observeStallWindow();
					if (observed === 'progress') {
						continue;
					}
					return observed;
				}
				if (outcome.newUnique > 0) {
					stableConfirmations = 0;
					continue;
				}
				const after = await handle.inspectControl(clickPagination);
				if (!after.present || !after.enabled) {
					return countTerminal(after.present ? 'next_control_disabled' : 'next_control_absent');
				}
				const observed = await observeStallWindow();
				if (observed === 'progress') {
					continue;
				}
				return observed;
			}

			const atBottom = previousScroll?.atEffectiveBottom === true;
			let nextSnapshot: WebRobotBrowserTraversalSnapshot;
			try {
				if (!atBottom) {
					await handle.scrollIncrement();
				}
				await handle.settle(pagination.waitMs);
				nextSnapshot = await handle.snapshot();
			} catch (error) {
				if (context.signal?.aborted) {
					return cancelledStop();
				}
				return failAttempt(blockingAnomaly(definition, 'load_failed', sanitizeTraversalError(error)));
			}
			const outcome = await processSnapshot(
				atBottom ? 'observe' : 'scroll',
				atBottom ? 'BROWSER observe' : 'BROWSER scroll',
				nextSnapshot,
			);
			if (outcome.kind === 'stop') {
				return outcome.state;
			}

			if (previousScroll && virtualRangeGap(previousScroll, outcome.scroll)) {
				return failAttempt(
					blockingAnomaly(
						definition,
						'virtualized_range_gap',
						'Virtualized list positions skipped records during traversal.',
					),
				);
			}
			if (
				!virtualized &&
				previousScroll &&
				virtualizationObserved(previousKeys, outcome.keys, previousScroll, outcome.scroll)
			) {
				virtualized = true;
			}
			if (virtualized) {
				const recordHashOnly =
					identityKeys.size > 0 && [...identityKeys].every((key) => identityFallbacks.get(key) === 'record');
				const unidentified =
					identityKeys.size === 0 &&
					outcome.scroll.rangeStart === undefined &&
					outcome.scroll.setSize === undefined &&
					outcome.loaded.captures.length === 0;
				if (recordHashOnly || unidentified) {
					return failAttempt(
						blockingAnomaly(
							definition,
							'unreliable_virtualized_identity',
							'Virtualized records cannot be reconciled without stable identities.',
						),
					);
				}
			}

			if (outcome.scroll.setSize !== undefined) {
				if (observedSetSize === undefined) {
					observedSetSize = outcome.scroll.setSize;
					addRuntimeCountSignal(
						context,
						`runtime-${definition.id}-setsize`,
						observedSetSize,
						'pagination',
						'aria-setsize',
					);
				} else if (observedSetSize !== outcome.scroll.setSize) {
					return failAttempt(
						blockingAnomaly(
							definition,
							'source_changed_during_run',
							'The aria-setsize total changed during traversal.',
						),
					);
				}
			}
			const effectiveExpected = expected ?? observedSetSize;
			if (expected !== undefined && observedSetSize !== undefined && observedSetSize !== expected) {
				return failAttempt(countConflictAnomaly(definition, context, identityKeys.size));
			}

			if (outcome.newUnique > 0) {
				stableConfirmations = 0;
				if (effectiveExpected !== undefined && identityKeys.size > effectiveExpected) {
					return failAttempt(countConflictAnomaly(definition, context, identityKeys.size));
				}
				previousKeys = outcome.keys;
				previousScroll = outcome.scroll;
				continue;
			}

			const identical = setsEqual(previousKeys, outcome.keys);
			const stable =
				previousScroll !== undefined &&
				outcome.scroll.atEffectiveBottom &&
				browserStateStable(previousScroll, outcome.scroll) &&
				identical;

			if (effectiveExpected !== undefined) {
				if (identityKeys.size > effectiveExpected) {
					return failAttempt(countConflictAnomaly(definition, context, identityKeys.size));
				}
				if (identityKeys.size === effectiveExpected && stable) {
					return finishTerminal({
						kind: 'count_reconciled',
						summary: `Unique record count ${effectiveExpected} reconciled with the expected total.`,
						details: {},
					});
				}
				if (identityKeys.size < effectiveExpected && stable) {
					return failAttempt(countConflictAnomaly(definition, context, identityKeys.size));
				}
			} else {
				stableConfirmations = stable ? stableConfirmations + 1 : 0;
				if (stableConfirmations >= 3) {
					return finishTerminal({
						kind: 'stable_no_progress',
						summary: 'Infinite scroll reached a stable bottom with no new records.',
						details: {
							confirmations: 3,
							atEffectiveBottom: true,
							identitySetStable: true,
							scrollExtentStable: true,
							relevantNetworkIdle: true,
							loadingIndicatorAbsent: true,
						},
					});
				}
			}
			previousKeys = outcome.keys;
			previousScroll = outcome.scroll;
		}
	} finally {
		await handle.close();
	}
};

const setsEqual = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
	left.size === right.size && [...left].every((key) => right.has(key));

const advanceTraversal = (
	stage: WebRobotStage,
	definition: TraversalDefinition,
	context: VerificationContext,
	loaded: WebRobotLoadedSource,
	extractedCount: number,
	uniqueEntities: number,
	state: {
		value: unknown;
		firstPageSize?: number;
		previousTotal?: number;
		previousItemTotal?: number;
		seenCursorFingerprints: Set<string>;
		consecutiveNoProgress: number;
		newUniqueIdentities: number;
		initialUrl: string;
	},
): AdvanceResult => {
	const pagination = stage.paginate;
	if (!pagination) {
		return finiteTerminal(context, definition, uniqueEntities);
	}
	if (pagination.type === 'nextLink') {
		const next = deriveHtmlNextTarget(loaded, pagination, state.initialUrl);
		return next.nextUrl ? { nextSource: { ...stage.source, url: next.nextUrl } as WebRobotSource } : next;
	}
	if (pagination.type === 'click' || pagination.type === 'scroll') {
		return {
			anomaly: {
				code: 'invalid_traversal',
				severity: 'blocking',
				summary: `Interactive '${pagination.type}' pagination cannot run as a linear traversal.`,
				evidenceIds: [],
				details: {},
			},
		};
	}
	const result = advanceApiTraversal({
		pagination,
		currentValue: state.value,
		body: loaded.bodyJson ?? parseJson(loaded.bodyText),
		extractedCount,
		firstPageSize: state.firstPageSize,
		previousTotal: state.previousTotal,
		previousItemTotal: state.previousItemTotal,
		seenCursorFingerprints: state.seenCursorFingerprints,
		consecutiveNoProgress: state.consecutiveNoProgress,
		newUniqueIdentities: state.newUniqueIdentities,
	});
	if (result.nextValue !== undefined && pagination.type === 'nextPath') {
		const checked = validateScopeUrl(String(result.nextValue), state.initialUrl, loaded.finalUrl);
		if (!checked.nextUrl) {
			return {
				...result,
				nextValue: undefined,
				terminalEvidence: checked.terminalEvidence,
				anomaly: checked.anomaly,
			};
		}
		return {
			...result,
			nextSource: { ...stage.source, url: checked.nextUrl } as WebRobotSource,
		};
	}
	return result;
};

const selectedExpectedCount = (
	context: VerificationContext,
	definition: TraversalDefinition,
): { expected?: number; conflict?: CatalogueAnomaly } => {
	const comparable = context.countSignals.filter((signal) => signal.comparable);
	const values = new Set(comparable.map((signal) => signal.value));
	if (values.size > 1) {
		return {
			conflict: blockingAnomaly(
				definition,
				'count_conflict',
				`Selected count signals disagree: ${[...values].join(', ')}.`,
			),
		};
	}
	if (values.size === 1) {
		return { expected: comparable[0]?.value };
	}
	return {};
};

const countConflictAnomaly = (
	definition: TraversalDefinition,
	context: VerificationContext,
	uniqueEntities: number,
): CatalogueAnomaly => ({
	code: 'count_conflict',
	severity: 'blocking',
	summary: `Unique record count ${uniqueEntities} did not match the selected count signal.`,
	traversalId: definition.id,
	evidenceIds: [],
	details: { uniqueEntities, signalIds: context.countSignals.map((signal) => signal.id) },
});

const finiteTerminal = (
	context: VerificationContext,
	definition: TraversalDefinition,
	uniqueEntities: number,
): AdvanceResult => {
	const { expected, conflict } = selectedExpectedCount(context, definition);
	if (conflict) {
		return { anomaly: conflict };
	}
	if (expected !== undefined && expected === uniqueEntities) {
		return {
			terminalEvidence: {
				kind: 'count_reconciled',
				summary: `Unique record count ${uniqueEntities} reconciled with the selected count signal.`,
				details: {},
			},
		};
	}
	if (expected !== undefined) {
		return { anomaly: countConflictAnomaly(definition, context, uniqueEntities) };
	}
	return {
		terminalEvidence: {
			kind: 'next_control_absent',
			summary: 'Finite traversal completed without pagination.',
			details: {},
		},
		anomaly: {
			code: 'no_independent_count',
			severity: 'limitation',
			summary: 'No independent count signal was available to reconcile the enumeration.',
			evidenceIds: [],
			details: {},
		},
	};
};

const invalidResponse = (
	loaded: WebRobotLoadedSource,
	stage: WebRobotStage,
	recipe: WebRobotRecipe,
): { code: string; message: string } | undefined => {
	if (loaded.status < 200 || loaded.status >= 300) {
		return { code: 'invalid_response', message: `The source returned HTTP ${loaded.status}.` };
	}
	if (!isAllowedHostname(hostnameOf(loaded.finalUrl), recipe.allowedHosts)) {
		return {
			code: 'out_of_scope_redirect',
			message: `Response URL '${redactedUrlString(loaded.finalUrl)}' left the allowed hosts.`,
		};
	}
	if (!expectedShape(loaded, stage.extract)) {
		return { code: 'invalid_response', message: 'The response did not match the expected JSON/HTML shape.' };
	}
	return undefined;
};

const loadTarget = async (
	source: WebRobotSource,
	scope: TemplateScope,
	context: VerificationContext,
	summary: TraversalSummary,
): Promise<{ loaded?: WebRobotLoadedSource; error?: unknown }> => {
	try {
		const renderedUrl = renderSourceUrl(source, scope);
		await assertPublicHttpUrl(renderedUrl, context.recipe.allowedHosts);
		if (context.recipe.respectRobotsTxt) {
			await context.robots.assertAllowed(renderedUrl, context.recipe.request.userAgent);
		}
		const loaded =
			source.type === 'browser'
				? await context.browser.load(source, {
						recipe: context.recipe,
						scope,
						env: context.env,
						signal: context.signal,
					})
				: await loadHttpSource(source, {
						recipe: context.recipe,
						scope,
						env: context.env,
						signal: context.signal,
					});
		context.stats.pagesDiscovered += 1;
		context.stats.pagesFetched += 1;
		context.stats.requests += loaded.requests;
		summary.retries += Math.max((loaded.requestAttempts?.length ?? 1) - 1, 0);
		await emit(context, { type: 'page', url: loaded.finalUrl, status: loaded.status, createdAt: now() });
		return { loaded };
	} catch (error) {
		context.stats.failedRequests += 1;
		pushStatsError(context, sanitizeTraversalError(error));
		if (error instanceof WebRobotLoadError) {
			summary.retries += Math.max(error.requestAttempts.length - 1, 0);
		}
		await emit(context, {
			type: 'error',
			url: redactedUrlString(renderSourceUrlSafe(source, scope)),
			message: sanitizeTraversalError(error),
			createdAt: now(),
		});
		return { error };
	}
};

const gapEligibleLoadError = (error: unknown): boolean => {
	if (!(error instanceof WebRobotLoadError)) {
		return false;
	}
	if (error.requestAttempts.some((attempt) => attempt.status === 429)) {
		return false;
	}
	return !/rate.?limit|cooling down|request budget|not allowed|not safe|did not resolve|private or reserved|unsupported address|invalid url|only http|byte limit/i.test(
		error.message,
	);
};

const extractRecords = (
	loaded: WebRobotLoadedSource,
	extract: WebRobotExtract | undefined,
): Record<string, unknown>[] => {
	if (!extract) {
		return [{ url: loaded.finalUrl, status: loaded.status }];
	}
	switch (extract.type) {
		case 'dom':
			return extractDomRecords(loaded.bodyText ?? '', extract, loaded.finalUrl);
		case 'json':
			return extractJsonRecords(loaded.bodyJson ?? parseJson(loaded.bodyText), extract, loaded.finalUrl);
		case 'network':
			return loaded.captures
				.filter((capture) => capture.name === extract.capture)
				.flatMap((capture) => extractJsonRecords(capture.body, extract, loaded.finalUrl));
		case 'embedded':
			return extractEmbeddedRecords(loaded.bodyText ?? '', extract, loaded.finalUrl);
		case 'jsonld':
			return extractJsonLdRecords(loaded.bodyText ?? '', extract, loaded.finalUrl);
	}
};

const rawRecordCount = (
	loaded: WebRobotLoadedSource,
	extract: WebRobotExtract | undefined,
	accepted: number,
): number => {
	if (extract?.type === 'json') {
		const items = extract.itemsPath
			? getPathValue(loaded.bodyJson ?? parseJson(loaded.bodyText), extract.itemsPath)
			: (loaded.bodyJson ?? parseJson(loaded.bodyText));
		return Array.isArray(items) ? items.length : accepted;
	}
	if (extract?.type === 'network') {
		const total = loaded.captures
			.filter((capture) => capture.name === extract.capture)
			.reduce((count, capture) => {
				const items = extract.itemsPath ? getPathValue(capture.body, extract.itemsPath) : capture.body;
				return count + (Array.isArray(items) ? items.length : 0);
			}, 0);
		return Math.max(total, accepted);
	}
	return accepted;
};

const expectedShape = (loaded: WebRobotLoadedSource, extract: WebRobotExtract | undefined): boolean => {
	if (!extract) {
		return true;
	}
	if (extract.type === 'json') {
		if (loaded.bodyJson !== undefined) {
			return true;
		}
		const text = loaded.bodyText?.trim() ?? '';
		return text.startsWith('{') || text.startsWith('[');
	}
	if (extract.type === 'network') {
		return loaded.captures.some(
			(capture) =>
				capture.name === extract.capture &&
				(typeof capture.body === 'object' || typeof capture.body === 'string'),
		);
	}
	return (loaded.bodyText ?? '').includes('<');
};

const startStep = (
	traversalId: string,
	attemptId: string,
	sequence: number,
	source: WebRobotSource,
): TraversalStepEvidence => ({
	traversalId,
	attemptId,
	sequence,
	status: 'failed',
	target: {
		sequence,
		fingerprint: fingerprintEvidence(source.url),
		redactedTarget: redactedRequestTarget('GET', source.url),
	},
	startedAt: new Date().toISOString(),
	completedAt: new Date().toISOString(),
	rawRecords: 0,
	acceptedRecords: 0,
	rejectedRecords: 0,
	newUniqueIdentities: 0,
	duplicateAppearances: 0,
});

const endStep = (
	context: VerificationContext,
	step: TraversalStepEvidence,
	stepStatus: TraversalStepEvidence['status'],
	summary: TraversalSummary,
	records: WebRobotStageRecord[],
	attemptStatus: TraversalAttempt['status'],
	error?: string,
	response?: TraversalStepEvidence['response'],
): TraversalRunState => {
	if (response) {
		step.response = response;
	}
	finishStep(step, stepStatus, error);
	if (stepStatus !== 'complete' && stepStatus !== 'cancelled') {
		summary.failures += 1;
	}
	context.steps.push(step);
	return { status: attemptStatus, summary, records };
};

const finishStep = (step: TraversalStepEvidence, status: TraversalStepEvidence['status'], error?: string): void => {
	step.status = status;
	step.completedAt = new Date().toISOString();
	if (error) {
		step.error = error.slice(0, 1024);
	}
};

const hardOverflow = (context: VerificationContext): string | undefined => {
	if (context.stats.pagesFetched > context.recipe.limits.maxPages) {
		return `Web robot exceeded the ${context.recipe.limits.maxPages} page limit.`;
	}
	if (context.stats.itemsExtracted > context.recipe.limits.maxItems) {
		return `Web robot exceeded the ${context.recipe.limits.maxItems} item limit.`;
	}
	if (context.stats.requests > context.recipe.limits.maxRequests) {
		return `Web robot exceeded the ${context.recipe.limits.maxRequests} request limit.`;
	}
	if (Date.now() - context.startedAt > context.recipe.limits.maxDurationMs) {
		return `Web robot exceeded the ${context.recipe.limits.maxDurationMs} ms duration limit.`;
	}
	return undefined;
};

const limitReached = (context: VerificationContext, stage: WebRobotStage, sequence: number): string | undefined => {
	if (stage.paginate && sequence >= stage.paginate.maxPages) {
		return `Stage '${stage.id}' reached its ${stage.paginate.maxPages} page limit with more targets pending.`;
	}
	if (context.stats.pagesFetched >= context.recipe.limits.maxPages) {
		return `Web robot reached the ${context.recipe.limits.maxPages} page limit.`;
	}
	if (context.stats.itemsExtracted >= context.recipe.limits.maxItems) {
		return `Web robot reached the ${context.recipe.limits.maxItems} item limit.`;
	}
	if (context.stats.requests >= context.recipe.limits.maxRequests) {
		return `Web robot reached the ${context.recipe.limits.maxRequests} request limit.`;
	}
	if (Date.now() - context.startedAt > context.recipe.limits.maxDurationMs) {
		return `Web robot reached the ${context.recipe.limits.maxDurationMs} ms duration limit.`;
	}
	return undefined;
};

const blockingAnomaly = (definition: TraversalDefinition, code: string, summary: string): CatalogueAnomaly => ({
	code,
	severity: 'blocking',
	summary,
	traversalId: definition.id,
	evidenceIds: [],
	details: {},
});

const pushAnomaly = (context: VerificationContext, anomaly: CatalogueAnomaly): void => {
	if (context.anomalies.length < MAX_ANOMALIES) {
		context.anomalies.push(anomaly);
	}
};

const pushStatsError = (context: VerificationContext, message: string): void => {
	if (context.stats.errors.length < 100) {
		context.stats.errors.push(message);
	}
};

const progress = async (
	context: VerificationContext,
	traversalId: string,
	summary: TraversalSummary,
	uniqueEntities: number,
): Promise<void> => {
	await context.onProgress?.({
		phase: 'traversal',
		traversalId,
		completedTargets: summary.successfulTargets,
		uniqueEntities,
	});
};

const emit = async (context: VerificationContext, event: WebRobotRunEvent): Promise<void> => {
	context.events.push(event);
	await context.onEvent?.(event);
};

const defaultDefinition = (stage: WebRobotStage): TraversalDefinition => ({
	id: `traversal-${stage.id}`,
	stageId: stage.id,
	role: stage.forEach ? 'enrichment' : stage.output === 'product' || stage.emit ? 'enumeration' : 'corroboration',
	required: stage.forEach === undefined,
	sourceType: stage.source.type,
	mode: modeForPaginate(stage.paginate),
	terminalStrategies: [],
});

const modeForPaginate = (paginate: WebRobotStage['paginate']): TraversalMode => {
	switch (paginate?.type) {
		case 'page':
		case 'nextPath':
			return 'page';
		case 'offset':
			return 'offset';
		case 'cursor':
			return 'cursor';
		case 'nextLink':
			return 'next_link';
		case 'click':
			return 'load_more';
		case 'scroll':
			return 'infinite_scroll';
		default:
			return 'finite';
	}
};

const initialPaginationValue = (pagination: WebRobotStage['paginate']): unknown => {
	if (pagination?.type === 'page') {
		return pagination.firstPage;
	}
	if (pagination?.type === 'cursor') {
		return pagination.firstCursor ?? '';
	}
	if (pagination?.type === 'offset') {
		return pagination.firstOffset;
	}
	return 1;
};

const paginationScopeFor = (stage: WebRobotStage, value: unknown): TemplateScope => {
	const pagination = stage.paginate;
	if (pagination?.type === 'page') {
		return { [pagination.pageVariable]: value };
	}
	if (pagination?.type === 'cursor') {
		return { [pagination.cursorVariable]: value };
	}
	if (pagination?.type === 'offset') {
		return { [pagination.offsetVariable]: value };
	}
	return {};
};

const parentScope = (stage: WebRobotStage, parent: WebRobotStageRecord): TemplateScope => ({
	record: parent.data,
	[parent.stageId]: parent.data,
	...(stage.forEach ? { [stage.forEach.from]: parent.data } : {}),
});

const recordUrl = (data: Record<string, unknown>, loaded: WebRobotLoadedSource): string => {
	const candidate = data.url ?? data.canonical_url ?? data.uri;
	if (typeof candidate === 'string' && candidate) {
		try {
			return canonicalHttpUrl(candidate, loaded.finalUrl);
		} catch {
			return loaded.finalUrl;
		}
	}
	return loaded.finalUrl;
};

const renderSourceUrl = (source: WebRobotSource, scope: TemplateScope): string =>
	canonicalHttpUrl(renderStringTemplate(source.url, scope));

const renderSourceUrlSafe = (source: WebRobotSource, scope: TemplateScope): string => {
	try {
		return renderSourceUrl(source, scope);
	} catch {
		return source.url;
	}
};

const parseJson = (text: string | undefined): unknown => {
	if (!text) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const hostnameOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
};

const emptySummary = (): TraversalSummary => ({
	plannedTargets: 0,
	attemptedTargets: 0,
	successfulTargets: 0,
	rawRecords: 0,
	acceptedRecords: 0,
	rejectedRecords: 0,
	newUniqueIdentities: 0,
	duplicateAppearances: 0,
	retries: 0,
	failures: 0,
});

const createContext = (recipe: WebRobotRecipe, options: WebRobotVerificationOptions): VerificationContext => ({
	recipe,
	env: options.env ?? {},
	signal: options.signal,
	stats: emptyWebRobotRunStats(),
	events: [],
	anomalies: [],
	steps: [],
	countSignals: (options.countSignals ?? []).filter((signal) =>
		options.verificationPlan.countSignalIds.includes(signal.id),
	),
	runtimeSignals: new Map(
		(options.countSignals ?? [])
			.filter((signal) => options.verificationPlan.countSignalIds.includes(signal.id))
			.map((signal) => [signal.id, signal]),
	),
	scopeId: options.verificationPlan.scopeId,
	entityGranularity: options.entityGranularity ?? 'source_record',
	onEvent: options.onEvent,
	onProgress: options.onProgress,
	startedAt: Date.now(),
	robots: new RobotsTxtPolicy(fetchRobotsTxt),
	browser: new WebRobotBrowserSession(),
	halted: false,
});

const fetchRobotsTxt = async (robotsUrl: string): Promise<string | null> => {
	const response = await fetch(robotsUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
	if (response.status >= 400) {
		return null;
	}
	return readResponseWithLimit(response, 256 * 1024);
};

const requestDelay = async (context: VerificationContext): Promise<void> => {
	const delayMs = context.recipe.request.delayMs;
	if (delayMs <= 0) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, delayMs);
		context.signal?.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(new Error('Web robot run was cancelled'));
		});
	});
};

const now = (): string => new Date().toISOString();
