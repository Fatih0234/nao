import type { WebRobotElementFingerprint, WebRobotRecipe, WebRobotRecordFilter } from '@nao/shared/web-robot';
import type {
	CatalogueConceptCapability,
	CatalogueContract,
	CatalogueEntityKind,
	CatalogueGranularity,
	CatalogueScope,
	CatalogueScopeRelation,
	CatalogueSourceRole,
	CatalogueVerificationPlan,
	CountSignal,
	ScopeEvidence,
	ScopeFitnessDecision,
} from '@nao/shared/web-robot-trust';

import type { NormalizedProducts, WebRobotExecutionResult } from '../web-scraper';
import type { WebRobotSourceBlocker } from '../web-scraper/types';

export type WebRobotDisplayedCount = {
	id: string;
	value: number;
	unitLabel: string;
	text: string;
	kind: 'total' | 'all_results';
	sourceUrl: string;
};

export type WebRobotPageContext = {
	headings: string[];
	breadcrumbs: string[];
	activeFilters: Record<string, string | string[]>;
	searchTerm?: string;
	locale?: string;
	displayedCounts: WebRobotDisplayedCount[];
};

export type WebRobotJsonFieldMap = Record<
	string,
	{ path: string; required?: boolean; multiple?: boolean; transforms?: string[] }
>;

export type WebRobotApiCandidate = {
	kind: 'api' | 'network';
	url: string;
	method: string;
	status: number;
	requestBody?: unknown;
	requestContentType?: string;
	captureName?: string;
	capturePattern?: string;
	itemsPath?: string;
	itemCount: number;
	fields: WebRobotJsonFieldMap;
	fieldNames: string[];
	identityField?: string;
	urlField?: string;
	nameField?: string;
	productUrls: string[];
	sample: Record<string, unknown>;
	samples: Record<string, unknown>[];
	recordTypes: string[];
	technicalFieldPaths: string[];
	where?: WebRobotRecordFilter[];
	score: number;
};

export type WebRobotDomCandidate = {
	loader: 'http' | 'browser';
	itemSelector: string;
	itemSelectors?: string[];
	itemFingerprint?: WebRobotElementFingerprint;
	linkSelector?: string;
	linkSelectors?: string[];
	itemCount: number;
	productUrlCount?: number;
	fields: Record<
		string,
		{
			selector?: string;
			selectors?: string[];
			fingerprint?: WebRobotElementFingerprint;
			attr?: string;
			required?: boolean;
			multiple?: boolean;
			transforms?: string[];
		}
	>;
	productUrls: string[];
	sample: { text: string; href: string };
	samples: { text: string; href: string }[];
	score: number;
};

export type WebRobotJsonLdCandidate = {
	loader: 'http' | 'browser';
	pageUrl: string;
	schemaType: 'Product' | 'ItemList' | 'ListItem';
	itemCount: number;
	fields: WebRobotJsonFieldMap;
	productUrls: string[];
	sample: Record<string, unknown>;
	samples: Record<string, unknown>[];
	score: number;
};

export type WebRobotEmbeddedCandidate = {
	loader: 'http' | 'browser';
	pageUrl: string;
	source: 'jsonld' | 'microdata' | 'rdfa' | 'openGraph' | 'scriptJson';
	itemsPath?: string;
	schemaTypes?: string[];
	where?: WebRobotRecordFilter[];
	itemCount: number;
	fields: WebRobotJsonFieldMap;
	productUrls: string[];
	sample: Record<string, unknown>;
	samples: Record<string, unknown>[];
	score: number;
};

export type WebRobotBrowserActionCandidate = {
	type: 'click';
	kind: 'consent';
	selector: string;
	selectors?: string[];
	fingerprint?: WebRobotElementFingerprint;
	observed: boolean;
	label?: string;
};

export type WebRobotEndpointCandidate = {
	url: string;
	method: 'GET' | 'POST';
	source: 'form' | 'html' | 'script';
	probed: boolean;
	status?: number;
	productCandidate?: boolean;
};

export type WebRobotDetailCandidate = {
	url: string;
	loader: 'http';
	title?: string;
	nameSelector?: string;
	skuSelector?: string;
	skuAttr?: string;
	attributesEach?: string;
	documentSelector?: string;
	hasJsonLdProduct: boolean;
	score: number;
};

export type WebRobotPaginationCandidate =
	| {
			type: 'page';
			pageVariable: string;
			totalPagesPath?: string;
			totalItemsPath?: string;
			declaredPages?: number;
			declaredItems?: number;
	  }
	| {
			type: 'nextLink';
			selector: string;
			selectors?: string[];
			fingerprint?: WebRobotElementFingerprint;
			attr: string;
	  }
	| {
			type: 'click';
			selector: string;
			selectors?: string[];
			fingerprint?: WebRobotElementFingerprint;
			waitMs?: number;
			observed?: boolean;
	  }
	| { type: 'scroll'; waitMs?: number; observed?: boolean }
	| { type: 'nextPath'; path: string }
	| {
			type: 'cursor';
			cursorVariable: string;
			firstCursor?: string;
			nextCursorPath: string;
	  }
	| {
			type: 'offset';
			offsetVariable: string;
			firstOffset: number;
			pageSize: number;
			totalPath?: string;
			declaredItems?: number;
	  };

export type WebRobotSourceDiscovery = {
	url: string;
	finalUrl: string;
	allowedHosts: string[];
	title?: string;
	httpStatus?: number;
	browserStatus?: number;
	apiCandidates: WebRobotApiCandidate[];
	endpointCandidates: WebRobotEndpointCandidate[];
	jsonLdCandidates: WebRobotJsonLdCandidate[];
	embeddedCandidates: WebRobotEmbeddedCandidate[];
	domCandidates: WebRobotDomCandidate[];
	detailCandidates: WebRobotDetailCandidate[];
	paginationCandidates: WebRobotPaginationCandidate[];
	pageContext: WebRobotPageContext;
	browserActionCandidates: WebRobotBrowserActionCandidate[];
	blockers: WebRobotSourceBlocker[];
	warnings: string[];
	errors: string[];
};

export type WebRobotAuthoringCandidateDiagnostic = {
	id: string;
	strategy: string;
	status: 'accepted' | 'rejected';
	score: number;
	role?: CatalogueSourceRole;
	relation?: CatalogueScopeRelation;
	entityKind?: CatalogueEntityKind;
	granularity?: CatalogueGranularity;
	scopeReason?: string;
	error?: string;
	stats?: {
		itemsExtracted: number;
		products: number;
		failedRequests: number;
		extractionErrors: number;
	};
};

export type WebRobotAuthoringDiagnostics = {
	discovery: {
		url: string;
		finalUrl: string;
		allowedHosts: string[];
		title?: string;
		counts: {
			api: number;
			endpoint: number;
			jsonLd: number;
			embedded: number;
			dom: number;
			detail: number;
			pagination: number;
			actions: number;
		};
		pagination: { type: string; selector?: string; observed?: boolean }[];
		pageContext: WebRobotPageContext;
		actions: WebRobotBrowserActionCandidate[];
		endpoints: WebRobotEndpointCandidate[];
		blockers: WebRobotSourceBlocker[];
	};
	candidates: WebRobotAuthoringCandidateDiagnostic[];
};

export type WebRobotAuthoringResult =
	| {
			status: 'ready';
			recipe: WebRobotRecipe;
			score: number;
			sampleProducts: Record<string, unknown>[];
			scope: CatalogueScope;
			contract: CatalogueContract;
			verificationPlan: CatalogueVerificationPlan;
			sourceAssessment: ScopeFitnessDecision[];
			scopeEvidence: ScopeEvidence[];
			countSignals: CountSignal[];
			capabilities: CatalogueConceptCapability[];
			warnings: string[];
			diagnostics: WebRobotAuthoringDiagnostics;
	  }
	| {
			status: 'partial';
			reason: string;
			recipe: WebRobotRecipe;
			score: number;
			sampleProducts: Record<string, unknown>[];
			scope: CatalogueScope;
			contract: CatalogueContract;
			verificationPlan: CatalogueVerificationPlan;
			sourceAssessment: ScopeFitnessDecision[];
			scopeEvidence: ScopeEvidence[];
			countSignals: CountSignal[];
			capabilities: CatalogueConceptCapability[];
			warnings: string[];
			diagnostics: WebRobotAuthoringDiagnostics;
	  }
	| {
			status: 'interactive_needed' | 'rejected' | 'rate_limited';
			reason: string;
			recipe?: WebRobotRecipe;
			sampleProducts?: Record<string, unknown>[];
			warnings: string[];
			diagnostics: WebRobotAuthoringDiagnostics;
	  };

export type TestedWebRobotCandidate = {
	id: string;
	strategy: string;
	recipe?: WebRobotRecipe;
	result?: WebRobotExecutionResult & { normalized: NormalizedProducts };
	score: number;
	error?: string;
	scopeDecision?: ScopeFitnessDecision;
	scopeEvidence?: ScopeEvidence[];
	countSignals?: CountSignal[];
	scopeReason?: string;
	scope?: CatalogueScope;
};
