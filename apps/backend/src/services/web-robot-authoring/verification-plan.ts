import type { WebRobotRecipe, WebRobotStage } from '@nao/shared/web-robot';
import {
	catalogueBaseRequiredConcepts,
	type CatalogueContract,
	type CatalogueGranularity,
	type CatalogueVerificationPlan,
	type TraversalMode,
} from '@nao/shared/web-robot-trust';

export const createDefaultCatalogueContract = (
	granularity: CatalogueGranularity,
	now: Date = new Date(),
): CatalogueContract => ({
	version: 1,
	entityGranularity: granularity,
	requiredConcepts: [
		...catalogueBaseRequiredConcepts.map((concept) => ({ ...concept })),
		{ concept: 'specifications', required: true, minimumCoverage: 0.95 },
		{ concept: 'membership', required: true, minimumCoverage: 0.95 },
	],
	publishWhenReady: true,
	createdAt: now.toISOString(),
});

const TERMINAL_STRATEGIES: Record<TraversalMode, string[]> = {
	finite: ['all_results_displayed', 'count_reconciled', 'next_control_absent'],
	page: ['declared_last_page', 'has_next_false', 'short_final_page', 'empty_final_page'],
	offset: ['offset_reached_total', 'short_final_page', 'empty_final_page'],
	cursor: ['cursor_exhausted'],
	next_link: ['next_control_absent', 'next_control_disabled'],
	load_more: ['next_control_absent', 'next_control_disabled', 'count_reconciled'],
	infinite_scroll: ['cursor_exhausted', 'count_reconciled', 'stable_no_progress'],
};

const PAGINATION_MODES: Record<string, TraversalMode> = {
	page: 'page',
	offset: 'offset',
	cursor: 'cursor',
	nextLink: 'next_link',
	click: 'load_more',
	scroll: 'infinite_scroll',
	nextPath: 'page',
};

const traversalRole = (stage: WebRobotStage): 'enumeration' | 'enrichment' | 'corroboration' => {
	if (stage.forEach) {
		return 'enrichment';
	}
	if (stage.output === 'product' || stage.emit) {
		return 'enumeration';
	}
	return 'corroboration';
};

export const createCatalogueVerificationPlan = (
	recipe: WebRobotRecipe,
	scopeId: string,
	countSignalIds: string[],
): CatalogueVerificationPlan => ({
	version: 1,
	scopeId,
	traversals: recipe.stages.map((stage) => {
		const role = traversalRole(stage);
		const mode = stage.paginate ? (PAGINATION_MODES[stage.paginate.type] ?? 'finite') : 'finite';
		return {
			id: `traversal-${stage.id}`,
			stageId: stage.id,
			role,
			required: role !== 'corroboration',
			sourceType: stage.source.type,
			mode,
			terminalStrategies: TERMINAL_STRATEGIES[mode],
		};
	}),
	countSignalIds,
});
