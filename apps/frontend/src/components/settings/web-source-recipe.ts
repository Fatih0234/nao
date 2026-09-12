import { webRobotBrowserActionSchema, webRobotBrowserCaptureSchema, webRobotRecipeSchema } from '@nao/shared/web-robot';
import { z } from 'zod/v4';

import type { TrpcRouter } from '@nao/backend/trpc';
import type { WebRobotBrowserAction, WebRobotBrowserCapture, WebRobotRecipe } from '@nao/shared/web-robot';
import type {
	CatalogueCurrentState,
	CatalogueGranularity,
	CatalogueRequiredConcept,
	CatalogueTrustBasis,
} from '@nao/shared/web-robot-trust';
import type { inferRouterOutputs } from '@trpc/server';

export type RouterOutputs = inferRouterOutputs<TrpcRouter>;
export type WebRobotListItem = RouterOutputs['webRobot']['list'][number];
export type WebRobotDetail = RouterOutputs['webRobot']['get'];
export type WebRobotRun = RouterOutputs['webRobot']['listRuns'][number];
export type WebRobotTestResult = RouterOutputs['webRobot']['testRecipe'];
export type WebRobotInspectResult = RouterOutputs['webRobot']['inspectUrl'];
export type WebRobotAuthoringResult = RouterOutputs['webRobot']['createFromUrl'];
export type WebRobotAnalysisResult = RouterOutputs['webRobot']['analyzeUrl'];

export const WEB_SOURCE_KNOWLEDGE_CONCEPTS = [
	{
		value: 'specifications',
		label: 'Specifications',
		description: 'Technical attributes and product properties.',
	},
	{
		value: 'membership',
		label: 'Catalogue grouping',
		description: 'Categories, families, and other source memberships.',
	},
	{ value: 'brand', label: 'Brand', description: 'Manufacturer or brand information.' },
	{ value: 'description', label: 'Description', description: 'Product descriptions and summaries.' },
	{ value: 'price', label: 'Price', description: 'Published prices and currencies.' },
	{ value: 'availability', label: 'Availability', description: 'Stock or availability information.' },
] as const;

export type WebSourceKnowledgeConcept = (typeof WEB_SOURCE_KNOWLEDGE_CONCEPTS)[number]['value'];

export const DEFAULT_WEB_SOURCE_KNOWLEDGE_CONCEPTS: WebSourceKnowledgeConcept[] = ['specifications', 'membership'];

export type WebRobotConceptCapability = Extract<
	WebRobotAnalysisResult,
	{ status: 'ready' | 'partial' }
>['capabilities'][number];

export const conceptCapabilityFor = (
	capabilities: readonly WebRobotConceptCapability[] | undefined,
	concept: CatalogueRequiredConcept['concept'],
): WebRobotConceptCapability | undefined => capabilities?.find((capability) => capability.concept === concept);

export const evidenceBasedDefaultConcepts = (
	capabilities: readonly WebRobotConceptCapability[] | undefined,
): WebSourceKnowledgeConcept[] => {
	if (!capabilities) {
		return [...DEFAULT_WEB_SOURCE_KNOWLEDGE_CONCEPTS];
	}
	return DEFAULT_WEB_SOURCE_KNOWLEDGE_CONCEPTS.filter(
		(concept) => conceptCapabilityFor(capabilities, concept)?.status !== 'not_detected',
	);
};

export const conceptCapabilityLabel = (capability: WebRobotConceptCapability): string => {
	if (capability.status === 'requires_enrichment') {
		return 'From detail pages';
	}
	if (capability.status === 'not_detected') {
		return 'Not detected';
	}
	return 'Detected';
};

export const conceptCapabilityVariant = (
	capability: WebRobotConceptCapability,
	selected: boolean,
): 'success' | 'secondary' | 'destructive' | 'outline' => {
	if (capability.status === 'not_detected') {
		return selected ? 'destructive' : 'outline';
	}
	return capability.status === 'requires_enrichment' ? 'secondary' : 'success';
};

export const conceptCapabilityDetail = (capability: WebRobotConceptCapability): string => {
	const coverage = `found in ${capability.covered} of ${capability.sampled} sampled products`;
	if (capability.status === 'not_detected') {
		return 'Not found in the analysed sample — requiring it may block the first refresh.';
	}
	if (capability.status === 'requires_enrichment') {
		return `Collected from each product detail page — ${coverage}.`;
	}
	return capability.covered === capability.sampled ? 'Found in the analysed sample.' : `Only ${coverage}.`;
};

export type WebSourceFormSubmit = {
	name: string;
	slug?: string;
	description?: string;
	cron: string;
	enabled: boolean;
	recipe: WebRobotRecipe;
};

export type WebSourceFormInitial = {
	name: string;
	slug?: string;
	description?: string | null;
	cron?: string | null;
	enabled?: boolean;
	recipe: WebRobotRecipe;
};

export const WEB_SOURCE_SCHEDULE_PRESETS = [
	{ value: 'manual', label: 'Manual', cron: '' },
	{ value: 'daily', label: 'Daily at 02:00', cron: '0 2 * * *' },
	{ value: 'weekly', label: 'Weekly on Monday at 02:00', cron: '0 2 * * 1' },
	{ value: 'custom', label: 'Custom cron', cron: '' },
] as const;

export type WebSourceSchedulePreset = (typeof WEB_SOURCE_SCHEDULE_PRESETS)[number]['value'];

export const DEFAULT_WEB_SOURCE_RECIPE_TEXT = `{
  "version": 1,
  "allowedHosts": ["dummyjson.com"],
  "request": {
    "concurrency": 1,
    "delayMs": 250,
    "timeoutMs": 20000,
    "retries": 2
  },
  "limits": {
    "maxPages": 5,
    "maxItems": 100,
    "maxRequests": 100,
    "maxDurationMs": 300000,
    "maxResponseBytes": 2097152
  },
  "publish": {
    "minItems": 1,
    "maxRemovedPercent": 50
  },
  "identity": {
    "fields": ["sku"]
  },
  "respectRobotsTxt": false,
  "stages": [
    {
      "id": "products",
      "source": {
        "type": "api",
        "url": "https://dummyjson.com/products?limit=10"
      },
      "extract": {
        "type": "json",
        "itemsPath": "products",
        "fields": {
          "sku": { "path": "id", "required": true },
          "name": { "path": "title", "required": true },
          "description": { "path": "description" },
          "brand": { "path": "brand" },
          "price": { "path": "price" },
          "categories": { "path": "tags" },
          "images": { "path": "images", "multiple": true }
        }
      },
      "output": "product"
    }
  ]
}`;

export const parseWebSourceRecipe = (text: string): { recipe?: WebRobotRecipe; errors: string[] } => {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { errors: [`JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}

	const result = webRobotRecipeSchema.safeParse(value);
	if (result.success) {
		return { recipe: result.data, errors: [] };
	}
	return { errors: result.error.issues.map(formatZodIssue) };
};

export const parseBrowserActions = (text: string): { actions?: WebRobotBrowserAction[]; errors: string[] } => {
	const result = parseSchemaArray(text, webRobotBrowserActionSchema, 'browser actions');
	return { actions: result.values, errors: result.errors };
};

export const parseBrowserCaptures = (text: string): { captures?: WebRobotBrowserCapture[]; errors: string[] } => {
	const result = parseSchemaArray(text, webRobotBrowserCaptureSchema, 'network captures');
	return { captures: result.values, errors: result.errors };
};

export const schedulePresetForCron = (cron: string | null | undefined): WebSourceSchedulePreset => {
	const trimmed = cron?.trim() ?? '';
	if (!trimmed) {
		return 'manual';
	}
	if (trimmed === '0 2 * * *') {
		return 'daily';
	}
	if (trimmed === '0 2 * * 1') {
		return 'weekly';
	}
	return 'custom';
};

export const recipeSummary = (recipe?: WebRobotRecipe) => {
	if (!recipe) {
		return null;
	}
	return {
		allowedHosts: recipe.allowedHosts,
		stageCount: recipe.stages.length,
		sourceTypes: [...new Set(recipe.stages.map((stage) => stage.source.type))],
		productStages: recipe.stages.filter((stage) => stage.output === 'product').map((stage) => stage.id),
	};
};

export const isActiveWebRobotRun = (status: WebRobotRun['status'] | null | undefined): boolean => {
	return status === 'queued' || status === 'running';
};

export type CatalogueTrustPresentation = {
	label: string;
	detail: string;
	variant: 'success' | 'secondary' | 'destructive' | 'outline' | 'context_admin';
};

export const catalogueTrustBasisLabel = (basis: CatalogueTrustBasis | undefined): string => {
	if (basis === 'count_reconciled') {
		return 'source count reconciliation';
	}
	if (basis === 'traversal_complete') {
		return 'complete traversal';
	}
	return 'not established';
};

export const catalogueGranularityLabel = (granularity: CatalogueGranularity): string =>
	granularity.replaceAll('_', ' ');

export type WebSourceLifecycleContext = {
	state: CatalogueCurrentState;
	hasPendingConfiguration?: boolean;
	isActionPending?: boolean;
};

export const webSourcePrimaryActionLabel = ({
	state,
	hasPendingConfiguration = false,
	isActionPending = false,
}: WebSourceLifecycleContext): string | null => {
	if (state.setupStatus !== 'configured') {
		return null;
	}
	const hasActiveData = Boolean(state.activeSummary && state.activeRunId);
	const running = isActionPending || state.executionStatus === 'queued' || state.executionStatus === 'running';
	if (running) {
		if (!hasActiveData) {
			return 'First refresh running…';
		}
		if (hasPendingConfiguration) {
			return 'Checking configuration update…';
		}
		return 'Refreshing…';
	}
	if (!hasActiveData) {
		return state.executionStatus ? 'Retry first refresh' : 'Start first refresh';
	}
	if (hasPendingConfiguration) {
		return 'Retry configuration update';
	}
	if (state.latestRefreshFailed) {
		return 'Retry refresh';
	}
	return 'Refresh now';
};

export const catalogueTrustPresentation = (
	state: CatalogueCurrentState,
	{ hasPendingConfiguration = false }: { hasPendingConfiguration?: boolean } = {},
): CatalogueTrustPresentation => {
	if (state.setupStatus !== 'configured' && !state.activeSummary) {
		return {
			label: 'Setup required',
			detail: 'Complete source setup before loading data.',
			variant: 'outline',
		};
	}
	if (state.activeSummary && (state.executionStatus === 'queued' || state.executionStatus === 'running')) {
		return {
			label: hasPendingConfiguration ? 'Ready · Checking update' : 'Ready · Refreshing',
			detail: 'Agents continue using the active dataset while the new data is checked.',
			variant: 'secondary',
		};
	}
	if (state.activeSummary && state.latestRefreshFailed) {
		return {
			label: 'Ready · Previous data kept',
			detail: 'The latest refresh did not pass its quality checks. Agents continue using the active dataset.',
			variant: 'context_admin',
		};
	}
	if (state.activeSummary) {
		return {
			label: 'Ready',
			detail: `Quality checks passed using ${catalogueTrustBasisLabel(state.activeSummary.basis)}.`,
			variant: 'success',
		};
	}
	if (
		state.executionStatus === 'queued' ||
		state.executionStatus === 'running' ||
		state.publicationStatus === 'pending'
	) {
		return {
			label: 'First refresh running',
			detail: 'No data is available to agents until the first refresh passes its quality checks.',
			variant: 'secondary',
		};
	}
	if (state.publicationStatus === 'publication_failed') {
		return {
			label: 'Activation failed',
			detail: 'The data passed its checks but could not be made available to agents.',
			variant: 'destructive',
		};
	}
	if (state.executionStatus === 'failed') {
		return {
			label: 'First refresh failed',
			detail: 'The first refresh could not complete, so no dataset is available to agents.',
			variant: 'destructive',
		};
	}
	if (state.publicationStatus === 'blocked_initial' || state.trustStatus === 'needs_attention') {
		return {
			label: 'Needs attention',
			detail: 'The first refresh did not pass its quality checks, so no dataset is available to agents.',
			variant: 'destructive',
		};
	}
	return {
		label: 'Not refreshed',
		detail: 'Start the first refresh before agents can use this source.',
		variant: 'outline',
	};
};

export const catalogueQualityPresentation = (state: CatalogueCurrentState): CatalogueTrustPresentation => {
	if (state.executionStatus === 'queued' || state.executionStatus === 'running') {
		return {
			label: 'Checks running',
			detail: 'The current refresh is collecting and checking new data.',
			variant: 'secondary',
		};
	}
	if (state.latestSummary?.status === 'needs_attention') {
		return {
			label: 'Checks need attention',
			detail: 'The latest refresh did not pass all quality checks.',
			variant: state.activeSummary ? 'context_admin' : 'destructive',
		};
	}
	if (state.latestSummary?.status === 'ready') {
		return {
			label: 'Checks passed',
			detail: 'The latest refresh passed its quality checks.',
			variant: 'success',
		};
	}
	if (state.activeSummary) {
		return {
			label: 'Checks passed',
			detail: `The active dataset passed using ${catalogueTrustBasisLabel(state.activeSummary.basis)}.`,
			variant: 'success',
		};
	}
	if (state.executionStatus === 'failed') {
		return {
			label: 'Checks not completed',
			detail: 'The refresh ended before quality checks could complete.',
			variant: 'destructive',
		};
	}
	return {
		label: 'Checks not run',
		detail: 'Quality checks run after catalogue data is collected.',
		variant: 'outline',
	};
};

export const catalogueExecutionLabel = (status: NonNullable<CatalogueCurrentState['executionStatus']>): string =>
	({
		queued: 'Refresh queued',
		running: 'Refreshing',
		succeeded: 'Refresh completed',
		failed: 'Refresh failed',
		cancelled: 'Refresh cancelled',
	})[status] ?? 'Not started';

export const catalogueTrustStatusLabel = (status: NonNullable<CatalogueCurrentState['trustStatus']>): string =>
	status === 'ready' ? 'Checks passed' : status === 'needs_attention' ? 'Checks need attention' : 'Checks not run';

export const cataloguePublicationStatusLabel = (
	status: NonNullable<CatalogueCurrentState['publicationStatus']>,
): string =>
	({
		pending: 'Activating',
		published: 'Active',
		retained_previous: 'Previous data kept',
		blocked_initial: 'Not activated',
		publication_failed: 'Activation failed',
		not_evaluated: 'Not evaluated',
	})[status] ?? 'Not evaluated';

export const webRobotTriggerLabel = (trigger: WebRobotRun['trigger']): string =>
	trigger === 'schedule' ? 'Schedule' : trigger === 'manual' ? 'Manual' : trigger;

export const webRobotRunBadgeVariant = (
	status: WebRobotRun['status'] | null | undefined,
): 'success' | 'secondary' | 'destructive' | 'outline' | 'context_admin' => {
	switch (status) {
		case 'completed':
			return 'success';
		case 'partial':
			return 'context_admin';
		case 'failed':
			return 'destructive';
		case 'cancelled':
			return 'outline';
		case 'queued':
		case 'running':
			return 'secondary';
		default:
			return 'outline';
	}
};

export const formatDateTime = (value: string | Date | null | undefined): string => {
	if (!value) {
		return '—';
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

export const formatDuration = (
	startedAt: string | Date | null | undefined,
	completedAt: string | Date | null | undefined,
): string => {
	if (!startedAt) {
		return '—';
	}
	const start = new Date(startedAt).getTime();
	const end = completedAt ? new Date(completedAt).getTime() : Date.now();
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
		return '—';
	}
	const seconds = Math.round((end - start) / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		return `${minutes}m ${remainingSeconds}s`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
};

export const recipeToText = (recipe: WebRobotRecipe): string => JSON.stringify(recipe, null, 2);

export const slugifyWebSourceName = (name: string): string => {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
};

const parseSchemaArray = <T extends z.ZodTypeAny>(
	text: string,
	schema: T,
	label: string,
): { values?: z.infer<T>[]; errors: string[] } => {
	const trimmed = text.trim();
	if (!trimmed) {
		return { values: [], errors: [] };
	}
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch (error) {
		return { errors: [`${label}: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const result = z.array(schema).safeParse(value);
	if (!result.success) {
		return { errors: result.error.issues.map((issue) => `${label}: ${formatZodIssue(issue)}`) };
	}
	return { values: result.data, errors: [] };
};

const formatZodIssue = (issue: z.core.$ZodIssue): string => {
	const path = issue.path.map(String).join('.');
	return path ? `${path}: ${issue.message}` : issue.message;
};
