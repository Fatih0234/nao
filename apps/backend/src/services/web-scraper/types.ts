import type { WebRobotRecipe, WebRobotRunStats, WebRobotStage } from '@nao/shared/web-robot';
import type {
	CatalogueAnomaly,
	CatalogueGranularity,
	CatalogueVerificationPlan,
	CountSignal,
	TraversalAttempt,
	TraversalDefinition,
	TraversalStepEvidence,
} from '@nao/shared/web-robot-trust';

import type { NormalizedProducts } from './records';

export type WebRobotStageRecord = {
	stageId: string;
	url?: string;
	data: Record<string, unknown>;
};

export type WebRobotCapturedResponse = {
	name: string;
	url: string;
	status: number;
	requestMethod?: string;
	requestContentType?: string;
	requestBody?: unknown;
	contentType?: string;
	body: unknown;
};

export type WebRobotRequestAttempt = {
	attempt: number;
	startedAt: string;
	completedAt: string;
	status?: number;
	error?: string;
	retryAfterMs?: number;
};

export type WebRobotLoadedSource = {
	url: string;
	finalUrl: string;
	status: number;
	contentType?: string;
	bodyText?: string;
	bodyJson?: unknown;
	captures: WebRobotCapturedResponse[];
	requests: number;
	renderedTargetFingerprint?: string;
	redactedTarget?: string;
	responseFingerprint?: string;
	requestAttempts?: WebRobotRequestAttempt[];
	captureLimitReached?: boolean;
};

export type WebRobotBlockerKind =
	| 'access_denied'
	| 'bot_challenge'
	| 'captcha'
	| 'consent'
	| 'empty_shell'
	| 'login'
	| 'rate_limited'
	| 'site_error';

export type WebRobotSourceBlocker = {
	kind: WebRobotBlockerKind;
	loader: 'http' | 'browser';
	message: string;
	status?: number;
	evidence?: string;
};

export type WebRobotRunWarning = {
	kind:
		| 'blocker_detected'
		| 'selector_fallback'
		| 'field_coverage_drop'
		| 'pagination_fallback'
		| 'pagination_stopped';
	message: string;
	blocker?: WebRobotBlockerKind;
	selector?: string;
	fallback?: string;
	field?: string;
	relocated?: boolean;
	data?: Record<string, unknown>;
};

export type WebRobotRunEvent = {
	type: 'page' | 'error' | 'item' | 'warning';
	stageId?: string;
	url?: string;
	status?: number;
	message?: string;
	data?: unknown;
	createdAt: string;
};

export type WebRobotRequestPolicy = {
	beforeRequest: (url: string) => Promise<void>;
	observeResponse: (url: string, response: Response) => void;
};

export type WebRobotExecutionOptions = {
	recipe: WebRobotRecipe;
	runId?: string;
	env?: Record<string, string>;
	dryRun?: boolean;
	signal?: AbortSignal;
	onEvent?: (event: WebRobotRunEvent) => void | Promise<void>;
	requestPolicy?: WebRobotRequestPolicy;
	responseCache?: ReadonlyMap<string, WebRobotLoadedSource>;
};

export type WebRobotExecutionResult = {
	stats: WebRobotRunStats;
	stageRecords: Map<string, WebRobotStageRecord[]>;
	products: Record<string, unknown>[];
	events: WebRobotRunEvent[];
};

export type WebRobotTraversalReport = {
	definition: TraversalDefinition;
	attempts: TraversalAttempt[];
	selectedAttemptId?: string;
};

export type WebRobotVerificationOptions = WebRobotExecutionOptions & {
	verificationPlan: CatalogueVerificationPlan;
	countSignals?: CountSignal[];
	entityGranularity?: CatalogueGranularity;
	onProgress?: (progress: Record<string, unknown>) => void | Promise<void>;
};

export type WebRobotVerificationExecutionResult = WebRobotExecutionResult & {
	normalized: NormalizedProducts;
	traversals: WebRobotTraversalReport[];
	traversalSteps: TraversalStepEvidence[];
	anomalies: CatalogueAnomaly[];
	countSignals: CountSignal[];
};

export type ClickPagination = Extract<NonNullable<WebRobotStage['paginate']>, { type: 'click' }>;

export type WebRobotBrowserControlState = {
	present: boolean;
	enabled: boolean;
	selector?: string;
	relocated?: boolean;
};

export type WebRobotBrowserScrollState = {
	scrollTop: number;
	scrollExtent: number;
	viewportExtent: number;
	atEffectiveBottom: boolean;
	loadingIndicatorPresent: boolean;
	relevantNetworkIdle: boolean;
	rangeStart?: number;
	rangeEnd?: number;
	setSize?: number;
};

export type WebRobotBrowserTraversalSnapshot = {
	loaded: WebRobotLoadedSource;
	control?: WebRobotBrowserControlState;
	scroll: WebRobotBrowserScrollState;
};

export type WebRobotInteractiveBrowser = {
	snapshot(pagination?: ClickPagination): Promise<WebRobotBrowserTraversalSnapshot>;
	inspectControl(pagination: ClickPagination): Promise<WebRobotBrowserControlState>;
	click(pagination: ClickPagination): Promise<WebRobotBrowserControlState>;
	scrollIncrement(): Promise<void>;
	settle(waitMs: number): Promise<void>;
	close(): Promise<void>;
};

export type HeaderValues = Record<string, string>;
