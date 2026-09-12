import { type WebRobotRecipe, webRobotRecipeSchema } from '@nao/shared/web-robot';
import { describe, expect, it } from 'vitest';

import { generateDeterministicCandidates } from '../src/services/web-robot-authoring/generate';
import { assessScopeFitness, hasPublishableScopeFitness } from '../src/services/web-robot-authoring/scope-fitness';
import type {
	WebRobotApiCandidate,
	WebRobotDomCandidate,
	WebRobotPageContext,
	WebRobotSourceDiscovery,
} from '../src/services/web-robot-authoring/types';
import {
	createCatalogueVerificationPlan,
	createDefaultCatalogueContract,
} from '../src/services/web-robot-authoring/verification-plan';

const pageContext = (overrides: Partial<WebRobotPageContext> = {}): WebRobotPageContext => ({
	headings: [],
	breadcrumbs: [],
	activeFilters: {},
	displayedCounts: [],
	...overrides,
});

const discovery = (overrides: Partial<WebRobotSourceDiscovery> = {}): WebRobotSourceDiscovery => ({
	url: 'https://example.com/catalogue',
	finalUrl: 'https://example.com/catalogue',
	allowedHosts: ['example.com'],
	apiCandidates: [],
	endpointCandidates: [],
	jsonLdCandidates: [],
	embeddedCandidates: [],
	domCandidates: [],
	detailCandidates: [],
	paginationCandidates: [],
	pageContext: pageContext(),
	browserActionCandidates: [],
	blockers: [],
	warnings: [],
	errors: [],
	...overrides,
});

const apiCandidate = (overrides: Partial<WebRobotApiCandidate> = {}): WebRobotApiCandidate => ({
	kind: 'api',
	url: 'https://example.com/api/items',
	method: 'GET',
	status: 200,
	itemsPath: 'items',
	itemCount: 2,
	fields: {
		url: { path: 'url', required: true, transforms: ['absoluteUrl'] },
		name: { path: 'name', required: true },
		sku: { path: 'sku' },
	},
	fieldNames: ['url', 'name', 'sku'],
	identityField: 'sku',
	urlField: 'url',
	nameField: 'name',
	productUrls: ['https://example.com/products/a', 'https://example.com/products/b'],
	sample: { name: 'A', sku: 'A-1' },
	samples: [{ name: 'A', sku: 'A-1' }],
	recordTypes: ['PRODUCT'],
	technicalFieldPaths: [],
	score: 80,
	...overrides,
});

const domCandidate = (overrides: Partial<WebRobotDomCandidate> = {}): WebRobotDomCandidate => ({
	loader: 'browser',
	itemSelector: '.product',
	itemCount: 9,
	productUrlCount: 9,
	fields: {
		url: { selector: 'a', attr: 'href', required: true, transforms: ['absoluteUrl'] },
		name: { selector: 'a', required: true },
		sku: { selector: '.sku' },
	},
	productUrls: ['https://example.com/products/a', 'https://example.com/products/b'],
	sample: { text: 'A', href: 'https://example.com/products/a' },
	samples: [{ text: 'A', href: 'https://example.com/products/a' }],
	score: 80,
	...overrides,
});

const recipeFor = (paginate?: Record<string, unknown>): WebRobotRecipe =>
	webRobotRecipeSchema.parse({
		version: 2,
		allowedHosts: ['example.com'],
		stages: [
			{
				id: 'products',
				source: { type: 'api', url: 'https://example.com/api/items' },
				...(paginate ? { paginate } : {}),
				extract: {
					type: 'json',
					itemsPath: 'items',
					fields: {
						url: { path: 'url', required: true, transforms: ['absoluteUrl'] },
						name: { path: 'name', required: true },
						sku: { path: 'sku' },
					},
				},
				output: 'product',
			},
		],
	});

describe('web robot scope fitness', () => {
	it('classifies locale/country metadata as control_metadata and not publishable', () => {
		const source = discovery({
			apiCandidates: [
				apiCandidate({
					url: 'https://example.com/api/locales',
					itemsPath: 'locales',
					fields: {
						name: { path: 'name', required: true },
						url: { path: 'url' },
					},
					fieldNames: ['name', 'url'],
					identityField: undefined,
					productUrls: ['https://example.com/de', 'https://example.com/fr'],
					sample: { name: 'Deutsch', code: 'de', url: 'https://example.com/de' },
					samples: [
						{ name: 'Deutsch', code: 'de', url: 'https://example.com/de' },
						{ name: 'France', code: 'FR', url: 'https://example.com/fr' },
					],
					recordTypes: [],
				}),
			],
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.role).toBe('control_metadata');
		expect(result.decision.relation).toBe('unrelated');
		expect(result.decision.entityKind).toBe('non_product');
		expect(hasPublishableScopeFitness(result.decision)).toBe(false);
	});

	it('classifies filtered mixed product/category records as primary exact', () => {
		const source = discovery({
			apiCandidates: [
				apiCandidate({
					recordTypes: ['PRODUCT', 'CATEGORY'],
					where: [{ path: 'resultType', equals: 'PRODUCT' }],
				}),
			],
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.role).toBe('primary_enumerator');
		expect(result.decision.relation).toBe('exact');
		expect(hasPublishableScopeFitness(result.decision)).toBe(true);
	});

	it('classifies a partial listing without pagination as subset and not publishable', () => {
		const source = discovery({
			apiCandidates: [apiCandidate({ itemCount: 12 })],
			pageContext: pageContext({
				displayedCounts: [
					{
						id: 'displayed-count-0',
						value: 605,
						unitLabel: 'results',
						text: '605 results',
						kind: 'total',
						sourceUrl: 'https://example.com/catalogue',
					},
				],
			}),
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.relation).toBe('subset');
		expect(result.decision.role).toBe('corroborating_evidence');
		expect(hasPublishableScopeFitness(result.decision)).toBe(false);
		expect(result.countSignals[0]?.value).toBe(605);
	});

	it('treats showing-all pages with unobserved load-more as exact finite', () => {
		const source = discovery({
			apiCandidates: [
				apiCandidate({
					itemCount: 9,
					recordTypes: ['PRODUCT_FAMILY'],
					fields: { url: { path: 'url' }, name: { path: 'name' } },
					fieldNames: ['url', 'name'],
					identityField: undefined,
				}),
			],
			paginationCandidates: [{ type: 'click', selector: 'button.show-more', observed: false }],
			pageContext: pageContext({
				displayedCounts: [
					{
						id: 'displayed-count-0',
						value: 9,
						unitLabel: 'results',
						text: 'Showing all 9 results',
						kind: 'all_results',
						sourceUrl: 'https://example.com/catalogue',
					},
				],
			}),
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.relation).toBe('exact');
		expect(result.decision.granularity).toBe('family');
		expect(hasPublishableScopeFitness(result.decision)).toBe(true);

		const generated = generateDeterministicCandidates(
			discovery({
				domCandidates: [domCandidate()],
				paginationCandidates: [{ type: 'click', selector: 'button.show-more', observed: false }],
			}),
		).map((candidate) => webRobotRecipeSchema.parse(candidate.recipe));
		expect(generated.every((recipe) => recipe.stages.every((stage) => stage.paginate === undefined))).toBe(true);
	});

	it('scopes search result pages to the search term', () => {
		const source = discovery({
			url: 'https://example.com/search?text=221%20ex',
			finalUrl: 'https://example.com/search?text=221%20ex',
			apiCandidates: [apiCandidate()],
			pageContext: pageContext({ searchTerm: '221 ex' }),
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.scope.label).toContain('Search results');
		expect(result.scope.searchTerm).toBe('221 ex');
		expect(result.decision.relation).toBe('exact');
		expect(hasPublishableScopeFitness(result.decision)).toBe(true);
	});

	it('classifies technical SKU records without URLs as variant enumerators', () => {
		const source = discovery({
			apiCandidates: [
				apiCandidate({
					fields: { name: { path: 'name' }, sku: { path: 'sku' } },
					fieldNames: ['name', 'sku'],
					productUrls: [],
					technicalFieldPaths: ['specifications.voltage', 'specifications.weight'],
				}),
			],
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.role).toBe('primary_enumerator');
		expect(result.decision.granularity).toBe('variant');
		expect(result.decision.entityKind).toBe('product_variant');
		expect(hasPublishableScopeFitness(result.decision)).toBe(true);
	});

	it('keeps generic ITEM record types without product evidence unknown', () => {
		const source = discovery({
			apiCandidates: [
				apiCandidate({
					fields: { name: { path: 'name' } },
					fieldNames: ['name'],
					identityField: undefined,
					urlField: undefined,
					productUrls: [],
					recordTypes: ['ITEM'],
					sample: { name: 'A', code: 'A-1' },
					samples: [{ name: 'A', code: 'A-1' }],
				}),
			],
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.role).toBe('unknown');
		expect(result.decision.relation).toBe('unknown');
		expect(hasPublishableScopeFitness(result.decision)).toBe(false);
	});

	it('resolves count signal unit to the candidate granularity', () => {
		const source = discovery({
			apiCandidates: [apiCandidate({ itemCount: 9 })],
			pageContext: pageContext({
				displayedCounts: [
					{
						id: 'displayed-count-0',
						value: 9,
						unitLabel: 'results',
						text: 'Showing all 9 results',
						kind: 'all_results',
						sourceUrl: 'https://example.com/catalogue',
					},
				],
			}),
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.granularity).toBe('variant');
		expect(result.countSignals[0]?.unit).toBe('variant');
		expect(hasPublishableScopeFitness(result.decision)).toBe(true);
	});

	it('marks extracted counts above a displayed all-results count as overlap', () => {
		const source = discovery({
			apiCandidates: [apiCandidate({ itemCount: 13 })],
			pageContext: pageContext({
				displayedCounts: [
					{
						id: 'displayed-count-0',
						value: 9,
						unitLabel: 'results',
						text: 'Showing all 9 results',
						kind: 'all_results',
						sourceUrl: 'https://example.com/catalogue',
					},
				],
			}),
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.relation).toBe('overlap');
		expect(result.reason).toContain('below 13 extracted items');
		expect(hasPublishableScopeFitness(result.decision)).toBe(false);
	});

	it('rejects generic name/code records as unknown', () => {
		const source = discovery({
			apiCandidates: [
				apiCandidate({
					fields: { name: { path: 'name' } },
					fieldNames: ['name'],
					identityField: undefined,
					urlField: undefined,
					productUrls: [],
					recordTypes: [],
					sample: { name: 'A', code: 'A-1' },
					samples: [{ name: 'A', code: 'A-1' }],
				}),
			],
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.role).toBe('unknown');
		expect(result.decision.relation).toBe('unknown');
		expect(hasPublishableScopeFitness(result.decision)).toBe(false);
	});

	it('blocks publishable fitness when a source blocker contradicts extraction', () => {
		const source = discovery({
			apiCandidates: [apiCandidate()],
			blockers: [{ kind: 'bot_challenge', loader: 'http', message: 'Cloudflare challenge detected.' }],
		});

		const result = assessScopeFitness(source, 'api-0', source.apiCandidates[0], recipeFor());

		expect(result.decision.blockers).toContain('bot_challenge');
		expect(hasPublishableScopeFitness(result.decision)).toBe(false);
	});

	it('maps pagination modes to verification plan traversals', () => {
		const finite = createCatalogueVerificationPlan(recipeFor(), 'scope-current', []);
		expect(finite.traversals[0]).toMatchObject({
			role: 'enumeration',
			required: true,
			mode: 'finite',
			terminalStrategies: ['all_results_displayed', 'count_reconciled', 'next_control_absent'],
		});

		const offset = createCatalogueVerificationPlan(
			recipeFor({ type: 'offset', offsetVariable: 'offset', pageSize: 50, totalPath: 'total' }),
			'scope-current',
			['displayed-count-0'],
		);
		expect(offset.traversals[0]?.mode).toBe('offset');
		expect(offset.traversals[0]?.terminalStrategies).toEqual([
			'offset_reached_total',
			'short_final_page',
			'empty_final_page',
		]);
		expect(offset.countSignalIds).toEqual(['displayed-count-0']);

		const contract = createDefaultCatalogueContract('variant');
		expect(contract.publishWhenReady).toBe(true);
		expect(contract.entityGranularity).toBe('variant');
		expect(contract.requiredConcepts.map((concept) => concept.concept)).toEqual(
			expect.arrayContaining(['name', 'source_url', 'stable_identity', 'specifications', 'membership']),
		);
	});

	it('does not reject a catalogue page as taxonomy when detail pages correlate', () => {
		const productUrl = 'https://www.pedrollo.example/de/product/pumps/4sr-1';
		const source = discovery({
			url: 'https://www.pedrollo.example/de/categoria-prodotto/pumps/',
			finalUrl: 'https://www.pedrollo.example/de/categoria-prodotto/pumps/',
			allowedHosts: ['www.pedrollo.example'],
			domCandidates: [
				domCandidate({
					loader: 'http',
					fields: {
						url: { selector: 'a', attr: 'href', required: true, transforms: ['absoluteUrl'] },
						name: { selector: 'a', required: true },
					},
					productUrls: [productUrl, 'https://www.pedrollo.example/de/product/pumps/4sr-2'],
					sample: { text: '4SR 1', href: productUrl },
					samples: [{ text: '4SR 1', href: productUrl }],
				}),
			],
			detailCandidates: [{ url: productUrl, loader: 'http', hasJsonLdProduct: false, score: 60 }],
		});
		const recipe = recipeFor({ type: 'page', pageVariable: 'page', firstPage: 1, totalPagesPath: 'totalPages' });

		const result = assessScopeFitness(source, 'dom-0', source.domCandidates[0], recipe);

		expect(result.decision.role).toBe('primary_enumerator');
		expect(result.decision.relation).toBe('exact');
		expect(result.decision.entityKind).not.toBe('non_product');
		expect(hasPublishableScopeFitness(result.decision)).toBe(true);
	});
});
