import { type WebRobotRecipe, webRobotRecipeSchema } from '@nao/shared/web-robot';
import type { CatalogueConceptCapability } from '@nao/shared/web-robot-trust';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/queries/web-robot.queries', () => ({}));

import { conceptCapabilities } from '../src/services/web-robot-authoring/capability';
import { evidenceFilteredDefaultConcepts } from '../src/services/web-robot-configuration';
import { normalizeProducts } from '../src/services/web-scraper/records';
import type { WebRobotStageRecord } from '../src/services/web-scraper/types';

const recipe = (stages: Record<string, unknown>[]): WebRobotRecipe =>
	webRobotRecipeSchema.parse({ version: 2, allowedHosts: ['example.com'], stages });

const listingStage = (fields: Record<string, unknown>) => ({
	id: 'products',
	source: { type: 'api', url: 'https://example.com/api/products' },
	extract: { type: 'json', itemsPath: 'items', fields },
	output: 'product',
});

const detailStage = (fields: Record<string, unknown>) => ({
	id: 'details',
	forEach: { from: 'products' },
	source: { type: 'http', url: 'https://example.com/detail' },
	extract: { type: 'dom', fields },
	output: 'product',
});

const record = (data: Record<string, unknown>, stageId = 'products'): WebRobotStageRecord => ({
	stageId,
	url: typeof data.url === 'string' ? data.url : undefined,
	data,
});

const capabilitiesFor = (r: WebRobotRecipe, records: WebRobotStageRecord[]) =>
	conceptCapabilities(r, normalizeProducts(records, r, 'run-1'));

const capability = (
	capabilities: CatalogueConceptCapability[],
	concept: CatalogueConceptCapability['concept'],
): CatalogueConceptCapability => {
	const found = capabilities.find((entry) => entry.concept === concept);
	expect(found, `capability for ${concept}`).toBeDefined();
	return found!;
};

describe('concept capabilities', () => {
	it('detects every concept provided by the listing stage', () => {
		const r = recipe([
			listingStage({
				url: { path: 'url' },
				sku: { path: 'sku' },
				name: { path: 'name' },
				brand: { path: 'brand' },
				price: { path: 'price' },
				description: { path: 'description' },
				categories: { path: 'categories', multiple: true },
				attributes: { path: 'attributes' },
				availability: { path: 'availability' },
			}),
		]);
		const records = [
			record({
				url: 'https://example.com/p/1',
				sku: 'A-1',
				name: 'One',
				brand: 'Acme',
				price: 12,
				description: 'First',
				categories: ['Pumps'],
				attributes: { voltage: '230V' },
				availability: 'in stock',
			}),
			record({
				url: 'https://example.com/p/2',
				sku: 'A-2',
				name: 'Two',
				brand: 'Acme',
				price: 20,
				description: 'Second',
				categories: ['Valves'],
				attributes: { voltage: '115V' },
				availability: 'in stock',
			}),
		];

		const capabilities = capabilitiesFor(r, records);

		expect(capabilities).toHaveLength(9);
		for (const concept of [
			'name',
			'source_url',
			'stable_identity',
			'specifications',
			'membership',
			'brand',
			'description',
			'price',
			'availability',
		] as const) {
			expect(capability(capabilities, concept).status, concept).toBe('detected');
			expect(capability(capabilities, concept).covered, concept).toBe(2);
		}
	});

	it('marks concepts that only a detail stage provides as requires_enrichment', () => {
		const r = recipe([
			listingStage({
				url: { path: 'url' },
				sku: { path: 'sku' },
				images: { path: 'imageUri', multiple: true },
			}),
			detailStage({
				name: { selector: 'main h1' },
				sku: { selector: 'main h2' },
				documents: { selector: 'a[href*="pdf" i]', attr: 'href', multiple: true },
			}),
		]);
		const records = [
			record({ url: 'https://example.com/p/1', sku: 'A-1', images: ['https://example.com/1.jpg'] }),
			record({ url: 'https://example.com/p/2', sku: 'A-2', images: ['https://example.com/2.jpg'] }),
			record({ url: 'https://example.com/p/3', sku: 'A-3', images: ['https://example.com/3.jpg'] }),
			record(
				{ url: 'https://example.com/p/1', sku: 'A-1', name: 'One', documents: ['https://example.com/1.pdf'] },
				'details',
			),
			record(
				{ url: 'https://example.com/p/2', sku: 'A-2', name: 'Two', documents: ['https://example.com/2.pdf'] },
				'details',
			),
			record(
				{ url: 'https://example.com/p/3', sku: 'A-3', name: 'Three', documents: ['https://example.com/3.pdf'] },
				'details',
			),
		];

		const capabilities = capabilitiesFor(r, records);
		const name = capability(capabilities, 'name');

		expect(name.status).toBe('requires_enrichment');
		expect(name.covered).toBe(3);
		expect(name.sampled).toBe(3);
		expect(name.detail).toContain('detail page');
		expect(capability(capabilities, 'source_url').status).toBe('detected');
		expect(capability(capabilities, 'stable_identity').status).toBe('detected');
		expect(capability(capabilities, 'specifications').status).toBe('not_detected');
		expect(capability(capabilities, 'membership').status).toBe('not_detected');
		expect(capability(capabilities, 'brand').status).toBe('not_detected');
	});

	it('reports partial enrichment coverage over the merged sample', () => {
		const r = recipe([
			listingStage({ url: { path: 'url' }, sku: { path: 'sku' } }),
			detailStage({ name: { selector: 'main h1' } }),
		]);
		const records = [
			record({ url: 'https://example.com/p/1', sku: 'A-1' }),
			record({ url: 'https://example.com/p/2', sku: 'A-2' }),
			record({ url: 'https://example.com/p/3', sku: 'A-3' }),
			record({ url: 'https://example.com/p/4', sku: 'A-4' }),
			record({ url: 'https://example.com/p/1', sku: 'A-1', name: 'One' }, 'details'),
			record({ url: 'https://example.com/p/2', sku: 'A-2', name: 'Two' }, 'details'),
		];

		const name = capability(capabilitiesFor(r, records), 'name');

		expect(name.status).toBe('requires_enrichment');
		expect(name.covered).toBe(2);
		expect(name.sampled).toBe(4);
	});

	it('marks declared fields that produce nothing as not_detected', () => {
		const r = recipe([
			listingStage({
				url: { path: 'url' },
				sku: { path: 'sku' },
				name: { path: 'name' },
				categories: { path: 'categories', multiple: true },
			}),
			detailStage({ attributes: { each: 'table tr' } }),
		]);
		const records = [
			record({ url: 'https://example.com/p/1', sku: 'A-1', name: 'One' }),
			record({ url: 'https://example.com/p/2', sku: 'A-2', name: 'Two' }),
		];

		const capabilities = capabilitiesFor(r, records);
		const membership = capability(capabilities, 'membership');
		const specifications = capability(capabilities, 'specifications');

		expect(membership.status).toBe('not_detected');
		expect(membership.detail).toContain('recipe looks for this data');
		expect(specifications.status).toBe('not_detected');
		expect(specifications.detail).toContain('recipe looks for this data');
	});

	it('marks concepts with no recipe path and no sample evidence as not_detected', () => {
		const r = recipe([listingStage({ url: { path: 'url' }, sku: { path: 'sku' }, name: { path: 'name' } })]);
		const records = [record({ url: 'https://example.com/p/1', sku: 'A-1', name: 'One' })];

		const price = capability(capabilitiesFor(r, records), 'price');

		expect(price.status).toBe('not_detected');
		expect(price.detail).toBe('Not found in the analysed sample.');
	});

	it('treats url-derived identity and source URLs as detected', () => {
		const r = recipe([listingStage({ url: { path: 'url' }, name: { path: 'name' } })]);
		const records = [
			record({ url: 'https://example.com/p/1', name: 'One' }),
			record({ url: 'https://example.com/p/2', name: 'Two' }),
		];

		const capabilities = capabilitiesFor(r, records);

		expect(capability(capabilities, 'source_url').status).toBe('detected');
		expect(capability(capabilities, 'stable_identity').status).toBe('detected');
		expect(capability(capabilities, 'stable_identity').covered).toBe(2);
	});

	it('detects specifications provided by a detail-stage attributes field', () => {
		const r = recipe([
			listingStage({ url: { path: 'url' }, sku: { path: 'sku' } }),
			detailStage({ attributes: { each: 'table tr' } }),
		]);
		const records = [
			record({ url: 'https://example.com/p/1', sku: 'A-1' }),
			record({ url: 'https://example.com/p/1', sku: 'A-1', attributes: { voltage: '230V' } }, 'details'),
		];

		const specifications = capability(capabilitiesFor(r, records), 'specifications');

		expect(specifications.status).toBe('requires_enrichment');
		expect(specifications.covered).toBe(1);
	});
});

describe('evidenceFilteredDefaultConcepts', () => {
	const capabilities = (overrides: Partial<Record<string, string>>): CatalogueConceptCapability[] =>
		[
			'name',
			'source_url',
			'stable_identity',
			'specifications',
			'membership',
			'brand',
			'description',
			'price',
			'availability',
		].map((concept) => ({
			concept: concept as CatalogueConceptCapability['concept'],
			status: (overrides[concept] ?? 'detected') as CatalogueConceptCapability['status'],
			covered: 1,
			sampled: 1,
			detail: '',
		}));

	it('keeps the defaults when everything is detected', () => {
		expect(evidenceFilteredDefaultConcepts(capabilities({}))).toEqual(['specifications', 'membership']);
	});

	it('drops undetected defaults and keeps enrichment-backed ones', () => {
		expect(
			evidenceFilteredDefaultConcepts(
				capabilities({ membership: 'not_detected', specifications: 'requires_enrichment' }),
			),
		).toEqual(['specifications']);
	});
});
