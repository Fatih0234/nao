import type { SemanticConceptMetric } from '@nao/shared/web-robot-trust';

import type { NormalizedProducts } from '../web-scraper/records';

export const conceptCovered = (
	product: Record<string, unknown>,
	normalized: NormalizedProducts,
	concept: SemanticConceptMetric['concept'],
): boolean => {
	const key = typeof product.product_key === 'string' ? product.product_key : '';
	switch (concept) {
		case 'name':
			return nonEmpty(product.name);
		case 'source_url':
			return nonEmpty(product.source_url) || nonEmpty(product.canonical_url);
		case 'stable_identity':
			return key.length > 0 && !key.startsWith('record:');
		case 'specifications':
			return (
				(normalized.attributes ?? []).some((row) => row.product_key === key) ||
				nonEmptyJson(product.attributes_json)
			);
		case 'membership':
			return nonEmptyJson(product.categories_json);
		case 'brand':
			return nonEmpty(product.brand);
		case 'description':
			return nonEmpty(product.description);
		case 'price':
			return product.price !== undefined && product.price !== null && product.price !== '';
		case 'availability': {
			const raw = parseJson(product.raw_json);
			return (
				!!raw &&
				typeof raw === 'object' &&
				(nonEmpty((raw as Record<string, unknown>).availability) ||
					nonEmpty((raw as Record<string, unknown>).in_stock))
			);
		}
	}
};

const nonEmpty = (value: unknown): boolean =>
	typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;

const parseJson = (value: unknown): unknown => {
	if (typeof value !== 'string' || !value) {
		return undefined;
	}
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
};

const nonEmptyJson = (value: unknown): boolean => {
	const parsed = parseJson(value);
	if (parsed === null || parsed === undefined) {
		return false;
	}
	if (Array.isArray(parsed)) {
		return parsed.length > 0;
	}
	if (typeof parsed === 'object') {
		return Object.keys(parsed as Record<string, unknown>).length > 0;
	}
	return typeof parsed === 'string' ? parsed.trim().length > 0 : true;
};
