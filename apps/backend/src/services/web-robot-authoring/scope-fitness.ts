import type { WebRobotRecipe } from '@nao/shared/web-robot';
import type {
	CatalogueEntityKind,
	CatalogueGranularity,
	CatalogueScope,
	CatalogueScopeRelation,
	CatalogueSourceRole,
	CountSignal,
	ScopeEvidence,
	ScopeFitnessDecision,
} from '@nao/shared/web-robot-trust';

import {
	buildCountSignals,
	buildScopeEvidence,
	candidateFieldNames,
	candidateItemsPath,
	candidateRecordTypes,
	candidateSourceUrl,
	candidateTechnicalFieldPaths,
	candidateWhere,
	hasProductDiscriminator,
	isProductRecordType,
	normalizedRecordType,
	productLikeUrl,
	type ScopeCandidate,
} from './scope-evidence';
import type { WebRobotSourceDiscovery } from './types';

export type ScopeFitnessResult = {
	scope: CatalogueScope;
	decision: ScopeFitnessDecision;
	evidence: ScopeEvidence[];
	countSignals: CountSignal[];
	reason?: string;
};

const METADATA_MARKER_PATTERN = /(countr|locale|language|region|currenc|website)/i;
const TAXONOMY_MARKER_PATTERN = /(categor|facet|filter|suggest|recommend|configuration|setting)/i;

export const hasPublishableScopeFitness = (decision: ScopeFitnessDecision): boolean => {
	return (
		(decision.role === 'primary_enumerator' || decision.role === 'partition_enumerator') &&
		decision.relation === 'exact' &&
		decision.entityKind !== 'non_product' &&
		decision.entityKind !== 'unknown' &&
		decision.blockers.length === 0
	);
};

export const candidateForGeneratedRecipe = (
	discovery: WebRobotSourceDiscovery,
	candidateId: string,
	_recipe: WebRobotRecipe,
): ScopeCandidate | undefined => {
	if (candidateId.startsWith('model-')) {
		return undefined;
	}
	const deterministic = /^(api|network|embedded|jsonld|dom)-(\d+)(?:-listing|-first-page)?$/.exec(candidateId);
	if (deterministic) {
		const index = Number(deterministic[2]);
		const lists: Record<string, ScopeCandidate[]> = {
			api: discovery.apiCandidates,
			network: discovery.apiCandidates,
			embedded: discovery.embeddedCandidates,
			jsonld: discovery.jsonLdCandidates,
			dom: discovery.domCandidates,
		};
		const candidate = lists[deterministic[1]!]?.[index];
		if (!candidate) {
			return undefined;
		}
		if (deterministic[1] === 'network' && !('kind' in candidate && candidate.kind === 'network')) {
			return undefined;
		}
		return candidate;
	}
	return undefined;
};

export const assessScopeFitness = (
	discovery: WebRobotSourceDiscovery,
	candidateId: string,
	candidate: ScopeCandidate | undefined,
	recipe: WebRobotRecipe,
): ScopeFitnessResult => {
	const evidence = candidate ? buildScopeEvidence(discovery, candidateId, candidate) : [];
	const countSignals = buildCountSignals(discovery);
	const { blocking, limitations } = blockerCodes(discovery);
	const evidenceIds = evidence.map((entry) => entry.id);
	const finish = (
		role: CatalogueSourceRole,
		relation: CatalogueScopeRelation,
		entityKind: CatalogueEntityKind,
		granularity: CatalogueGranularity,
		reason: string | undefined,
	): ScopeFitnessResult => {
		const decision: ScopeFitnessDecision = {
			candidateId,
			role,
			relation,
			entityKind,
			granularity,
			evidenceIds: evidenceIds.slice(0, 64),
			blockers: blocking,
			limitations,
		};
		return {
			scope: buildScope(discovery, candidateId, decision, reason),
			decision,
			evidence,
			countSignals,
			...(reason ? { reason } : {}),
		};
	};

	if (blocking.length) {
		return finish(
			'unknown',
			'unknown',
			'unknown',
			'unknown',
			`Source blocker prevents assessment: ${blocking.join(', ')}`,
		);
	}
	if (!candidate) {
		return finish(
			'unknown',
			'unknown',
			'unknown',
			'unknown',
			'No discovered source candidate matches this recipe.',
		);
	}

	const productDiscriminator = hasProductDiscriminator(candidate, discovery);
	const recordTypes = candidateRecordTypes(candidate);
	const fieldNames = candidateFieldNames(candidate);
	const sourceUrl = candidateSourceUrl(candidate, discovery.finalUrl);
	const shapeHaystack = [
		candidateItemsPath(candidate) ?? '',
		...fieldNames,
		...recordTypes,
		...candidate.samples.slice(0, 3).flatMap((sample) => Object.keys(sample)),
	];
	const detailUrls = new Set(discovery.detailCandidates.map((detail) => detail.url));
	const detailCorrelation = candidate.productUrls.some((url) => detailUrls.has(url));
	const productUrls = candidate.productUrls.filter((url) => productLikeUrl(url, discovery.finalUrl));
	const technicalPaths = candidateTechnicalFieldPaths(candidate);
	const metadataHaystack = [sourceUrl, ...shapeHaystack];
	const metadataMarkers = metadataHaystack.filter((value) => METADATA_MARKER_PATTERN.test(value)).length;
	if (metadataMarkers >= 2 && !productDiscriminator && productUrls.length === 0 && technicalPaths.length === 0) {
		return finish(
			'control_metadata',
			'unrelated',
			'non_product',
			'unknown',
			'Candidate records look like site metadata (locale/country/configuration) rather than products.',
		);
	}
	if (
		shapeHaystack.some((value) => TAXONOMY_MARKER_PATTERN.test(value)) &&
		!productDiscriminator &&
		!detailCorrelation
	) {
		return finish(
			shapeHaystack.some((value) => /categor/i.test(value)) || /categor/i.test(sourceUrl)
				? 'taxonomy_membership'
				: 'control_metadata',
			'unrelated',
			'non_product',
			'unknown',
			'Candidate records look like taxonomy or configuration data rather than products.',
		);
	}

	const structural = productDiscriminator || detailCorrelation;
	if (!structural) {
		return finish(
			'unknown',
			'unknown',
			'unknown',
			'unknown',
			'Candidate has no structural product signal (product type, product detail URLs with stable identifiers, or technical fields).',
		);
	}

	const granularity = granularityFor(recordTypes, fieldNames);
	const entityKind = entityKindFor(granularity);
	const scopedCountSignals = countSignals.map((signal) => ({ ...signal, unit: granularity }));
	const hasPagination = recipe.stages.some((stage) => stage.paginate !== undefined);
	const where = candidateWhere(candidate);
	const mixedRecords =
		!where &&
		recordTypes.some((type) => isProductRecordType(type)) &&
		recordTypes.some((type) => !isProductRecordType(type));
	const displayedValues = discovery.pageContext.displayedCounts.map((count) => count.value);
	const largestDisplayed = Math.max(0, ...displayedValues);
	let relation: CatalogueScopeRelation = 'exact';
	let reason: string | undefined;
	if (mixedRecords) {
		relation = 'overlap';
		reason = 'Candidate mixes product and non-product records without a product filter.';
	} else if (!hasPagination && displayedValues.length > 0) {
		if (displayedValues.includes(candidate.itemCount)) {
			relation = 'exact';
		} else if (new Set(displayedValues).size > 1) {
			relation = 'overlap';
			reason = `Contradictory displayed counts (${displayedValues.join(', ')}) do not match ${candidate.itemCount} extracted items.`;
		} else if (largestDisplayed > candidate.itemCount) {
			relation = 'subset';
			reason = `Displayed count ${largestDisplayed} exceeds ${candidate.itemCount} extracted items without pagination; candidate covers only a subset of the scope.`;
		} else {
			relation = 'overlap';
			reason = `Displayed count ${largestDisplayed} is below ${candidate.itemCount} extracted items; the candidate exceeds the displayed scope.`;
		}
	}

	const role: CatalogueSourceRole = relation === 'exact' ? 'primary_enumerator' : 'corroborating_evidence';
	return { ...finish(role, relation, entityKind, granularity, reason), countSignals: scopedCountSignals };
};

const granularityFor = (recordTypes: string[], fieldNames: string[]): CatalogueGranularity => {
	const normalized = recordTypes.map(normalizedRecordType);
	const hasFamily = normalized.some(
		(type) => type === 'family' || type === 'product_family' || type === 'productfamily',
	);
	const hasVariant = normalized.some(
		(type) => type === 'variant' || type === 'product_variant' || type === 'productvariant',
	);
	const hasOffer = normalized.some((type) => type === 'offer');
	if (hasFamily && hasVariant) {
		return 'mixed';
	}
	if (hasVariant || fieldNames.some((name) => name === 'sku')) {
		return 'variant';
	}
	if (hasFamily) {
		return 'family';
	}
	if (hasOffer) {
		return 'offer';
	}
	return 'source_record';
};

const entityKindFor = (granularity: CatalogueGranularity): CatalogueEntityKind => {
	switch (granularity) {
		case 'family':
			return 'product_family';
		case 'variant':
			return 'product_variant';
		case 'offer':
			return 'offer';
		case 'source_record':
			return 'source_record';
		default:
			return 'source_record';
	}
};

const BLOCKING_KINDS = new Set(['bot_challenge', 'captcha', 'login']);

const blockerCodes = (discovery: WebRobotSourceDiscovery): { blocking: string[]; limitations: string[] } => {
	const browserSucceeded = [
		...discovery.domCandidates,
		...discovery.embeddedCandidates,
		...discovery.jsonLdCandidates,
	].some((candidate) => candidate.loader === 'browser');
	const blocking: string[] = [];
	const limitations: string[] = [];
	for (const blocker of discovery.blockers) {
		if (BLOCKING_KINDS.has(blocker.kind) || (blocker.kind === 'consent' && !browserSucceeded)) {
			blocking.push(blocker.kind);
		} else {
			limitations.push(blocker.kind);
		}
	}
	return { blocking: [...new Set(blocking)], limitations: [...new Set(limitations)] };
};

const buildScope = (
	discovery: WebRobotSourceDiscovery,
	candidateId: string,
	decision: ScopeFitnessDecision,
	reason: string | undefined,
): CatalogueScope => {
	const { pageContext } = discovery;
	const label = pageContext.searchTerm
		? `Search results for “${pageContext.searchTerm}”`.slice(0, 256)
		: (pageContext.headings[0] ?? discovery.title ?? `Catalogue at ${hostnameOf(discovery.finalUrl)}`).slice(
				0,
				256,
			);
	const exactPrimary = decision.role === 'primary_enumerator' && decision.relation === 'exact';
	return {
		version: 1,
		id: 'scope-current',
		label: label || 'Catalogue',
		entryUrl: discovery.url,
		includedUrls: [discovery.finalUrl],
		excludedPatterns: [],
		activeFilters: pageContext.activeFilters,
		...(pageContext.searchTerm ? { searchTerm: pageContext.searchTerm } : {}),
		...(pageContext.locale ? { locale: pageContext.locale } : {}),
		selection: {
			mode: 'automatic',
			candidateId,
			confidence: exactPrimary ? 'high' : 'low',
			rationale: [reason ?? `${decision.role}/${decision.relation} candidate assessment`].slice(0, 16),
		},
	};
};

const hostnameOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return 'source';
	}
};
