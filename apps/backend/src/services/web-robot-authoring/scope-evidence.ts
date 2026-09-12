import type { CountSignal, ScopeEvidence } from '@nao/shared/web-robot-trust';

import type {
	WebRobotApiCandidate,
	WebRobotDomCandidate,
	WebRobotEmbeddedCandidate,
	WebRobotJsonLdCandidate,
	WebRobotSourceDiscovery,
} from './types';

export type ScopeCandidate =
	| WebRobotApiCandidate
	| WebRobotJsonLdCandidate
	| WebRobotEmbeddedCandidate
	| WebRobotDomCandidate;

const PRODUCT_LIKE_PATH_PATTERN =
	/(?:^|\/)(?:p|product|products|produkt|produkte|produits|prodotti|item|article|part|sku|detail)(?:\/|$)/i;

export const productLikeUrl = (rawUrl: string, baseUrl: string): boolean => {
	try {
		const url = new URL(rawUrl, baseUrl);
		const base = new URL(baseUrl);
		return url.hostname === base.hostname && PRODUCT_LIKE_PATH_PATTERN.test(url.pathname);
	} catch {
		return false;
	}
};

export const candidateFieldNames = (candidate: ScopeCandidate): string[] => {
	if ('fieldNames' in candidate) {
		return candidate.fieldNames;
	}
	return Object.keys(candidate.fields);
};

export const candidateIdentityField = (candidate: ScopeCandidate): string | undefined => {
	if ('identityField' in candidate) {
		return candidate.identityField;
	}
	return undefined;
};

export const candidateRecordTypes = (candidate: ScopeCandidate): string[] => {
	if ('recordTypes' in candidate) {
		return candidate.recordTypes;
	}
	if ('schemaType' in candidate) {
		return [candidate.schemaType];
	}
	if ('schemaTypes' in candidate) {
		return candidate.schemaTypes ?? [];
	}
	return [];
};

export const candidateTechnicalFieldPaths = (candidate: ScopeCandidate): string[] => {
	if ('technicalFieldPaths' in candidate) {
		return candidate.technicalFieldPaths;
	}
	return [];
};

export const candidateItemsPath = (candidate: ScopeCandidate): string | undefined => {
	return 'itemsPath' in candidate ? candidate.itemsPath : undefined;
};

export const candidateWhere = (candidate: ScopeCandidate) => {
	return 'where' in candidate ? candidate.where : undefined;
};

export const candidateSourceUrl = (candidate: ScopeCandidate, fallbackUrl: string): string => {
	if ('url' in candidate) {
		return candidate.url;
	}
	return 'pageUrl' in candidate ? candidate.pageUrl : fallbackUrl;
};

const REDACTED_KEY_PATTERN = /(token|secret|password|authorization|cookie|session|cursor)/i;

const sanitizeValue = (value: unknown, depth: number): unknown => {
	if (typeof value === 'string') {
		return value.length > 300 ? `${value.slice(0, 300)}…` : value;
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (depth >= 4) {
		return undefined;
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, 16)
			.map((entry) => sanitizeValue(entry, depth + 1))
			.filter((entry) => entry !== undefined);
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([key]) => !REDACTED_KEY_PATTERN.test(key))
		.slice(0, 32)
		.map(([key, entry]) => [key, sanitizeValue(entry, depth + 1)] as const)
		.filter(([, entry]) => entry !== undefined);
	return Object.fromEntries(entries);
};

export const sanitizeEvidenceDetails = (details: Record<string, unknown>): Record<string, unknown> => {
	return Object.fromEntries(
		Object.entries(details)
			.filter(([key]) => !REDACTED_KEY_PATTERN.test(key))
			.slice(0, 32)
			.map(([key, value]) => [key, sanitizeValue(value, 0)] as const)
			.filter(([, value]) => value !== undefined),
	);
};

const PRODUCT_DISCRIMINATOR_TYPES = new Set([
	'product',
	'product_family',
	'productfamily',
	'family',
	'product_variant',
	'productvariant',
	'variant',
	'offer',
]);

export const normalizedRecordType = (value: string): string =>
	value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_');

export const isProductRecordType = (value: string): boolean =>
	PRODUCT_DISCRIMINATOR_TYPES.has(normalizedRecordType(value));

const STABLE_ID_FIELD_PATTERN = /^(sku|external_?id)$/i;

export const candidateHasStableIdentity = (candidate: ScopeCandidate): boolean => {
	return (
		Boolean(candidateIdentityField(candidate)) ||
		candidateFieldNames(candidate).some((name) => STABLE_ID_FIELD_PATTERN.test(name))
	);
};

export const hasProductDiscriminator = (candidate: ScopeCandidate, discovery: WebRobotSourceDiscovery): boolean => {
	if (candidateRecordTypes(candidate).some((type) => isProductRecordType(type))) {
		return true;
	}
	const stableIdentity = candidateHasStableIdentity(candidate);
	if (candidate.productUrls.some((url) => productLikeUrl(url, discovery.finalUrl)) && stableIdentity) {
		return true;
	}
	return stableIdentity && candidateTechnicalFieldPaths(candidate).length > 0;
};

export const buildScopeEvidence = (
	discovery: WebRobotSourceDiscovery,
	candidateId: string,
	candidate: ScopeCandidate,
): ScopeEvidence[] => {
	const evidence: ScopeEvidence[] = [];
	const observedAt = new Date().toISOString();
	const push = (
		id: string,
		kind: ScopeEvidence['kind'],
		strength: ScopeEvidence['strength'],
		summary: string,
		details: Record<string, unknown> = {},
		sourceUrl = discovery.finalUrl,
	) => {
		evidence.push({
			id,
			kind,
			sourceUrl,
			observedAt,
			strength,
			summary,
			details: sanitizeEvidenceDetails(details),
		});
	};

	const recordTypes = candidateRecordTypes(candidate);
	const productTypes = recordTypes.filter((type) => isProductRecordType(type));
	if (recordTypes.length || productTypes.length) {
		push(
			`${candidateId}-product_type-0`,
			'product_type',
			productTypes.length ? 'strong' : 'weak',
			productTypes.length
				? `Records carry product type ${productTypes.slice(0, 4).join(', ')}`
				: `Record types ${recordTypes.slice(0, 4).join(', ')}`,
			{ recordTypes, productTypes },
			candidateSourceUrl(candidate, discovery.finalUrl),
		);
	}

	const productUrls = candidate.productUrls.filter((url) => productLikeUrl(url, discovery.finalUrl));
	if (productUrls.length) {
		push(
			`${candidateId}-product_url-0`,
			'product_url',
			'strong',
			`${productUrls.length} product-like URLs observed`,
			{ urls: productUrls.slice(0, 8) },
			candidateSourceUrl(candidate, discovery.finalUrl),
		);
	}

	const identityField = candidateIdentityField(candidate);
	const fieldNames = candidateFieldNames(candidate);
	const identityKeys = [identityField, ...fieldNames.filter((name) => /^(sku|external_?id)$/.test(name))].filter(
		(name): name is string => Boolean(name),
	);
	if (identityKeys.length) {
		push(
			`${candidateId}-stable_identifier-0`,
			'stable_identifier',
			'strong',
			`Stable identifier field ${[...new Set(identityKeys)][0]}`,
			{ fields: [...new Set(identityKeys)] },
			candidateSourceUrl(candidate, discovery.finalUrl),
		);
	}

	const detailUrls = new Set(discovery.detailCandidates.map((detail) => detail.url));
	const correlated = candidate.productUrls.filter((url) => detailUrls.has(url));
	if (correlated.length) {
		push(
			`${candidateId}-detail_correlation-0`,
			'detail_correlation',
			'moderate',
			`${correlated.length} candidate URLs matched inspected product detail pages`,
			{ urls: correlated.slice(0, 8) },
			candidateSourceUrl(candidate, discovery.finalUrl),
		);
	}

	const technicalPaths = candidateTechnicalFieldPaths(candidate);
	if (technicalPaths.length) {
		push(
			`${candidateId}-technical_properties-0`,
			'technical_properties',
			'moderate',
			`${technicalPaths.length} technical field paths observed`,
			{ paths: technicalPaths.slice(0, 16) },
			candidateSourceUrl(candidate, discovery.finalUrl),
		);
	}

	discovery.pageContext.displayedCounts.forEach((count, index) => {
		push(
			`count-${index}`,
			'displayed_count',
			count.kind === 'all_results' ? 'strong' : 'moderate',
			count.text || `Displayed count ${count.value} ${count.unitLabel}`,
			{ value: count.value, unitLabel: count.unitLabel, kind: count.kind },
			count.sourceUrl,
		);
	});

	Object.entries(discovery.pageContext.activeFilters).forEach(([key, value], index) => {
		push(`filter-${index}`, 'active_filter', 'moderate', `Active filter ${key}`, { key, value });
	});

	if (discovery.pageContext.searchTerm) {
		push('search-0', 'search_scope', 'strong', `Search results for “${discovery.pageContext.searchTerm}”`, {
			term: discovery.pageContext.searchTerm,
		});
	}

	discovery.blockers.forEach((blocker, index) => {
		push(`blocker-${index}`, 'blocker', 'strong', `Source blocker ${blocker.kind}`, {
			kind: blocker.kind,
			status: blocker.status,
		});
	});

	const surface = {
		title: discovery.title,
		headings: discovery.pageContext.headings,
		breadcrumbs: discovery.pageContext.breadcrumbs,
	};
	if (surface.title || surface.headings.length || surface.breadcrumbs.length) {
		push('surface-0', 'surface_signature', 'weak', 'Page surface signature', surface);
	}

	return evidence.slice(0, 64);
};

export const buildCountSignals = (discovery: WebRobotSourceDiscovery): CountSignal[] => {
	const observedAt = new Date().toISOString();
	return discovery.pageContext.displayedCounts.slice(0, 8).map((count) => ({
		id: count.id,
		value: count.value,
		unit: 'source_record',
		source: 'displayed',
		scopeId: 'scope-current',
		reliability: count.kind === 'all_results' ? 'strong' : 'moderate',
		observedAt,
		comparable: true,
	}));
};
