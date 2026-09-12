export const WEB_ROBOT_RUN_TRIGGERS = ['schedule', 'manual'] as const;
export type WebRobotRunTrigger = (typeof WEB_ROBOT_RUN_TRIGGERS)[number];

export const WEB_ROBOT_RUN_STATUSES = ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'] as const;
export type WebRobotRunStatus = (typeof WEB_ROBOT_RUN_STATUSES)[number];

export const WEB_ROBOT_ACTIVE_RUN_STATUSES = ['queued', 'running'] as const;
export type WebRobotActiveRunStatus = (typeof WEB_ROBOT_ACTIVE_RUN_STATUSES)[number];

export const WEB_ROBOT_CONFIGURATION_STATUSES = ['draft', 'active', 'superseded'] as const;
export type WebRobotConfigurationStatus = (typeof WEB_ROBOT_CONFIGURATION_STATUSES)[number];

export const WEB_ROBOT_EXECUTION_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type WebRobotExecutionStatus = (typeof WEB_ROBOT_EXECUTION_STATUSES)[number];

export const WEB_ROBOT_TRUST_STATUSES = ['ready', 'needs_attention'] as const;
export type WebRobotTrustStatus = (typeof WEB_ROBOT_TRUST_STATUSES)[number];

export const WEB_ROBOT_TRUST_BASES = ['count_reconciled', 'traversal_complete', 'none'] as const;
export type WebRobotTrustBasis = (typeof WEB_ROBOT_TRUST_BASES)[number];

export const WEB_ROBOT_PUBLICATION_STATUSES = [
	'pending',
	'published',
	'retained_previous',
	'blocked_initial',
	'publication_failed',
	'not_evaluated',
] as const;
export type WebRobotPublicationStatus = (typeof WEB_ROBOT_PUBLICATION_STATUSES)[number];
