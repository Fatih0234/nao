import type {
	CatalogueAnomaly,
	CatalogueGranularity,
	CatalogueTrustDimensions,
	CatalogueTrustSummary,
	CountComparison,
	CountSignal,
	RequiredConceptCoverage,
} from '@nao/shared/web-robot-trust';

export const CATALOGUE_TRUST_POLICY_V1 = {
	version: 1 as const,
	baseCoverage: 1,
	selectedCoverage: 0.95,
	maxIdentityCollisions: 0,
	noProgressConfirmations: 3,
	maxTraversalRestarts: 1,
};

export type CatalogueTrustPolicy = typeof CATALOGUE_TRUST_POLICY_V1;

export type CatalogueVerdictInput = {
	scopeLabel: string;
	granularity: CatalogueGranularity;
	entityCount: number;
	verifiedAt: string;
	dimensions: CatalogueTrustDimensions;
	anomalies: CatalogueAnomaly[];
	countSignals: CountSignal[];
	countComparisons: CountComparison[];
	limitations: string[];
	requiredCoverage: RequiredConceptCoverage[];
};

const SOURCE_GRANULARITY_LIMITATION =
	'Entity granularity is source-defined and may not distinguish families from variants.';

export const deriveCatalogueTrustVerdict = (
	input: CatalogueVerdictInput,
	policy: CatalogueTrustPolicy = CATALOGUE_TRUST_POLICY_V1,
): CatalogueTrustSummary => {
	const blockerCodes = [
		...new Set([
			...input.anomalies.filter((anomaly) => anomaly.severity === 'blocking').map((anomaly) => anomaly.code),
			...Object.entries(input.dimensions)
				.filter(([, dimension]) => dimension.status === 'failed')
				.map(([name]) => `dimension_${name}`),
		]),
	].sort();

	const limitations = new Set(input.limitations);
	if (input.granularity === 'unknown' || input.granularity === 'mixed' || input.granularity === 'source_record') {
		limitations.add(SOURCE_GRANULARITY_LIMITATION);
	}

	const status = blockerCodes.length === 0 ? 'ready' : 'needs_attention';
	let basis: CatalogueTrustSummary['basis'] = 'none';
	if (status === 'ready') {
		const reconciled = input.countComparisons.some(
			(comparison) =>
				(comparison.status === 'match' || comparison.status === 'reconciled') &&
				comparison.signalIds.some((id) =>
					input.countSignals.some(
						(signal) =>
							signal.id === id &&
							signal.comparable &&
							signal.reliability === 'strong' &&
							signal.unit === input.granularity,
					),
				),
		);
		basis = reconciled ? 'count_reconciled' : 'traversal_complete';
	}

	return {
		policyVersion: policy.version,
		status,
		basis,
		scopeLabel: input.scopeLabel,
		entityCount: input.entityCount,
		granularity: input.granularity,
		verifiedAt: input.verifiedAt,
		dimensions: input.dimensions,
		limitations: [...limitations].sort(),
		requiredCoverage: input.requiredCoverage,
		blockerCodes,
	};
};
