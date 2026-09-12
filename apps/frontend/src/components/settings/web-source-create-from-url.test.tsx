// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSourceCreateFromUrl } from './web-source-create-from-url';

const mocks = vi.hoisted(() => ({
	analyzeUrl: vi.fn(),
	createFromUrl: vi.fn(),
}));

vi.mock('@/main', () => ({
	trpc: {
		webRobot: {
			analyzeUrl: {
				mutationOptions: () => ({ mutationFn: mocks.analyzeUrl }),
			},
			createFromUrl: {
				mutationOptions: (options?: Record<string, unknown>) => ({
					...options,
					mutationFn: mocks.createFromUrl,
				}),
			},
		},
	},
}));

const capabilities = (overrides: Partial<Record<string, 'detected' | 'requires_enrichment' | 'not_detected'>> = {}) =>
	[
		'name',
		'source_url',
		'stable_identity',
		'specifications',
		'membership',
		'brand',
		'description',
		'price',
		'availability',
	].map((concept) => ({
		concept,
		status: overrides[concept] ?? ('detected' as const),
		covered: 3,
		sampled: 3,
		detail: '',
	}));

const readyAnalysis = (capabilityOverrides?: Parameters<typeof capabilities>[0]) => ({
	status: 'ready' as const,
	recipe: { version: 2, allowedHosts: ['example.com'], stages: [] },
	score: 91,
	sampleProducts: [],
	scope: {
		version: 1,
		id: 'scope-1',
		label: 'All products',
		entryUrl: 'https://example.com/products',
		includedUrls: ['https://example.com/products'],
		excludedPatterns: [],
		activeFilters: {},
		selection: { mode: 'automatic', candidateId: 'api-1', confidence: 'high', rationale: [] },
	},
	contract: {
		version: 1,
		entityGranularity: 'variant',
		requiredConcepts: [],
		publishWhenReady: true,
		createdAt: '2026-01-01T00:00:00.000Z',
	},
	verificationPlan: { version: 1, scopeId: 'scope-1', traversals: [], countSignalIds: [] },
	sourceAssessment: [],
	scopeEvidence: [],
	countSignals: [],
	capabilities: capabilities(capabilityOverrides),
	warnings: [],
	diagnostics: {
		discovery: {
			url: 'https://example.com/products',
			finalUrl: 'https://example.com/products',
			allowedHosts: ['example.com'],
			title: 'Example products',
			counts: { api: 1, endpoint: 0, jsonLd: 0, embedded: 0, dom: 0, detail: 0, pagination: 0, actions: 0 },
			pagination: [],
			actions: [],
			endpoints: [],
			blockers: [],
			pageContext: { kind: 'http' },
		},
		candidates: [],
	},
});

const renderForm = () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<WebSourceCreateFromUrl onCreated={vi.fn()} onPrefillRecipe={vi.fn()} />
		</QueryClientProvider>,
	);
};

const analyze = async (analysis: ReturnType<typeof readyAnalysis>) => {
	mocks.analyzeUrl.mockResolvedValue(analysis);
	renderForm();
	fireEvent.change(screen.getByPlaceholderText('https://example.com/products'), {
		target: { value: 'https://example.com/products' },
	});
	fireEvent.click(screen.getByRole('button', { name: /Analyze source/ }));
	await waitFor(() => screen.getByText(/Choose quality requirements/));
};

const conceptCard = (label: string): HTMLElement => {
	const text = screen.getByText(label);
	const card = text.closest('label');
	expect(card, `card for ${label}`).not.toBeNull();
	return card!;
};

const conceptCheckbox = (label: string): HTMLElement => {
	const checkbox = conceptCard(label).querySelector('[role="checkbox"]');
	expect(checkbox, `checkbox for ${label}`).not.toBeNull();
	return checkbox as HTMLElement;
};

describe('WebSourceCreateFromUrl', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it('pre-selects detected default concepts and skips undetected ones', async () => {
		await analyze(readyAnalysis({ membership: 'not_detected' }));

		expect(conceptCheckbox('Specifications').getAttribute('aria-checked')).toBe('true');
		expect(conceptCheckbox('Catalogue grouping').getAttribute('aria-checked')).toBe('false');
	});

	it('renders capability badges and detail text per concept', async () => {
		await analyze(
			readyAnalysis({ membership: 'not_detected', brand: 'requires_enrichment', specifications: 'detected' }),
		);

		expect(conceptCard('Specifications').textContent).toContain('Detected');
		expect(conceptCard('Specifications').textContent).toContain('Found in the analysed sample.');
		expect(conceptCard('Catalogue grouping').textContent).toContain('Not detected');
		expect(conceptCard('Catalogue grouping').textContent).toContain('may block the first refresh');
		expect(conceptCard('Brand').textContent).toContain('From detail pages');
		expect(conceptCard('Brand').textContent).toContain('found in 3 of 3 sampled products');
	});

	it('warns when an undetected concept is selected and keeps the user choice', async () => {
		await analyze(readyAnalysis({ membership: 'not_detected' }));

		expect(screen.queryByText(/was not found in the analysed sample\. Requiring/)).toBeNull();
		fireEvent.click(conceptCheckbox('Catalogue grouping'));

		await waitFor(() =>
			expect(screen.getByText(/Catalogue grouping was not found in the analysed sample/)).toBeTruthy(),
		);
		expect(conceptCheckbox('Catalogue grouping').getAttribute('aria-checked')).toBe('true');
	});

	it('warns when required base concepts are undetected', async () => {
		await analyze(readyAnalysis({ name: 'not_detected' }));

		await waitFor(() =>
			expect(screen.getByText(/required for every product — the first refresh may fail/)).toBeTruthy(),
		);
		expect(screen.getByText(/Product name/)).toBeTruthy();
	});

	it('sends the evidence-filtered selection to createFromUrl', async () => {
		mocks.createFromUrl.mockResolvedValue({ status: 'created', robot: { id: 'robot-1' } });
		await analyze(readyAnalysis({ membership: 'not_detected' }));

		fireEvent.click(conceptCheckbox('Brand'));
		fireEvent.click(
			screen
				.getByText('This is the catalogue scope I intend to publish.')
				.closest('label')!
				.querySelector('[role="checkbox"]')!,
		);
		fireEvent.click(screen.getByRole('button', { name: /Create source/ }));

		await waitFor(() => expect(mocks.createFromUrl).toHaveBeenCalled());
		expect(mocks.createFromUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://example.com/products',
				requiredConcepts: ['specifications', 'brand'],
			}),
			expect.anything(),
		);
	});

	it('keeps the user selection when re-rendered', async () => {
		await analyze(readyAnalysis());

		fireEvent.click(conceptCheckbox('Price'));
		fireEvent.click(conceptCheckbox('Specifications'));

		expect(conceptCheckbox('Price').getAttribute('aria-checked')).toBe('true');
		expect(conceptCheckbox('Specifications').getAttribute('aria-checked')).toBe('false');
		expect(conceptCheckbox('Catalogue grouping').getAttribute('aria-checked')).toBe('true');
	});
});
