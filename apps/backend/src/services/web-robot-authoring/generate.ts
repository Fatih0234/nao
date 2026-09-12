import type { WebRobotBrowserAction, WebRobotRecipe, WebRobotStage, WebRobotTransform } from '@nao/shared/web-robot';

import type {
	WebRobotApiCandidate,
	WebRobotDetailCandidate,
	WebRobotDomCandidate,
	WebRobotEmbeddedCandidate,
	WebRobotJsonLdCandidate,
	WebRobotPaginationCandidate,
	WebRobotSourceDiscovery,
} from './types';

export type GeneratedWebRobotCandidate = {
	id: string;
	strategy: string;
	recipe: unknown;
};

export const generateDeterministicCandidates = (discovery: WebRobotSourceDiscovery): GeneratedWebRobotCandidate[] => {
	const candidates: GeneratedWebRobotCandidate[] = [];
	for (const [index, candidate] of discovery.apiCandidates.entries()) {
		if (candidate.method === 'GET' || (candidate.method === 'POST' && candidate.requestBody !== undefined)) {
			candidates.push({ id: `api-${index}`, strategy: 'api-json', recipe: apiRecipe(discovery, candidate) });
		}
		if (candidate.kind === 'network' && candidate.captureName && candidate.capturePattern) {
			candidates.push({
				id: `network-${index}`,
				strategy: 'browser-network',
				recipe: networkRecipe(discovery, candidate),
			});
		}
	}
	for (const [index, candidate] of discovery.embeddedCandidates.entries()) {
		candidates.push({
			id: `embedded-${index}`,
			strategy: `${candidate.loader}-embedded-${candidate.source}`,
			recipe: embeddedRecipe(discovery, candidate),
		});
	}
	for (const [index, candidate] of discovery.domCandidates.entries()) {
		candidates.push({
			id: `dom-${index}`,
			strategy: `${candidate.loader}-dom`,
			recipe: domRecipe(discovery, candidate),
		});
		const pagination = paginationFor(
			discovery.paginationCandidates,
			candidate.loader === 'browser' ? ['nextLink', 'click', 'scroll'] : ['nextLink'],
			candidate.itemCount,
		);
		const hasDetail = candidate.fields.url && bestDetail(discovery) !== undefined;
		if (pagination) {
			candidates.push({
				id: `dom-${index}-listing`,
				strategy: `${candidate.loader}-dom-listing`,
				recipe: domRecipe(discovery, candidate, { details: false }),
			});
		}
		if (hasDetail || pagination) {
			candidates.push({
				id: `dom-${index}-first-page`,
				strategy: `${candidate.loader}-dom-first-page`,
				recipe: domRecipe(discovery, candidate, { details: false, pagination: false }),
			});
		}
	}
	for (const [index, candidate] of discovery.jsonLdCandidates.entries()) {
		candidates.push({ id: `jsonld-${index}`, strategy: 'json-ld', recipe: jsonLdRecipe(discovery, candidate) });
	}
	return candidates;
};

export const sanitizeAuthoredRecipe = (recipe: WebRobotRecipe, discovery: WebRobotSourceDiscovery): WebRobotRecipe => {
	return {
		...recipe,
		allowedHosts: discovery.allowedHosts,
		respectRobotsTxt: false,
		request: {
			concurrency: 1,
			delayMs: Math.max(500, recipe.request.delayMs),
			timeoutMs: Math.min(Math.max(recipe.request.timeoutMs, 5_000), 30_000),
			retries: Math.min(recipe.request.retries, 2),
			userAgent: recipe.request.userAgent,
		},
		limits: {
			maxPages: Math.min(recipe.limits.maxPages, LIMITS_CEILING.maxPages),
			maxItems: Math.min(recipe.limits.maxItems, LIMITS_CEILING.maxItems),
			maxRequests: Math.min(recipe.limits.maxRequests, LIMITS_CEILING.maxRequests),
			maxDurationMs: Math.min(recipe.limits.maxDurationMs, LIMITS_CEILING.maxDurationMs),
			maxResponseBytes: Math.min(recipe.limits.maxResponseBytes, 5 * 1024 * 1024),
		},
		publish: {
			minItems: Math.max(1, recipe.publish.minItems),
			maxRemovedPercent: Math.min(recipe.publish.maxRemovedPercent, 50),
		},
		stages: recipe.stages.slice(0, 8).map((stage) => sanitizeStage(stage, discovery)),
	};
};

const apiRecipe = (discovery: WebRobotSourceDiscovery, candidate: WebRobotApiCandidate): Record<string, unknown> => {
	const detail = candidate.fields.url ? bestDetail(discovery) : undefined;
	const pagination = paginationFor(
		discovery.paginationCandidates,
		['nextPath', 'cursor', 'offset', 'page'],
		candidate.itemCount,
	);
	const paginate = pagination?.paginate;
	const method = candidate.method === 'POST' ? 'POST' : 'GET';
	const listing = listingStage(
		'products',
		{
			type: 'api',
			url: baseUrl(candidate.url),
			method,
			query: apiQuery(candidate.url, paginate, method),
			headers: candidate.requestContentType ? { 'content-type': candidate.requestContentType } : {},
			...(method === 'POST' ? { body: apiRequestBody(candidate.requestBody, paginate) } : {}),
		},
		{
			type: 'json',
			itemsPath: candidate.itemsPath,
			...(candidate.where ? { where: candidate.where } : {}),
			fields: jsonFields(candidate.fields),
		},
		paginate,
		!detail,
	);
	return recipe(discovery, candidate, detail ? [listing, detailStage(detail)] : [listing], {
		pagination: pagination?.candidate,
		itemCount: candidate.itemCount,
		hasDetail: detail !== undefined,
	});
};

const networkRecipe = (
	discovery: WebRobotSourceDiscovery,
	candidate: WebRobotApiCandidate,
): Record<string, unknown> => {
	const detail = candidate.fields.url ? bestDetail(discovery) : undefined;
	const pagination = paginationFor(
		discovery.paginationCandidates,
		['nextLink', 'click', 'scroll'],
		candidate.itemCount,
	);
	const paginate = pagination?.paginate;
	const listing = listingStage(
		'products',
		{
			type: 'browser',
			url: discovery.finalUrl,
			headers: {},
			viewport: { width: 1440, height: 1000 },
			actions: browserSourceActions(discovery, undefined, paginate?.type === 'scroll'),
			capture: [{ name: candidate.captureName!, urlPattern: candidate.capturePattern!, body: 'json' }],
		},
		{
			type: 'network',
			capture: candidate.captureName!,
			itemsPath: candidate.itemsPath,
			fields: jsonFields(candidate.fields),
		},
		paginate,
		!detail,
	);
	return recipe(discovery, candidate, detail ? [listing, detailStage(detail)] : [listing], {
		pagination: pagination?.candidate,
		itemCount: candidate.itemCount,
		hasDetail: detail !== undefined,
	});
};

const domRecipe = (
	discovery: WebRobotSourceDiscovery,
	candidate: WebRobotDomCandidate,
	options: { details?: boolean; pagination?: boolean } = {},
): Record<string, unknown> => {
	const detail = options.details !== false && candidate.fields.url ? bestDetail(discovery) : undefined;
	const pagination =
		options.pagination === false
			? undefined
			: paginationFor(
					discovery.paginationCandidates,
					candidate.loader === 'browser' ? ['nextLink', 'click', 'scroll'] : ['nextLink'],
					candidate.itemCount,
				);
	const paginate = pagination?.paginate;
	const source =
		candidate.loader === 'browser'
			? {
					type: 'browser' as const,
					url: discovery.finalUrl,
					headers: {},
					viewport: { width: 1440, height: 1000 },
					actions: browserSourceActions(discovery, candidate.itemSelector, paginate?.type === 'scroll'),
					capture: [],
				}
			: { type: 'http' as const, url: discovery.finalUrl, method: 'GET' as const, headers: {} };
	const listing = listingStage(
		'products',
		source,
		{
			type: 'dom',
			itemSelector: candidate.itemSelector,
			...(candidate.itemSelectors ? { itemSelectors: candidate.itemSelectors } : {}),
			...(candidate.itemFingerprint ? { itemFingerprint: candidate.itemFingerprint } : {}),
			fields: domFields(candidate.fields),
		},
		paginate,
		!detail,
	);
	return recipe(
		discovery,
		{ fields: {}, identityField: undefined },
		detail ? [listing, detailStage(detail)] : [listing],
		{ pagination: pagination?.candidate, itemCount: candidate.itemCount, hasDetail: detail !== undefined },
	);
};

const jsonLdRecipe = (
	discovery: WebRobotSourceDiscovery,
	candidate: WebRobotJsonLdCandidate,
): Record<string, unknown> => {
	const fields =
		candidate.schemaType === 'ListItem' || candidate.schemaType === 'ItemList'
			? {
					url: { path: 'item.url', required: true, transforms: ['absoluteUrl'] },
					name: { path: 'item.name', required: true },
					sku: { path: 'item.sku' },
					images: { path: 'item.image', multiple: true, transforms: ['absoluteUrl'] },
				}
			: candidate.fields;
	const detail = candidate.schemaType !== 'Product' && fields.url ? bestDetail(discovery) : undefined;
	const pagination = paginationFor(
		discovery.paginationCandidates,
		candidate.loader === 'browser' ? ['nextLink', 'click', 'scroll'] : ['nextLink'],
		candidate.itemCount,
	);
	const paginate = pagination?.paginate;
	const source =
		candidate.loader === 'browser'
			? {
					type: 'browser' as const,
					url: discovery.finalUrl,
					headers: {},
					viewport: { width: 1440, height: 1000 },
					actions: browserSourceActions(discovery, undefined, paginate?.type === 'scroll'),
					capture: [],
				}
			: { type: 'http' as const, url: candidate.pageUrl, method: 'GET' as const, headers: {} };
	const listing = listingStage(
		'products',
		source,
		{ type: 'jsonld', schemaTypes: [candidate.schemaType], fields: jsonFields(fields) },
		paginate,
		!detail,
	);
	return recipe(
		discovery,
		{ fields, identityField: fields.sku?.path },
		detail ? [listing, detailStage(detail)] : [listing],
		{ pagination: pagination?.candidate, itemCount: candidate.itemCount, hasDetail: detail !== undefined },
	);
};

const embeddedRecipe = (
	discovery: WebRobotSourceDiscovery,
	candidate: WebRobotEmbeddedCandidate,
): Record<string, unknown> => {
	const detail = candidate.fields.url ? bestDetail(discovery) : undefined;
	const pagination = paginationFor(
		discovery.paginationCandidates,
		candidate.loader === 'browser' ? ['nextLink', 'click', 'scroll'] : ['nextLink'],
		candidate.itemCount,
	);
	const paginate = pagination?.paginate;
	const source =
		candidate.loader === 'browser'
			? {
					type: 'browser' as const,
					url: discovery.finalUrl,
					headers: {},
					viewport: { width: 1440, height: 1000 },
					actions: browserSourceActions(discovery, undefined, paginate?.type === 'scroll'),
					capture: [],
				}
			: { type: 'http' as const, url: candidate.pageUrl, method: 'GET' as const, headers: {} };
	const listing = listingStage(
		'products',
		source,
		{
			type: 'embedded',
			sources: [candidate.source],
			...(candidate.itemsPath ? { itemsPath: candidate.itemsPath } : {}),
			...(candidate.schemaTypes ? { schemaTypes: candidate.schemaTypes } : {}),
			...(candidate.where ? { where: candidate.where } : {}),
			fields: jsonFields(candidate.fields),
		},
		paginate,
		!detail,
	);
	return recipe(
		discovery,
		{ fields: candidate.fields, identityField: candidate.fields.sku?.path },
		detail ? [listing, detailStage(detail)] : [listing],
		{ pagination: pagination?.candidate, itemCount: candidate.itemCount, hasDetail: detail !== undefined },
	);
};

const recipe = (
	discovery: WebRobotSourceDiscovery,
	candidate: Pick<WebRobotApiCandidate, 'fields'> & { identityField?: string },
	stages: Record<string, unknown>[],
	volume: RecipeVolume,
): Record<string, unknown> => ({
	version: 2,
	allowedHosts: discovery.allowedHosts,
	request: {
		concurrency: 1,
		delayMs: GENERATED_DELAY_MS,
		timeoutMs: 20_000,
		retries: 2,
		userAgent: 'nao-web-robot/1.0',
	},
	limits: sizedLimits(volume),
	publish: { minItems: 1, maxRemovedPercent: 50 },
	identity: { strategy: 'first_present', fields: identityFields(candidate) },
	respectRobotsTxt: false,
	stages,
});

type RecipeVolume = {
	pagination?: WebRobotPaginationCandidate;
	itemCount?: number;
	hasDetail: boolean;
};

const GENERATED_DELAY_MS = 500;
const LIMIT_HEADROOM = 1.25;
const FETCH_TIME_ALLOWANCE_MS = 2_000;
const LIMITS_FLOOR = {
	maxPages: 100,
	maxItems: 2_000,
	maxRequests: 1_000,
	maxDurationMs: 15 * 60_000,
} as const;
const LIMITS_CEILING = {
	maxPages: 5_000,
	maxItems: 50_000,
	maxRequests: 25_000,
	maxDurationMs: 2 * 60 * 60_000,
} as const;

const clampLimit = (value: number, floor: number, ceiling: number): number => Math.min(ceiling, Math.max(floor, value));

const declaredListingPages = (
	candidate: WebRobotPaginationCandidate | undefined,
	itemCount?: number,
): number | undefined => {
	if (candidate?.type === 'page') {
		if (candidate.declaredPages !== undefined) {
			return candidate.declaredPages;
		}
		if (candidate.declaredItems !== undefined && itemCount !== undefined && itemCount > 0) {
			return Math.max(1, Math.ceil(candidate.declaredItems / itemCount));
		}
		return undefined;
	}
	if (candidate?.type === 'offset' && candidate.declaredItems !== undefined) {
		return Math.max(1, Math.ceil(candidate.declaredItems / candidate.pageSize));
	}
	return undefined;
};

const declaredItemTotal = (candidate: WebRobotPaginationCandidate | undefined): number | undefined =>
	candidate?.type === 'page' || candidate?.type === 'offset' ? candidate.declaredItems : undefined;

const sizedPaginateMaxPages = (listingPages?: number): number =>
	clampLimit(Math.ceil((listingPages ?? 0) * LIMIT_HEADROOM), LIMITS_FLOOR.maxPages, LIMITS_CEILING.maxPages);

const sizedLimits = (volume: RecipeVolume): WebRobotRecipe['limits'] => {
	const listingPages = declaredListingPages(volume.pagination, volume.itemCount) ?? 1;
	const expectedItems =
		declaredItemTotal(volume.pagination) ?? (volume.itemCount !== undefined ? volume.itemCount * listingPages : 0);
	const fetches = listingPages + (volume.hasDetail ? expectedItems : 0);
	const fetchBudget = Math.ceil(fetches * LIMIT_HEADROOM);
	const duration = Math.ceil(fetches * (GENERATED_DELAY_MS + FETCH_TIME_ALLOWANCE_MS) * LIMIT_HEADROOM);
	return {
		maxPages: clampLimit(fetchBudget, LIMITS_FLOOR.maxPages, LIMITS_CEILING.maxPages),
		maxItems: clampLimit(Math.ceil(expectedItems * LIMIT_HEADROOM), LIMITS_FLOOR.maxItems, LIMITS_CEILING.maxItems),
		maxRequests: clampLimit(fetchBudget, LIMITS_FLOOR.maxRequests, LIMITS_CEILING.maxRequests),
		maxDurationMs: clampLimit(duration, LIMITS_FLOOR.maxDurationMs, LIMITS_CEILING.maxDurationMs),
		maxResponseBytes: 5 * 1024 * 1024,
	};
};

const listingStage = (
	id: string,
	source: Record<string, unknown>,
	extract: Record<string, unknown>,
	paginate: Record<string, unknown> | undefined,
	outputProduct: boolean,
): Record<string, unknown> => ({
	id,
	source,
	...(paginate ? { paginate } : {}),
	extract,
	emit: 'products',
	...(outputProduct ? { output: 'product' as const } : {}),
});

const detailStage = (detail: WebRobotDetailCandidate): Record<string, unknown> => {
	const extract: Record<string, unknown> = detail.hasJsonLdProduct
		? {
				type: 'jsonld',
				schemaTypes: ['Product'],
				fields: {
					name: { path: 'name', required: detail.nameSelector === undefined },
					sku: { path: 'sku' },
					description: { path: 'description' },
					brand: { path: 'brand.name' },
					images: { path: 'image', multiple: true, transforms: ['absoluteUrl'] },
				},
			}
		: {
				type: 'dom',
				fields: {
					canonical_url: {
						selector: 'link[rel="canonical"]',
						attr: 'href',
						transforms: ['absoluteUrl'],
					},
					...(detail.nameSelector
						? { name: { selector: detail.nameSelector, transforms: ['normalizeWhitespace'] } }
						: {}),
					...(detail.skuSelector
						? {
								sku: {
									selector: detail.skuSelector,
									...(detail.skuAttr ? { attr: detail.skuAttr } : {}),
									transforms: ['normalizeWhitespace'],
								},
							}
						: {}),
					...(detail.attributesEach
						? {
								attributes: {
									each: detail.attributesEach,
									name: 'th, td:first-child',
									value: 'td:nth-child(2)',
								},
							}
						: {}),
					...(detail.documentSelector
						? {
								documents: {
									selector: detail.documentSelector,
									attr: 'href',
									multiple: true,
									transforms: ['absoluteUrl'],
								},
							}
						: {}),
				},
			};

	return {
		id: 'details',
		forEach: { from: 'products' },
		source: { type: 'http', url: '{{products.url}}', method: 'GET', headers: {} },
		extract,
		output: 'product',
	};
};

const identityFields = (candidate: { fields: Record<string, unknown>; identityField?: string }): string[] => {
	if (candidate.fields.sku) {
		return ['sku', 'url'];
	}
	if (candidate.fields.external_id) {
		return ['external_id', 'url'];
	}
	return ['url'];
};

const jsonFields = (fields: WebRobotApiCandidate['fields']): Record<string, Record<string, unknown>> => {
	return Object.fromEntries(
		Object.entries(fields).map(([name, field]) => [
			name,
			{
				path: field.path,
				...(field.required ? { required: true } : {}),
				...(field.multiple ? { multiple: true } : {}),
				...(field.transforms?.length ? { transforms: field.transforms as WebRobotTransform[] } : {}),
			},
		]),
	);
};

const domFields = (fields: WebRobotDomCandidate['fields']): Record<string, Record<string, unknown>> => {
	return Object.fromEntries(
		Object.entries(fields).map(([name, field]) => [
			name,
			{
				...(field.selector ? { selector: field.selector } : {}),
				...(field.selectors ? { selectors: field.selectors } : {}),
				...(field.fingerprint ? { fingerprint: field.fingerprint } : {}),
				...(field.attr ? { attr: field.attr } : {}),
				...(field.required ? { required: true } : {}),
				...(field.multiple ? { multiple: true } : {}),
				...(field.transforms?.length ? { transforms: field.transforms as WebRobotTransform[] } : {}),
			},
		]),
	);
};

const baseUrl = (url: string): string => {
	const parsed = new URL(url);
	return `${parsed.origin}${parsed.pathname}`;
};

const apiQuery = (
	url: string,
	paginate: Record<string, unknown> | undefined,
	method: 'GET' | 'POST',
): Record<string, unknown> => {
	const parsed = new URL(url);
	const query: Record<string, unknown> = Object.fromEntries(
		[...parsed.searchParams.entries()].filter(([key]) => !SENSITIVE_REQUEST_KEY.test(key)),
	);
	if (!paginate) {
		return query;
	}

	const replaceQueryValue = (pattern: RegExp, template: string): boolean => {
		let replaced = false;
		for (const [key, value] of Object.entries(query)) {
			const parsedValue = typeof value === 'string' ? parseJsonQueryValue(value) : undefined;
			if (parsedValue !== undefined && replaceRequestValue(parsedValue, pattern, template)) {
				query[key] = parsedValue;
				replaced = true;
				continue;
			}
			if (pattern.test(key)) {
				query[key] = template;
				replaced = true;
			}
		}
		return replaced;
	};

	if (paginate.type === 'page') {
		const variable = String(paginate.pageVariable ?? 'page');
		if (
			!replaceQueryValue(/^(page|page_?number|current_?page|search_?page)$/i, `{{${variable}}}`) &&
			method === 'GET'
		) {
			query[variable] = `{{${variable}}}`;
		}
	}
	if (paginate.type === 'cursor') {
		const variable = String(paginate.cursorVariable ?? 'cursor');
		if (!replaceQueryValue(/^(cursor|after|next_?cursor|next_?token)$/i, `{{${variable}}}`) && method === 'GET') {
			query[variable] = `{{${variable}}}`;
		}
	}
	if (paginate.type === 'offset') {
		const variable = String(paginate.offsetVariable ?? 'offset');
		if (!replaceQueryValue(/^(offset|start|from)$/i, `{{${variable}}}`) && method === 'GET') {
			query[variable] = `{{${variable}}}`;
		}
	}
	return query;
};

const apiRequestBody = (body: unknown, paginate: Record<string, unknown> | undefined): unknown => {
	const sanitized = sanitizeRequestBody(body);
	if (!paginate || sanitized === undefined) {
		return sanitized;
	}
	const template =
		paginate.type === 'cursor'
			? `{{${String(paginate.cursorVariable ?? 'cursor')}}}`
			: paginate.type === 'offset'
				? `{{${String(paginate.offsetVariable ?? 'offset')}}}`
				: paginate.type === 'page'
					? `{{${String(paginate.pageVariable ?? 'page')}}}`
					: undefined;
	const pattern =
		paginate.type === 'cursor'
			? /^(cursor|after|next_?cursor|next_?token)$/i
			: paginate.type === 'offset'
				? /^(offset|start|from)$/i
				: /^(page|page_?number|current_?page|search_?page)$/i;
	if (!template || paginate.type === 'nextPath') {
		return sanitized;
	}
	const copy = JSON.parse(JSON.stringify(sanitized)) as unknown;
	if (replaceRequestValue(copy, pattern, template)) {
		return copy;
	}
	if (copy && typeof copy === 'object' && !Array.isArray(copy)) {
		const record = copy as Record<string, unknown>;
		const target =
			record.variables && typeof record.variables === 'object' && !Array.isArray(record.variables)
				? (record.variables as Record<string, unknown>)
				: record;
		target[paginate.type === 'cursor' ? 'cursor' : paginate.type === 'offset' ? 'offset' : 'page'] = template;
	}
	return copy;
};

const SENSITIVE_REQUEST_KEY = /(authorization|cookie|csrf|token|secret|password|api[_-]?key|session)/i;

const sanitizeRequestBody = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(sanitizeRequestBody);
	}
	if (!value || typeof value !== 'object') {
		return typeof value === 'string' && /(token|secret|password|api[_-]?key|session|authorization)=/i.test(value)
			? undefined
			: value;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([key]) => !SENSITIVE_REQUEST_KEY.test(key))
		.map(([key, entry]) => [key, sanitizeRequestBody(entry)] as const)
		.filter(([, entry]) => entry !== undefined);
	return Object.fromEntries(entries);
};

const replaceRequestValue = (value: unknown, pattern: RegExp, template: string): boolean => {
	if (!value || typeof value !== 'object') {
		return false;
	}
	let replaced = false;
	if (Array.isArray(value)) {
		for (const entry of value) {
			replaced = replaceRequestValue(entry, pattern, template) || replaced;
		}
		return replaced;
	}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (pattern.test(key)) {
			(value as Record<string, unknown>)[key] = template;
			replaced = true;
		} else if (replaceRequestValue(entry, pattern, template)) {
			replaced = true;
		}
	}
	return replaced;
};

const parseJsonQueryValue = (value: string): unknown => {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
};

const paginationFor = (
	candidates: WebRobotPaginationCandidate[],
	types: WebRobotPaginationCandidate['type'][],
	itemCount?: number,
): { paginate: Record<string, unknown>; candidate: WebRobotPaginationCandidate } | undefined => {
	const allowed = candidates.filter((candidate) => types.includes(candidate.type));
	const nextPath = allowed.find((candidate) => candidate.type === 'nextPath');
	if (nextPath) {
		return {
			paginate: { type: 'nextPath', path: nextPath.path, maxPages: LIMITS_FLOOR.maxPages },
			candidate: nextPath,
		};
	}
	const nextLink = allowed.find((candidate) => candidate.type === 'nextLink');
	if (nextLink) {
		return {
			paginate: {
				type: 'nextLink',
				selector: nextLink.selector,
				...(nextLink.selectors ? { selectors: nextLink.selectors } : {}),
				...(nextLink.fingerprint ? { fingerprint: nextLink.fingerprint } : {}),
				attr: nextLink.attr,
				maxPages: LIMITS_FLOOR.maxPages,
			},
			candidate: nextLink,
		};
	}
	const click = allowed.find(
		(candidate): candidate is Extract<WebRobotPaginationCandidate, { type: 'click' }> =>
			candidate.type === 'click' && candidate.observed === true,
	);
	if (click) {
		return {
			paginate: {
				type: 'click',
				selector: click.selector,
				...(click.selectors ? { selectors: click.selectors } : {}),
				...(click.fingerprint ? { fingerprint: click.fingerprint } : {}),
				waitMs: click.waitMs ?? 1_000,
				maxPages: LIMITS_FLOOR.maxPages,
			},
			candidate: click,
		};
	}
	const scroll = allowed.find(
		(candidate): candidate is Extract<WebRobotPaginationCandidate, { type: 'scroll' }> =>
			candidate.type === 'scroll' && candidate.observed === true,
	);
	if (scroll) {
		return {
			paginate: { type: 'scroll', waitMs: scroll.waitMs ?? 1_000, maxPages: LIMITS_FLOOR.maxPages },
			candidate: scroll,
		};
	}
	const cursor = allowed.find((candidate) => candidate.type === 'cursor');
	if (cursor) {
		return {
			paginate: {
				type: 'cursor',
				cursorVariable: cursor.cursorVariable,
				...(cursor.firstCursor !== undefined ? { firstCursor: cursor.firstCursor } : {}),
				nextCursorPath: cursor.nextCursorPath,
				maxPages: LIMITS_FLOOR.maxPages,
			},
			candidate: cursor,
		};
	}
	const offset = allowed.find((candidate) => candidate.type === 'offset');
	if (offset) {
		return {
			paginate: {
				type: 'offset',
				offsetVariable: offset.offsetVariable,
				firstOffset: offset.firstOffset,
				pageSize: offset.pageSize,
				...(offset.totalPath ? { totalPath: offset.totalPath } : {}),
				maxPages: sizedPaginateMaxPages(declaredListingPages(offset, itemCount)),
			},
			candidate: offset,
		};
	}
	const page = allowed.find((candidate) => candidate.type === 'page');
	if (page) {
		return {
			paginate: {
				type: 'page',
				pageVariable: page.pageVariable,
				firstPage: 1,
				...(page.totalPagesPath ? { totalPagesPath: page.totalPagesPath } : {}),
				...(page.totalItemsPath ? { totalItemsPath: page.totalItemsPath } : {}),
				maxPages: sizedPaginateMaxPages(declaredListingPages(page, itemCount)),
			},
			candidate: page,
		};
	}
	return undefined;
};

const bestDetail = (discovery: WebRobotSourceDiscovery): WebRobotDetailCandidate | undefined => {
	return discovery.detailCandidates.find(
		(candidate) =>
			candidate.score >= 40 &&
			Boolean(candidate.nameSelector || candidate.skuSelector || candidate.hasJsonLdProduct),
	);
};

const browserSourceActions = (
	discovery: WebRobotSourceDiscovery,
	waitSelector?: string,
	skipScroll = false,
): WebRobotBrowserAction[] => [
	...discovery.browserActionCandidates
		.filter((candidate) => candidate.observed)
		.flatMap((candidate) => [
			{ type: 'click' as const, selector: candidate.selector, selectors: candidate.selectors },
			{ type: 'delay' as const, ms: 500 },
		]),
	...(waitSelector ? [{ type: 'waitForSelector' as const, selector: waitSelector, timeoutMs: 5_000 }] : []),
	...passiveBrowserActions(skipScroll),
];

const passiveBrowserActions = (skipScroll = false): WebRobotBrowserAction[] => [
	{ type: 'delay', ms: 1_000 },
	...(skipScroll ? [] : [{ type: 'scroll', times: 2, delayMs: 300 } as const]),
];

const sanitizeStage = (stage: WebRobotStage, discovery: WebRobotSourceDiscovery): WebRobotStage => {
	const source = stage.source;
	return {
		...stage,
		source: {
			...source,
			headers: {},
			...(source.type !== 'browser' && 'body' in source ? { body: sanitizeRequestBody(source.body) } : {}),
			...(source.type === 'browser'
				? {
						actions: source.actions.filter((action) =>
							action.type === 'click'
								? discovery.browserActionCandidates.some(
										(candidate) =>
											candidate.observed &&
											(candidate.selector === action.selector ||
												candidate.selectors?.includes(action.selector)),
									)
								: [
										'delay',
										'scroll',
										'waitForSelector',
										'waitForResponse',
										'waitForNavigation',
									].includes(action.type),
						),
						capture: source.capture.slice(0, 4),
					}
				: {}),
		},
	};
};
