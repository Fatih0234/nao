import { z } from 'zod/v4';

export const catalogueSetupStatusSchema = z.enum(['configured', 'needs_input', 'unsupported']);
export const catalogueExecutionStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const catalogueTrustStatusSchema = z.enum(['ready', 'needs_attention']);
export const catalogueTrustBasisSchema = z.enum(['count_reconciled', 'traversal_complete', 'none']);
export const cataloguePublicationStatusSchema = z.enum([
	'pending',
	'published',
	'retained_previous',
	'blocked_initial',
	'publication_failed',
	'not_evaluated',
]);
export const catalogueConfigurationStatusSchema = z.enum(['draft', 'active', 'superseded']);
export const catalogueEntityKindSchema = z.enum([
	'product_family',
	'product_variant',
	'offer',
	'source_record',
	'non_product',
	'unknown',
]);
export const catalogueGranularitySchema = z.enum(['family', 'variant', 'offer', 'mixed', 'source_record', 'unknown']);
export const catalogueSourceRoleSchema = z.enum([
	'primary_enumerator',
	'partition_enumerator',
	'detail_enrichment',
	'corroborating_evidence',
	'taxonomy_membership',
	'control_metadata',
	'unrelated',
	'unknown',
]);
export const catalogueScopeRelationSchema = z.enum(['exact', 'subset', 'superset', 'overlap', 'unrelated', 'unknown']);
export const evidenceStrengthSchema = z.enum(['strong', 'moderate', 'weak']);
export const traversalModeSchema = z.enum([
	'finite',
	'page',
	'offset',
	'cursor',
	'next_link',
	'load_more',
	'infinite_scroll',
]);
export const traversalStatusSchema = z.enum([
	'planned',
	'loading',
	'validating_response',
	'extracting_records',
	'measuring_progress',
	'deriving_next_target',
	'confirming_terminal',
	'complete',
	'stalled',
	'failed',
	'limit_reached',
	'cancelled',
]);
export const trustDimensionStatusSchema = z.enum(['passed', 'limited', 'failed', 'unknown']);
export const catalogueAnomalySeveritySchema = z.enum(['limitation', 'blocking']);

export type CatalogueSetupStatus = z.infer<typeof catalogueSetupStatusSchema>;
export type CatalogueExecutionStatus = z.infer<typeof catalogueExecutionStatusSchema>;
export type CatalogueTrustStatus = z.infer<typeof catalogueTrustStatusSchema>;
export type CatalogueTrustBasis = z.infer<typeof catalogueTrustBasisSchema>;
export type CataloguePublicationStatus = z.infer<typeof cataloguePublicationStatusSchema>;
export type CatalogueConfigurationStatus = z.infer<typeof catalogueConfigurationStatusSchema>;
export type CatalogueEntityKind = z.infer<typeof catalogueEntityKindSchema>;
export type CatalogueGranularity = z.infer<typeof catalogueGranularitySchema>;
export type CatalogueSourceRole = z.infer<typeof catalogueSourceRoleSchema>;
export type CatalogueScopeRelation = z.infer<typeof catalogueScopeRelationSchema>;
export type EvidenceStrength = z.infer<typeof evidenceStrengthSchema>;
export type TraversalMode = z.infer<typeof traversalModeSchema>;
export type TraversalStatus = z.infer<typeof traversalStatusSchema>;
export type TrustDimensionStatus = z.infer<typeof trustDimensionStatusSchema>;
export type CatalogueAnomalySeverity = z.infer<typeof catalogueAnomalySeveritySchema>;

const idSchema = z.string().trim().min(1).max(128);
const textSchema = z.string().trim().min(1).max(1024);
const longTextSchema = z.string().trim().min(1).max(4096);
const urlSchema = z.url().max(4096);
const datetimeSchema = z.string().datetime();
const nonnegativeIntSchema = z.number().int().min(0);
const coverageSchema = z.number().min(0).max(1);
const detailsSchema = z
	.record(z.string().trim().min(1).max(128), z.unknown())
	.refine((value) => Object.keys(value).length <= 64, 'Details can contain at most 64 entries')
	.default({});
const stringListSchema = z.array(textSchema).max(64).default([]);

export const catalogueScopeSelectionSchema = z.object({
	mode: z.enum(['automatic', 'user_confirmed']),
	candidateId: idSchema.optional(),
	confidence: z.enum(['high', 'medium', 'low']),
	rationale: z.array(textSchema).max(16).default([]),
	confirmedAt: datetimeSchema.optional(),
});

export const catalogueScopeSchema = z.object({
	version: z.literal(1),
	id: idSchema,
	label: z.string().trim().min(1).max(256),
	entryUrl: urlSchema,
	includedUrls: z.array(urlSchema).min(1).max(64),
	excludedPatterns: z.array(z.string().trim().min(1).max(1024)).max(64).default([]),
	activeFilters: z
		.record(
			z.string().trim().min(1).max(128),
			z.union([z.string().max(1024), z.array(z.string().max(1024)).max(32)]),
		)
		.refine((value) => Object.keys(value).length <= 32, 'Active filters can contain at most 32 entries')
		.default({}),
	searchTerm: z.string().trim().min(1).max(512).optional(),
	locale: z.string().trim().min(1).max(64).optional(),
	selection: catalogueScopeSelectionSchema,
});

export const catalogueRequiredConceptSchema = z.object({
	concept: z.enum([
		'name',
		'source_url',
		'stable_identity',
		'specifications',
		'membership',
		'brand',
		'description',
		'price',
		'availability',
	]),
	required: z.boolean().default(true),
	minimumCoverage: coverageSchema,
});

export const catalogueContractSchema = z.object({
	version: z.literal(1),
	entityGranularity: catalogueGranularitySchema,
	requiredConcepts: z.array(catalogueRequiredConceptSchema).min(1).max(32),
	publishWhenReady: z.literal(true),
	createdAt: datetimeSchema,
});

export const catalogueConceptStatusSchema = z.enum(['detected', 'requires_enrichment', 'not_detected']);

export const catalogueConceptCapabilitySchema = z.object({
	concept: catalogueRequiredConceptSchema.shape.concept,
	status: catalogueConceptStatusSchema,
	covered: nonnegativeIntSchema,
	sampled: nonnegativeIntSchema,
	detail: textSchema,
});

export const scopeEvidenceSchema = z.object({
	id: idSchema,
	kind: z.enum([
		'product_type',
		'product_url',
		'stable_identifier',
		'detail_correlation',
		'technical_properties',
		'displayed_count',
		'active_filter',
		'search_scope',
		'control_metadata',
		'blocker',
		'surface_signature',
		'user_confirmation',
	]),
	sourceUrl: urlSchema,
	observedAt: datetimeSchema,
	strength: evidenceStrengthSchema,
	summary: textSchema,
	details: detailsSchema,
});

export const scopeFitnessDecisionSchema = z.object({
	candidateId: idSchema,
	role: catalogueSourceRoleSchema,
	relation: catalogueScopeRelationSchema,
	entityKind: catalogueEntityKindSchema,
	granularity: catalogueGranularitySchema,
	evidenceIds: z.array(idSchema).max(64).default([]),
	blockers: stringListSchema,
	limitations: stringListSchema,
});

export const countSignalSchema = z.object({
	id: idSchema,
	value: nonnegativeIntSchema,
	unit: catalogueGranularitySchema,
	source: z.enum(['displayed', 'api', 'pagination', 'user']),
	scopeId: idSchema,
	reliability: evidenceStrengthSchema,
	observedAt: datetimeSchema,
	comparable: z.boolean().default(true),
	path: z.string().trim().min(1).max(2048).optional(),
});

export const countComparisonSchema = z.object({
	status: z.enum(['match', 'mismatch', 'not_comparable', 'reconciled']),
	signalIds: z.array(idSchema).min(1).max(32),
	observedUniqueCount: nonnegativeIntSchema,
	expectedCount: nonnegativeIntSchema.optional(),
	explanation: textSchema.optional(),
});

export const traversalDefinitionSchema = z.object({
	id: idSchema,
	stageId: idSchema,
	role: z.enum(['enumeration', 'enrichment', 'corroboration']),
	required: z.boolean().default(true),
	sourceType: z.enum(['api', 'http', 'browser']),
	mode: traversalModeSchema,
	membership: z.string().trim().min(1).max(256).optional(),
	terminalStrategies: z.array(z.string().trim().min(1).max(128)).max(16).default([]),
});

export const catalogueVerificationPlanSchema = z.object({
	version: z.literal(1),
	scopeId: idSchema,
	traversals: z.array(traversalDefinitionSchema).min(1).max(128),
	countSignalIds: z.array(idSchema).max(64).default([]),
});

export const traversalTargetSchema = z.object({
	sequence: nonnegativeIntSchema,
	fingerprint: z.string().trim().min(1).max(256),
	redactedTarget: z.string().trim().min(1).max(2048),
	membership: z.string().trim().min(1).max(256).optional(),
});

export const traversalTerminalEvidenceSchema = z.object({
	kind: z.enum([
		'declared_last_page',
		'has_next_false',
		'short_final_page',
		'empty_final_page',
		'offset_reached_total',
		'cursor_exhausted',
		'next_control_absent',
		'next_control_disabled',
		'all_results_displayed',
		'count_reconciled',
		'stable_no_progress',
	]),
	summary: textSchema,
	details: detailsSchema,
});

export const traversalSummarySchema = z.object({
	plannedTargets: nonnegativeIntSchema,
	attemptedTargets: nonnegativeIntSchema,
	successfulTargets: nonnegativeIntSchema,
	rawRecords: nonnegativeIntSchema,
	acceptedRecords: nonnegativeIntSchema,
	rejectedRecords: nonnegativeIntSchema,
	newUniqueIdentities: nonnegativeIntSchema,
	duplicateAppearances: nonnegativeIntSchema,
	retries: nonnegativeIntSchema,
	failures: nonnegativeIntSchema,
	terminalEvidence: traversalTerminalEvidenceSchema.optional(),
});

export const traversalAttemptSchema = z.object({
	attemptId: idSchema,
	status: traversalStatusSchema,
	startedAt: datetimeSchema,
	completedAt: datetimeSchema.optional(),
	summary: traversalSummarySchema,
	stepArtifactPath: z.string().trim().min(1).max(2048).optional(),
});

export const traversalResponseEvidenceSchema = z.object({
	status: z.number().int().nonnegative(),
	finalUrl: z.string().url(),
	contentType: z.string().max(255).optional(),
	surfaceValid: z.boolean(),
	blocker: z.string().max(128).optional(),
	responseFingerprint: z.string().min(8).max(128),
});
export type TraversalResponseEvidence = z.infer<typeof traversalResponseEvidenceSchema>;

export const traversalStepEvidenceSchema = z.object({
	traversalId: z.string().min(1).max(255),
	attemptId: z.string().min(1).max(255),
	sequence: z.number().int().nonnegative(),
	status: z.enum(['complete', 'failed', 'stalled', 'gap', 'limit_reached', 'cancelled']),
	target: traversalTargetSchema,
	startedAt: z.string().datetime(),
	completedAt: z.string().datetime(),
	response: traversalResponseEvidenceSchema.optional(),
	rawRecords: z.number().int().nonnegative(),
	acceptedRecords: z.number().int().nonnegative(),
	rejectedRecords: z.number().int().nonnegative(),
	newUniqueIdentities: z.number().int().nonnegative(),
	duplicateAppearances: z.number().int().nonnegative(),
	identitySetFingerprint: z.string().min(8).max(128).optional(),
	nextTargetFingerprint: z.string().min(8).max(128).optional(),
	terminalEvidence: traversalTerminalEvidenceSchema.optional(),
	error: z.string().max(1024).optional(),
});
export type TraversalStepEvidence = z.infer<typeof traversalStepEvidenceSchema>;

export const catalogueAnomalySchema = z.object({
	code: z.string().trim().min(1).max(128),
	severity: catalogueAnomalySeveritySchema,
	summary: textSchema,
	traversalId: idSchema.optional(),
	evidenceIds: z.array(idSchema).max(64).default([]),
	details: detailsSchema,
});

export const identityMetricsSchema = z.object({
	totalEntities: nonnegativeIntSchema,
	configuredFieldUsage: z
		.record(z.string().trim().min(1).max(128), nonnegativeIntSchema)
		.refine((value) => Object.keys(value).length <= 32, 'Field usage can contain at most 32 entries')
		.default({}),
	fallbackUrlCount: nonnegativeIntSchema,
	recordHashFallbackCount: nonnegativeIntSchema,
	collisionCount: nonnegativeIntSchema,
	collisions: z
		.array(
			z.object({
				productKey: z.string().trim().min(1).max(256),
				identityDescriptors: z.array(longTextSchema).min(2).max(16),
			}),
		)
		.max(256)
		.default([]),
});

export const semanticConceptMetricSchema = z.object({
	concept: catalogueRequiredConceptSchema.shape.concept,
	covered: nonnegativeIntSchema,
	total: nonnegativeIntSchema,
	coverage: coverageSchema,
	required: z.boolean(),
	minimumCoverage: coverageSchema,
});

export const requiredConceptCoverageSchema = semanticConceptMetricSchema.pick({
	concept: true,
	covered: true,
	total: true,
	coverage: true,
	minimumCoverage: true,
});

export const semanticMetricsSchema = z.object({
	concepts: z.array(semanticConceptMetricSchema).max(32).default([]),
});

export const trustDimensionSchema = z.object({
	status: trustDimensionStatusSchema,
	reasons: stringListSchema,
});

export const catalogueTrustDimensionsSchema = z.object({
	scope: trustDimensionSchema,
	records: trustDimensionSchema,
	identity: trustDimensionSchema,
	semantics: trustDimensionSchema,
	freshness: trustDimensionSchema,
});

export const catalogueTrustSummarySchema = z.object({
	policyVersion: z.literal(1),
	status: catalogueTrustStatusSchema,
	basis: catalogueTrustBasisSchema,
	scopeLabel: z.string().trim().min(1).max(256),
	entityCount: nonnegativeIntSchema,
	granularity: catalogueGranularitySchema,
	verifiedAt: datetimeSchema,
	dimensions: catalogueTrustDimensionsSchema,
	limitations: stringListSchema,
	requiredCoverage: z.array(requiredConceptCoverageSchema).max(32).default([]),
	blockerCodes: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
});

export const catalogueTrustReportSchema = z.object({
	version: z.literal(1),
	policyVersion: z.literal(1),
	runId: idSchema,
	configurationHash: z.string().trim().min(1).max(256),
	scope: catalogueScopeSchema,
	contract: catalogueContractSchema,
	verificationPlan: catalogueVerificationPlanSchema,
	sourceAssessment: z.array(scopeFitnessDecisionSchema).max(128),
	traversals: z
		.array(
			z.object({
				definition: traversalDefinitionSchema,
				attempts: z.array(traversalAttemptSchema).max(64),
				selectedAttemptId: idSchema.optional(),
			}),
		)
		.max(128),
	countSignals: z.array(countSignalSchema).max(64),
	countComparisons: z.array(countComparisonSchema).max(32),
	identity: identityMetricsSchema,
	semantics: semanticMetricsSchema,
	anomalies: z.array(catalogueAnomalySchema).max(128),
	summary: catalogueTrustSummarySchema,
});

export const catalogueCurrentStateSchema = z.object({
	setupStatus: catalogueSetupStatusSchema,
	executionStatus: catalogueExecutionStatusSchema.optional(),
	trustStatus: catalogueTrustStatusSchema.optional(),
	trustBasis: catalogueTrustBasisSchema.optional(),
	publicationStatus: cataloguePublicationStatusSchema.optional(),
	activeRunId: idSchema.optional(),
	pendingRunId: idSchema.optional(),
	activeSummary: catalogueTrustSummarySchema.optional(),
	latestSummary: catalogueTrustSummarySchema.optional(),
	latestRefreshFailed: z.boolean().default(false),
});

export type CatalogueScopeSelection = z.infer<typeof catalogueScopeSelectionSchema>;
export type CatalogueScope = z.infer<typeof catalogueScopeSchema>;
export type CatalogueRequiredConcept = z.infer<typeof catalogueRequiredConceptSchema>;
export type CatalogueContract = z.infer<typeof catalogueContractSchema>;
export type CatalogueConceptStatus = z.infer<typeof catalogueConceptStatusSchema>;
export type CatalogueConceptCapability = z.infer<typeof catalogueConceptCapabilitySchema>;
export type ScopeEvidence = z.infer<typeof scopeEvidenceSchema>;
export type ScopeFitnessDecision = z.infer<typeof scopeFitnessDecisionSchema>;
export type CountSignal = z.infer<typeof countSignalSchema>;
export type CountComparison = z.infer<typeof countComparisonSchema>;
export type TraversalDefinition = z.infer<typeof traversalDefinitionSchema>;
export type CatalogueVerificationPlan = z.infer<typeof catalogueVerificationPlanSchema>;
export type TraversalTarget = z.infer<typeof traversalTargetSchema>;
export type TraversalTerminalEvidence = z.infer<typeof traversalTerminalEvidenceSchema>;
export type TraversalSummary = z.infer<typeof traversalSummarySchema>;
export type TraversalAttempt = z.infer<typeof traversalAttemptSchema>;
export type CatalogueAnomaly = z.infer<typeof catalogueAnomalySchema>;
export type IdentityMetrics = z.infer<typeof identityMetricsSchema>;
export type SemanticConceptMetric = z.infer<typeof semanticConceptMetricSchema>;
export type RequiredConceptCoverage = z.infer<typeof requiredConceptCoverageSchema>;
export type SemanticMetrics = z.infer<typeof semanticMetricsSchema>;
export type TrustDimension = z.infer<typeof trustDimensionSchema>;
export type CatalogueTrustDimensions = z.infer<typeof catalogueTrustDimensionsSchema>;
export type CatalogueTrustSummary = z.infer<typeof catalogueTrustSummarySchema>;
export type CatalogueTrustReport = z.infer<typeof catalogueTrustReportSchema>;
export type CatalogueCurrentState = z.infer<typeof catalogueCurrentStateSchema>;

export const catalogueBaseRequiredConcepts: readonly CatalogueRequiredConcept[] = z
	.array(catalogueRequiredConceptSchema)
	.parse([
		{ concept: 'name', minimumCoverage: 1 },
		{ concept: 'source_url', minimumCoverage: 1 },
		{ concept: 'stable_identity', minimumCoverage: 1 },
	]);

export const catalogueConceptLabels: Record<CatalogueRequiredConcept['concept'], string> = {
	name: 'Product name',
	source_url: 'Source URL',
	stable_identity: 'Stable identity',
	specifications: 'Specifications',
	membership: 'Catalogue grouping',
	brand: 'Brand',
	description: 'Description',
	price: 'Price',
	availability: 'Availability',
};
