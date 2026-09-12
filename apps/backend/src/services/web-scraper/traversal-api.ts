import type { WebRobotStage } from '@nao/shared/web-robot';
import type { CatalogueAnomaly, TraversalTerminalEvidence } from '@nao/shared/web-robot-trust';

import { getPathValue } from './template';
import { fingerprintEvidence } from './traversal-evidence';

export type ApiTraversalPagination = Extract<
	NonNullable<WebRobotStage['paginate']>,
	{ type: 'page' | 'offset' | 'cursor' | 'nextPath' }
>;

export type ApiTraversalAdvanceInput = {
	pagination: ApiTraversalPagination;
	currentValue: unknown;
	body: unknown;
	extractedCount: number;
	firstPageSize?: number;
	previousTotal?: number;
	previousItemTotal?: number;
	seenCursorFingerprints: Set<string>;
	consecutiveNoProgress: number;
	newUniqueIdentities: number;
};

export type ApiTraversalAdvance = {
	nextValue?: unknown;
	terminalEvidence?: TraversalTerminalEvidence;
	anomaly?: CatalogueAnomaly;
	nextTotal?: number;
	nextItemTotal?: number;
};

const terminal = (kind: TraversalTerminalEvidence['kind'], summary: string): TraversalTerminalEvidence => ({
	kind,
	summary,
	details: {},
});

const blocking = (code: string, summary: string): CatalogueAnomaly => ({
	code,
	severity: 'blocking',
	summary,
	evidenceIds: [],
	details: {},
});

export const advanceApiTraversal = (input: ApiTraversalAdvanceInput): ApiTraversalAdvance => {
	switch (input.pagination.type) {
		case 'page':
			return advancePage(input);
		case 'offset':
			return advanceOffset(input);
		case 'cursor':
			return advanceCursor(input);
		case 'nextPath':
			return advanceNextPath(input);
	}
};

const advancePage = (input: ApiTraversalAdvanceInput): ApiTraversalAdvance => {
	const pagination = input.pagination as Extract<ApiTraversalPagination, { type: 'page' }>;
	const current = Number(input.currentValue);
	const itemTotal = declaredItemTotal(input, pagination);
	if (itemTotal.anomaly) {
		return { anomaly: itemTotal.anomaly };
	}
	const itemEvidence: Pick<ApiTraversalAdvance, 'nextItemTotal'> =
		itemTotal.value !== undefined ? { nextItemTotal: itemTotal.value } : {};

	if (pagination.totalPagesPath) {
		const total = Number(getPathValue(input.body, pagination.totalPagesPath));
		if (!Number.isFinite(total) || total < 0) {
			return { anomaly: blocking('count_conflict', 'The declared total page count was missing or invalid.') };
		}
		if (input.previousTotal !== undefined && total !== input.previousTotal) {
			return {
				anomaly: blocking(
					'source_changed_during_run',
					'The declared total page count changed during traversal.',
				),
			};
		}
		if (input.extractedCount === 0 && current < total) {
			return {
				nextTotal: total,
				anomaly: blocking(
					'missing_intermediate_page',
					`Page ${current} returned no records before the declared final page ${total}.`,
				),
			};
		}
		if (current < total) {
			return { nextValue: current + 1, nextTotal: total, ...itemEvidence };
		}
		if (current === total) {
			return {
				nextTotal: total,
				...itemEvidence,
				terminalEvidence: terminal('declared_last_page', `Reached declared final page ${total}.`),
			};
		}
		return {
			nextTotal: total,
			anomaly: blocking('count_conflict', `Page ${current} exceeded the declared total ${total}.`),
		};
	}

	const hasNext = booleanField(input.body, ['hasNext', 'has_next']);
	if (hasNext === false) {
		return {
			...itemEvidence,
			terminalEvidence: terminal('has_next_false', 'The source reported there is no next page.'),
		};
	}
	if (input.firstPageSize !== undefined && input.extractedCount > 0 && input.extractedCount < input.firstPageSize) {
		return {
			...itemEvidence,
			terminalEvidence: terminal('short_final_page', 'A short final page ended pagination.'),
		};
	}
	if (input.extractedCount === 0) {
		return { ...itemEvidence, terminalEvidence: terminal('empty_final_page', 'An empty page ended pagination.') };
	}
	return { nextValue: current + 1, ...itemEvidence };
};

const declaredItemTotal = (
	input: ApiTraversalAdvanceInput,
	pagination: Extract<ApiTraversalPagination, { type: 'page' }>,
): { value?: number; anomaly?: CatalogueAnomaly } => {
	if (!pagination.totalItemsPath) {
		return {};
	}
	const value = Number(getPathValue(input.body, pagination.totalItemsPath));
	if (!Number.isFinite(value) || value < 0) {
		return { anomaly: blocking('count_conflict', 'The declared total item count was missing or invalid.') };
	}
	if (input.previousItemTotal !== undefined && value !== input.previousItemTotal) {
		return {
			anomaly: blocking('source_changed_during_run', 'The declared total item count changed during traversal.'),
		};
	}
	return { value };
};

const advanceOffset = (input: ApiTraversalAdvanceInput): ApiTraversalAdvance => {
	const pagination = input.pagination as Extract<ApiTraversalPagination, { type: 'offset' }>;
	const currentOffset = Number(input.currentValue);

	if (pagination.totalPath) {
		const total = Number(getPathValue(input.body, pagination.totalPath));
		if (!Number.isFinite(total) || total < 0) {
			return { anomaly: blocking('count_conflict', 'The declared total count was missing or invalid.') };
		}
		if (input.previousTotal !== undefined && total !== input.previousTotal) {
			return {
				anomaly: blocking('source_changed_during_run', 'The declared total count changed during traversal.'),
			};
		}
		const reached = currentOffset + input.extractedCount;
		if (reached > total) {
			return {
				nextTotal: total,
				anomaly: blocking(
					'count_conflict',
					`Offset window reached ${reached} records beyond the declared total ${total}.`,
				),
			};
		}
		if (reached >= total) {
			return {
				nextTotal: total,
				terminalEvidence: terminal('offset_reached_total', `Offset reached the declared total ${total}.`),
			};
		}
		if (input.extractedCount === 0 || input.extractedCount < pagination.pageSize) {
			return {
				nextTotal: total,
				anomaly: blocking(
					'count_conflict',
					`Offset page returned ${input.extractedCount} records before the declared total ${total}.`,
				),
			};
		}
		return { nextValue: currentOffset + pagination.pageSize, nextTotal: total };
	}

	if (input.extractedCount === 0) {
		return { terminalEvidence: terminal('empty_final_page', 'An empty page ended pagination.') };
	}
	if (input.extractedCount < pagination.pageSize) {
		return { terminalEvidence: terminal('short_final_page', 'A short final page ended pagination.') };
	}
	return { nextValue: currentOffset + pagination.pageSize };
};

const advanceCursor = (input: ApiTraversalAdvanceInput): ApiTraversalAdvance => {
	const pagination = input.pagination as Extract<ApiTraversalPagination, { type: 'cursor' }>;
	const next = getPathValue(input.body, pagination.nextCursorPath);
	if ((typeof next !== 'string' && typeof next !== 'number') || String(next) === '') {
		return { terminalEvidence: terminal('cursor_exhausted', 'The source returned no further cursor.') };
	}

	const nextCursor = String(next);
	const fingerprint = fingerprintEvidence(nextCursor);
	if (input.seenCursorFingerprints.has(fingerprint)) {
		return {
			anomaly: blocking('traversal_loop', 'The source returned an already-seen pagination cursor.'),
		};
	}
	if (input.newUniqueIdentities === 0 && input.consecutiveNoProgress + 1 >= 2) {
		return {
			anomaly: blocking('traversal_stalled', 'Two consecutive cursor pages produced no new unique records.'),
		};
	}
	return { nextValue: nextCursor };
};

const advanceNextPath = (input: ApiTraversalAdvanceInput): ApiTraversalAdvance => {
	const pagination = input.pagination as Extract<ApiTraversalPagination, { type: 'nextPath' }>;
	const next = getPathValue(input.body, pagination.path);
	if (typeof next !== 'string' || next === '') {
		return { terminalEvidence: terminal('has_next_false', 'The source returned no next page path.') };
	}
	return { nextValue: next };
};

const booleanField = (body: unknown, keys: string[]): boolean | undefined => {
	if (!body || typeof body !== 'object') {
		return undefined;
	}
	const record = body as Record<string, unknown>;
	for (const key of keys) {
		if (typeof record[key] === 'boolean') {
			return record[key];
		}
	}
	return undefined;
};
