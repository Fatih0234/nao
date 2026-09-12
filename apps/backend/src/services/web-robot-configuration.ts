import type { WebRobotRecipe } from '@nao/shared/web-robot';
import type {
	CatalogueContract,
	CatalogueScope,
	CatalogueVerificationPlan,
	CountSignal,
	ScopeEvidence,
	ScopeFitnessDecision,
} from '@nao/shared/web-robot-trust';
import { catalogueBaseRequiredConcepts } from '@nao/shared/web-robot-trust';

import type { DBWebRobotConfiguration } from '../db/abstractSchema';
import * as webRobotQueries from '../queries/web-robot.queries';
import { webRobotDefinitionHash } from './web-scraper/definition';
import { fingerprintEvidence } from './web-scraper/traversal-evidence';

export const BUSINESS_SELECTABLE_CONCEPTS = [
	'specifications',
	'membership',
	'brand',
	'description',
	'price',
	'availability',
] as const;
export type BusinessSelectableConcept = (typeof BUSINESS_SELECTABLE_CONCEPTS)[number];
export const DEFAULT_BUSINESS_REQUIRED_CONCEPTS: BusinessSelectableConcept[] = ['specifications', 'membership'];

export const evidenceFilteredDefaultConcepts = (
	capabilities: { concept: string; status: string }[],
): BusinessSelectableConcept[] =>
	DEFAULT_BUSINESS_REQUIRED_CONCEPTS.filter(
		(concept) => capabilities.find((capability) => capability.concept === concept)?.status !== 'not_detected',
	);

export const catalogueContractWithRequiredConcepts = (
	contract: CatalogueContract,
	concepts: BusinessSelectableConcept[],
): CatalogueContract => ({
	...contract,
	requiredConcepts: [
		...catalogueBaseRequiredConcepts.map((concept) => ({ ...concept })),
		...[...new Set(concepts)].map((concept) => ({ concept, required: true, minimumCoverage: 0.95 })),
	],
});

export type SavePendingWebRobotConfigurationInput = {
	robotId: string;
	userId: string;
	recipe: WebRobotRecipe;
	scope: CatalogueScope;
	contract: CatalogueContract;
	verificationPlan: CatalogueVerificationPlan;
	sourceAssessment: ScopeFitnessDecision[];
	scopeEvidence: ScopeEvidence[];
	countSignals: CountSignal[];
};

export const webRobotConfigurationHash = (
	input: Omit<SavePendingWebRobotConfigurationInput, 'robotId' | 'userId'>,
): string =>
	fingerprintEvidence({
		version: 1,
		recipe: input.recipe,
		scope: input.scope,
		contract: input.contract,
		verificationPlan: input.verificationPlan,
		sourceAssessment: input.sourceAssessment,
		scopeEvidence: input.scopeEvidence,
		countSignals: input.countSignals,
	});

export const savePendingWebRobotConfiguration = async (
	input: SavePendingWebRobotConfigurationInput,
): Promise<DBWebRobotConfiguration> => {
	return webRobotQueries.createPendingWebRobotConfiguration({
		robotId: input.robotId,
		userId: input.userId,
		recipe: input.recipe,
		recipeVersion: input.recipe.version,
		recipeHash: webRobotDefinitionHash(input.recipe),
		scope: input.scope,
		contract: input.contract,
		verificationPlan: input.verificationPlan,
		sourceAssessment: input.sourceAssessment,
		scopeEvidence: input.scopeEvidence,
		countSignals: input.countSignals,
		configurationHash: webRobotConfigurationHash(input),
	});
};
