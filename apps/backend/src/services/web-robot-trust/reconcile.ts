import {
	type CatalogueAnomaly,
	type CatalogueContract,
	type CatalogueScope,
	type CatalogueTrustDimensions,
	type CatalogueTrustReport,
	catalogueTrustReportSchema,
	type CatalogueTrustSummary,
	type CatalogueVerificationPlan,
	type CountComparison,
	type ScopeFitnessDecision,
	type SemanticConceptMetric,
	type SemanticMetrics,
	type TrustDimension,
	type TrustDimensionStatus,
} from '@nao/shared/web-robot-trust';

import type { NormalizedProducts } from '../web-scraper/records';
import type { WebRobotVerificationExecutionResult } from '../web-scraper/types';
import { conceptCovered } from './concepts';
import { CATALOGUE_TRUST_POLICY_V1, type CatalogueTrustPolicy, deriveCatalogueTrustVerdict } from './policy';

export type CatalogueReconciliationInput = {
	runId: string;
	configurationHash: string;
	scope: CatalogueScope;
	contract: CatalogueContract;
	verificationPlan: CatalogueVerificationPlan;
	sourceAssessment: ScopeFitnessDecision[];
	result: WebRobotVerificationExecutionResult;
	verifiedAt?: Date;
	previousSummary?: CatalogueTrustSummary | null;
};

const STRONG_CONTRADICTION_CODES = new Set([
	'count_conflict',
	'scope_mismatch',
	'source_changed_during_run',
	'granularity_drift',
	'entity_count_drop',
	'filter_lost',
	'out_of_scope_redirect',
]);

const anomaly = (code: string, summary: string, details: Record<string, unknown> = {}): CatalogueAnomaly => ({
	code,
	severity: 'blocking',
	summary,
	evidenceIds: [],
	details,
});

const dimension = (status: TrustDimensionStatus, reasons: string[]): TrustDimension => ({
	status,
	reasons: reasons.slice(0, 64),
});

export const reconcileCatalogueTrust = (
	input: CatalogueReconciliationInput,
	policy: CatalogueTrustPolicy = CATALOGUE_TRUST_POLICY_V1,
): CatalogueTrustReport => {
	const verifiedAt = (input.verifiedAt ?? new Date()).toISOString();
	const { result, scope, contract, verificationPlan } = input;
	const anomalies: CatalogueAnomaly[] = [];
	const limitations: string[] = [];
	const entityCount = result.normalized.products.length;

	const scopeDecision = input.sourceAssessment.find(
		(decision) => decision.candidateId === scope.selection.candidateId,
	);
	const scopeReasons: string[] = [];
	let scopeStatus: TrustDimensionStatus = 'passed';
	if (
		!scopeDecision ||
		(scopeDecision.role !== 'primary_enumerator' && scopeDecision.role !== 'partition_enumerator') ||
		scopeDecision.relation !== 'exact' ||
		scopeDecision.entityKind === 'non_product' ||
		scopeDecision.entityKind === 'unknown' ||
		scopeDecision.blockers.length > 0
	) {
		scopeStatus = 'failed';
		scopeReasons.push(
			scopeDecision
				? `Selected candidate '${scopeDecision.candidateId}' does not satisfy exact product scope requirements.`
				: 'No scope-fitness decision exists for the selected candidate.',
		);
		anomalies.push(anomaly('scope_mismatch', 'The selected source does not match the confirmed catalogue scope.'));
	} else {
		scopeReasons.push(`Scope '${scope.label}' confirmed by candidate '${scopeDecision.candidateId}'.`);
	}
	if (scopeDecision) {
		for (const entry of scopeDecision.limitations) {
			limitations.push(entry);
		}
	}

	const recordReasons: string[] = [];
	let recordStatus: TrustDimensionStatus = 'passed';
	const failedRequired = verificationPlan.traversals
		.filter((definition) => definition.required)
		.filter((definition) => {
			const report = result.traversals.find((entry) => entry.definition.id === definition.id);
			const selected = report?.attempts.find((attempt) => attempt.attemptId === report.selectedAttemptId);
			return !report || !report.selectedAttemptId || selected?.status !== 'complete';
		});
	if (failedRequired.length > 0) {
		recordStatus = 'failed';
		recordReasons.push(
			`Required traversals incomplete: ${failedRequired.map((definition) => definition.id).join(', ')}.`,
		);
		anomalies.push(
			anomaly('required_traversal_incomplete', 'One or more required traversals did not complete.', {
				traversalIds: failedRequired.map((definition) => definition.id),
			}),
		);
	}
	const incompleteOptional = verificationPlan.traversals
		.filter((definition) => !definition.required)
		.filter((definition) => {
			const report = result.traversals.find((entry) => entry.definition.id === definition.id);
			const selected = report?.attempts.find((attempt) => attempt.attemptId === report?.selectedAttemptId);
			return !report || selected?.status !== 'complete';
		});
	if (incompleteOptional.length > 0) {
		if (recordStatus === 'passed') {
			recordStatus = 'limited';
		}
		const text = `Optional traversals incomplete: ${incompleteOptional.map((definition) => definition.id).join(', ')}.`;
		recordReasons.push(text);
		limitations.push(text);
	}
	if (entityCount === 0) {
		recordStatus = 'failed';
		recordReasons.push('No normalized entities were produced.');
		anomalies.push(anomaly('no_entities', 'The traversal produced no catalogue entities.'));
	}
	const requiredById = new Map(verificationPlan.traversals.map((definition) => [definition.id, definition.required]));
	const normalizedResultAnomalies = result.anomalies.map((entry) => {
		const required = entry.traversalId ? requiredById.get(entry.traversalId) : undefined;
		if (entry.severity === 'blocking' && required === false && !STRONG_CONTRADICTION_CODES.has(entry.code)) {
			limitations.push(`Optional traversal '${entry.traversalId}' reported ${entry.code}: ${entry.summary}`);
			return { ...entry, severity: 'limitation' as const };
		}
		return entry;
	});
	const traversalBlockers = normalizedResultAnomalies.filter((entry) => entry.severity === 'blocking');
	if (traversalBlockers.length > 0) {
		recordStatus = 'failed';
		recordReasons.push(
			`Blocking traversal anomalies: ${[...new Set(traversalBlockers.map((entry) => entry.code))].sort().join(', ')}.`,
		);
	}
	if (recordStatus === 'passed') {
		recordReasons.push(`All required traversals completed with ${entityCount} unique entities.`);
	}

	const countComparisons: CountComparison[] = [];
	const compatible = result.countSignals.filter(
		(signal) => signal.scopeId === scope.id && signal.comparable && signal.unit === contract.entityGranularity,
	);
	const incomparable = result.countSignals.filter(
		(signal) => signal.comparable && !(signal.scopeId === scope.id && signal.unit === contract.entityGranularity),
	);
	for (const signal of incomparable) {
		countComparisons.push({
			status: 'not_comparable',
			signalIds: [signal.id],
			observedUniqueCount: entityCount,
			explanation: `Count signal '${signal.id}' is not comparable to the contract granularity.`,
		});
		limitations.push(`Count signal '${signal.id}' is not comparable to the contract granularity.`);
	}
	const expectedValues = new Set(compatible.map((signal) => signal.value));
	if (expectedValues.size > 1) {
		countComparisons.push({
			status: 'mismatch',
			signalIds: compatible.map((signal) => signal.id),
			observedUniqueCount: entityCount,
			explanation: 'Selected count signals disagree on the expected total.',
		});
		anomalies.push(
			anomaly('count_conflict', 'Comparable count signals disagree with each other.', {
				values: [...expectedValues].sort((a, b) => a - b),
			}),
		);
		if (recordStatus === 'passed') {
			recordStatus = 'failed';
		}
		recordReasons.push('Comparable count signals disagree.');
	} else if (expectedValues.size === 1) {
		const expected = compatible[0]?.value ?? 0;
		countComparisons.push({
			status: expected === entityCount ? 'match' : 'mismatch',
			signalIds: compatible.map((signal) => signal.id),
			observedUniqueCount: entityCount,
			expectedCount: expected,
			explanation:
				expected === entityCount
					? `Unique entity count ${entityCount} matches the expected total.`
					: `Unique entity count ${entityCount} does not match the expected total ${expected}.`,
		});
		if (expected !== entityCount) {
			anomalies.push(
				anomaly(
					'count_conflict',
					`Unique entity count ${entityCount} did not match the expected total ${expected}.`,
				),
			);
			if (recordStatus === 'passed') {
				recordStatus = 'failed';
			}
			recordReasons.push(`Unique entity count ${entityCount} did not match the expected total ${expected}.`);
		} else {
			recordReasons.push(`Unique entity count ${entityCount} reconciled with the expected total.`);
		}
	} else {
		limitations.push('No independent comparable source count was available.');
	}

	const identityReasons: string[] = [];
	let identityStatus: TrustDimensionStatus = 'passed';
	const metrics = result.normalized.identityMetrics;
	if (metrics.collisionCount > policy.maxIdentityCollisions) {
		identityStatus = 'failed';
		identityReasons.push(`${metrics.collisionCount} identity collision(s) detected.`);
		anomalies.push(
			anomaly('identity_collision', 'Distinct identities collapsed onto shared product keys.', {
				collisionCount: metrics.collisionCount,
			}),
		);
	}
	if (metrics.recordHashFallbackCount > 0) {
		identityStatus = 'failed';
		identityReasons.push(`${metrics.recordHashFallbackCount} entit(ies) required record-hash identity fallback.`);
		anomalies.push(
			anomaly('unstable_identity', 'Some entities only have unstable record-hash identities.', {
				recordHashFallbackCount: metrics.recordHashFallbackCount,
			}),
		);
	}
	if (identityStatus === 'passed') {
		identityReasons.push('All entities carry stable configured or URL identities.');
	}

	const semantics = computeSemantics(result.normalized, contract);
	const semanticReasons: string[] = [];
	let semanticStatus: TrustDimensionStatus = 'passed';
	for (const concept of semantics.concepts) {
		if (concept.required && concept.coverage < concept.minimumCoverage) {
			semanticStatus = 'failed';
			semanticReasons.push(
				`Required concept '${concept.concept}' coverage ${concept.coverage} below ${concept.minimumCoverage}.`,
			);
			anomalies.push(
				anomaly(
					`required_concept_${concept.concept}`,
					`Required concept '${concept.concept}' coverage ${concept.coverage} is below the minimum ${concept.minimumCoverage}.`,
				),
			);
		} else if (!concept.required && concept.coverage < concept.minimumCoverage) {
			if (semanticStatus === 'passed') {
				semanticStatus = 'limited';
			}
			const text = `Optional concept '${concept.concept}' coverage ${concept.coverage} is below ${concept.minimumCoverage}.`;
			semanticReasons.push(text);
			limitations.push(text);
		}
	}
	if (semanticStatus === 'passed') {
		semanticReasons.push('All required concepts meet their minimum coverage.');
	}

	if (input.previousSummary) {
		if (input.previousSummary.granularity !== contract.entityGranularity) {
			anomalies.push(
				anomaly(
					'granularity_drift',
					`Entity granularity changed from '${input.previousSummary.granularity}' to '${contract.entityGranularity}'.`,
				),
			);
		}
		if (
			input.previousSummary.status === 'ready' &&
			input.previousSummary.entityCount > 0 &&
			entityCount < input.previousSummary.entityCount * 0.5
		) {
			anomalies.push(
				anomaly(
					'entity_count_drop',
					`Entity count dropped from ${input.previousSummary.entityCount} to ${entityCount}.`,
				),
			);
		}
	}

	const dimensions: CatalogueTrustDimensions = {
		scope: dimension(scopeStatus, scopeReasons),
		records: dimension(recordStatus, recordReasons),
		identity: dimension(identityStatus, identityReasons),
		semantics: dimension(semanticStatus, semanticReasons),
		freshness: dimension('passed', [`Verified at ${verifiedAt}.`]),
	};

	const mergedAnomalies = dedupeAnomalies([...normalizedResultAnomalies, ...anomalies]);

	const summary = deriveCatalogueTrustVerdict(
		{
			scopeLabel: scope.label,
			granularity: contract.entityGranularity,
			entityCount,
			verifiedAt,
			dimensions,
			anomalies: mergedAnomalies,
			countSignals: result.countSignals,
			countComparisons,
			limitations,
			requiredCoverage: semantics.concepts
				.filter((concept) => concept.required)
				.map(({ concept, covered, total, coverage, minimumCoverage }) => ({
					concept,
					covered,
					total,
					coverage,
					minimumCoverage,
				})),
		},
		policy,
	);

	return catalogueTrustReportSchema.parse({
		version: 1,
		policyVersion: 1,
		runId: input.runId,
		configurationHash: input.configurationHash,
		scope,
		contract,
		verificationPlan,
		sourceAssessment: input.sourceAssessment,
		traversals: result.traversals,
		countSignals: result.countSignals,
		countComparisons,
		identity: metrics,
		semantics,
		anomalies: mergedAnomalies,
		summary,
	});
};

const dedupeAnomalies = (anomalies: CatalogueAnomaly[]): CatalogueAnomaly[] => {
	const seen = new Set<string>();
	const merged: CatalogueAnomaly[] = [];
	for (const entry of anomalies) {
		const key = `${entry.code}	${entry.traversalId ?? ''}	${entry.summary}`;
		if (seen.has(key) || merged.length >= 128) {
			continue;
		}
		seen.add(key);
		merged.push(entry);
	}
	return merged;
};

const computeSemantics = (normalized: NormalizedProducts, contract: CatalogueContract): SemanticMetrics => ({
	concepts: contract.requiredConcepts.map((required): SemanticConceptMetric => {
		const covered = normalized.products.filter((product) =>
			conceptCovered(product, normalized, required.concept),
		).length;
		const total = normalized.products.length;
		return {
			concept: required.concept,
			covered,
			total,
			coverage: total === 0 ? 0 : covered / total,
			required: required.required,
			minimumCoverage: required.minimumCoverage,
		};
	}),
});
