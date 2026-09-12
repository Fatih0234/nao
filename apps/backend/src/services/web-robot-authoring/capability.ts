import type { WebRobotRecipe, WebRobotStage } from '@nao/shared/web-robot';
import {
	type CatalogueConceptCapability,
	type CatalogueConceptStatus,
	type CatalogueRequiredConcept,
	catalogueRequiredConceptSchema,
} from '@nao/shared/web-robot-trust';

import { conceptCovered } from '../web-robot-trust/concepts';
import type { NormalizedProducts } from '../web-scraper/records';

type Concept = CatalogueRequiredConcept['concept'];

const ALL_CONCEPTS = catalogueRequiredConceptSchema.shape.concept.options;

const CONCEPT_SOURCE_FIELDS: Record<Concept, string[]> = {
	name: ['name'],
	source_url: ['url', 'source_url', 'canonical_url'],
	stable_identity: [],
	specifications: ['attributes'],
	membership: ['categories'],
	brand: ['brand'],
	description: ['description'],
	price: ['price'],
	availability: ['availability', 'in_stock'],
};

export const conceptCapabilities = (
	recipe: WebRobotRecipe,
	normalized: NormalizedProducts,
): CatalogueConceptCapability[] =>
	ALL_CONCEPTS.map((concept) => {
		const sampled = normalized.products.length;
		const covered = normalized.products.filter((product) => conceptCovered(product, normalized, concept)).length;
		const paths = conceptPaths(recipe, sourceFieldsFor(recipe, concept));
		const status = capabilityStatus(covered, paths);
		return { concept, status, covered, sampled, detail: capabilityDetail(status, paths, sampled) };
	});

const sourceFieldsFor = (recipe: WebRobotRecipe, concept: Concept): string[] =>
	concept === 'stable_identity'
		? [...recipe.identity.fields, 'url', 'source_url', 'canonical_url']
		: CONCEPT_SOURCE_FIELDS[concept];

const conceptPaths = (recipe: WebRobotRecipe, fields: string[]): { listing: boolean; enrichment: boolean } => {
	let listing = false;
	let enrichment = false;
	for (const stage of recipe.stages) {
		if (!fields.some((field) => field in extractFields(stage))) {
			continue;
		}
		if (stage.forEach) {
			enrichment = true;
		} else {
			listing = true;
		}
	}
	return { listing, enrichment };
};

const extractFields = (stage: WebRobotStage): Record<string, unknown> => {
	const extract = stage.extract;
	return extract && 'fields' in extract && typeof extract.fields === 'object'
		? (extract.fields as Record<string, unknown>)
		: {};
};

const capabilityStatus = (
	covered: number,
	paths: { listing: boolean; enrichment: boolean },
): CatalogueConceptStatus => {
	if (covered === 0) {
		return 'not_detected';
	}
	return !paths.listing && paths.enrichment ? 'requires_enrichment' : 'detected';
};

const capabilityDetail = (
	status: CatalogueConceptStatus,
	paths: { listing: boolean; enrichment: boolean },
	sampled: number,
): string => {
	if (sampled === 0) {
		return 'The analysed sample contained no products.';
	}
	if (status === 'requires_enrichment') {
		return 'Collected from each product detail page; the first refresh must visit every product.';
	}
	if (status === 'detected') {
		return 'Found in the analysed sample.';
	}
	return paths.listing || paths.enrichment
		? 'The generated recipe looks for this data, but the analysed sample did not contain it.'
		: 'Not found in the analysed sample.';
};
