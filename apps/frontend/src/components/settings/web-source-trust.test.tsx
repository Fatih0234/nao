// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { WebSourceTrust } from './web-source-trust';
import type { CatalogueCurrentState, CatalogueTrustSummary } from '@nao/shared/web-robot-trust';

const dimensions = (semantics: 'passed' | 'failed'): CatalogueTrustSummary['dimensions'] => ({
	scope: { status: 'passed', reasons: [] },
	records: { status: 'passed', reasons: [] },
	identity: { status: 'passed', reasons: [] },
	semantics: { status: semantics, reasons: semantics === 'failed' ? ['membership missing'] : [] },
	freshness: { status: 'unknown', reasons: [] },
});

const readySummary: CatalogueTrustSummary = {
	policyVersion: 1,
	status: 'ready',
	basis: 'count_reconciled',
	scopeLabel: 'All pumps',
	entityCount: 54,
	granularity: 'variant',
	verifiedAt: '2026-01-01T00:01:00.000Z',
	dimensions: dimensions('passed'),
	limitations: [],
	requiredCoverage: [],
	blockerCodes: [],
};

const failedSummary: CatalogueTrustSummary = {
	...readySummary,
	status: 'needs_attention',
	basis: 'none',
	dimensions: dimensions('failed'),
	requiredCoverage: [{ concept: 'membership', covered: 0, total: 54, coverage: 0, minimumCoverage: 0.95 }],
	blockerCodes: ['dimension_semantics', 'required_concept_membership'],
};

const state = (overrides: Partial<CatalogueCurrentState>): CatalogueCurrentState => ({
	setupStatus: 'configured',
	latestRefreshFailed: false,
	...overrides,
});

describe('WebSourceTrust', () => {
	afterEach(() => {
		cleanup();
	});

	it('renders a failed latest refresh without a published dataset path', () => {
		render(
			<WebSourceTrust
				state={state({
					executionStatus: 'succeeded',
					trustStatus: 'needs_attention',
					publicationStatus: 'blocked_initial',
					latestSummary: failedSummary,
				})}
			/>,
		);

		expect(screen.getByText('Checks need attention')).toBeTruthy();
		expect(screen.getByText('The latest refresh did not pass all quality checks.')).toBeTruthy();
		expect(screen.getByText('No agent-visible dataset exists for this source yet.')).toBeTruthy();
		expect(screen.getByText('Latest refresh checks')).toBeTruthy();
		expect(screen.getAllByText('Required product data').length).toBeGreaterThan(0);
		expect(screen.getByText(/membership 0%/)).toBeTruthy();
		expect(screen.getByText(/minimum 95%/)).toBeTruthy();
		expect(screen.getByText('dimension_semantics')).toBeTruthy();
		expect(screen.getByText('required_concept_membership')).toBeTruthy();
		expect(screen.queryByText(/\/datasets\//)).toBeNull();
	});

	it('renders the active publication and the latest refresh checks together', () => {
		render(
			<WebSourceTrust
				state={state({
					executionStatus: 'succeeded',
					trustStatus: 'needs_attention',
					publicationStatus: 'retained_previous',
					activeRunId: 'run-active',
					activeSummary: readySummary,
					latestSummary: failedSummary,
					latestRefreshFailed: true,
				})}
			/>,
		);

		expect(screen.getByText('Quality checks')).toBeTruthy();
		expect(screen.getByText('Checks need attention')).toBeTruthy();
		expect(screen.getByText('Latest refresh checks')).toBeTruthy();
		expect(screen.getByText('required_concept_membership')).toBeTruthy();
		expect(screen.queryByText('Ready')).toBeNull();
		expect(screen.queryByText(/\/datasets\//)).toBeNull();
	});

	it('renders checks running while a refresh is in progress', () => {
		render(
			<WebSourceTrust
				state={state({
					executionStatus: 'running',
				})}
			/>,
		);

		expect(screen.getByText('Checks running')).toBeTruthy();
		expect(screen.getByText('The current refresh is collecting and checking new data.')).toBeTruthy();
	});
});
