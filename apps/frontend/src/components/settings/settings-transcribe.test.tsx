// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsTranscribe } from './settings-transcribe';

const mocks = vi.hoisted(() => ({
	agentSettings: null as unknown,
	knownModels: null as unknown,
	target: null as unknown,
	pending: { agentSettings: false, knownModels: false, target: false },
}));

vi.mock('@/main', () => ({
	trpc: {
		project: {
			getAgentSettings: { queryOptions: () => ({ queryKey: ['getAgentSettings'] }) },
			getKnownTranscribeModels: { queryOptions: () => ({ queryKey: ['getKnownTranscribeModels'] }) },
			updateAgentSettings: {
				mutationOptions: (options: object) => ({ ...options, mutationKey: ['updateAgentSettings'] }),
			},
		},
		transcribe: {
			getTarget: { queryOptions: () => ({ queryKey: ['getTarget'] }) },
		},
	},
	trpcClient: {
		transcribe: { transcribe: { mutate: vi.fn() } },
	},
}));

vi.mock('@tanstack/react-query', () => ({
	useQuery: (options: { queryKey: string[] }) => {
		if (options.queryKey[0] === 'getAgentSettings') {
			return { data: mocks.agentSettings, isPending: mocks.pending.agentSettings };
		}
		if (options.queryKey[0] === 'getKnownTranscribeModels') {
			return { data: mocks.knownModels, isPending: mocks.pending.knownModels };
		}
		if (options.queryKey[0] === 'getTarget') {
			return { data: mocks.target, isPending: mocks.pending.target };
		}
		return { data: undefined, isPending: false };
	},
	useMutation: () => ({ isPending: false, mutate: vi.fn(), error: null }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

afterEach(() => {
	cleanup();
	mocks.pending = { agentSettings: false, knownModels: false, target: false };
});

describe('SettingsTranscribe target', () => {
	it('shows saved provider and error when it has no credentials', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'openai', modelId: 'gpt-4o-mini-transcribe' },
		};
		mocks.knownModels = {
			openai: {
				models: [{ id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini transcribe', default: true }],
				hasCredentials: false,
			},
			groq: {
				models: [{ id: 'whisper-large-v3', name: 'Whisper Large V3', default: true }],
				hasCredentials: true,
			},
		};
		mocks.target = {
			provider: 'openai',
			modelId: null,
			error: 'No API key configured for OpenAI. Add one in Settings > Models.',
		};

		render(<SettingsTranscribe isAdmin />);

		// Select trigger must show the saved provider instead of going blank.
		expect(screen.getAllByText(/OpenAI \(unavailable\)/).length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText('No API key configured for OpenAI. Add one in Settings > Models.')).toBeTruthy();
	});

	it('shows the auto-picked provider when nothing is saved', () => {
		mocks.agentSettings = { transcribe: { enabled: true } };
		mocks.knownModels = {
			openai: {
				models: [{ id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini transcribe', default: true }],
				hasCredentials: false,
			},
			groq: {
				models: [{ id: 'whisper-large-v3', name: 'Whisper Large V3', default: true }],
				hasCredentials: true,
			},
		};
		mocks.target = { provider: 'groq', modelId: 'whisper-large-v3', error: null };

		render(<SettingsTranscribe isAdmin />);

		expect(screen.getByText(/Groq/)).toBeTruthy();
	});

	it('shows placeholder when no transcription provider is configured', () => {
		mocks.agentSettings = { transcribe: { enabled: true } };
		mocks.knownModels = {
			openaiCompatible: {
				models: [],
				hasCredentials: true,
			},
		};
		mocks.target = {
			provider: null,
			modelId: null,
			error: 'No transcription provider configured. Add an API key for a transcription-capable provider in Settings > Models.',
		};

		render(<SettingsTranscribe isAdmin />);

		// Provider is the first combobox on the card (model is a text input here).
		const providerTrigger = screen.getAllByRole('combobox')[0];
		expect(within(providerTrigger).getByText('Select a provider')).toBeTruthy();
		expect(within(providerTrigger).queryByText('OpenAI Compatible')).toBeNull();
		expect(
			screen.getByText(
				'No transcription provider configured. Add an API key for a transcription-capable provider in Settings > Models.',
			),
		).toBeTruthy();
	});

	it('shows unavailable provider and disables model actions when saved provider is disabled', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3' },
		};
		mocks.knownModels = {
			openai: {
				models: [{ id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini transcribe', default: true }],
				hasCredentials: true,
			},
		};
		mocks.target = {
			provider: 'groq',
			modelId: 'whisper-large-v3',
			error: 'Groq is disabled via DISABLED_PROVIDERS. Enable it or choose another transcription provider in Settings > Transcription.',
		};

		render(<SettingsTranscribe isAdmin />);

		// Provider is the first combobox on the card (model is a text input when unavailable).
		const providerTrigger = screen.getAllByRole('combobox')[0];
		expect(within(providerTrigger).getByText('Groq (unavailable)')).toBeTruthy();

		const modelInput = screen.getByPlaceholderText('Model ID, e.g. whisper-large-v3');
		expect((modelInput as HTMLInputElement).disabled).toBe(true);

		const saveButton = screen.getByRole('button', { name: 'Save' });
		expect((saveButton as HTMLButtonElement).disabled).toBe(true);

		const testButton = screen.getByRole('button', { name: 'Test' });
		expect((testButton as HTMLButtonElement).disabled).toBe(true);

		// Provider Select stays enabled so the user can switch away.
		expect((providerTrigger as HTMLButtonElement).disabled).toBe(false);

		expect(
			screen.getByText(
				'Groq is disabled via DISABLED_PROVIDERS. Enable it or choose another transcription provider in Settings > Transcription.',
			),
		).toBeTruthy();
	});

	it('shows neither the no-key message nor an unavailable provider while the queries load', () => {
		mocks.agentSettings = { transcribe: { enabled: true } };
		mocks.knownModels = undefined;
		mocks.target = undefined;
		mocks.pending = { agentSettings: false, knownModels: true, target: true };

		const { container } = render(<SettingsTranscribe isAdmin />);

		expect(container.textContent).not.toMatch(/must be\s+configured/);
		expect(container.textContent).not.toContain('(unavailable)');
	});

	it('does not mark the saved provider unavailable while the known models still load', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3' },
		};
		mocks.knownModels = undefined;
		mocks.target = { provider: 'groq', modelId: 'whisper-large-v3', error: null };
		mocks.pending = { agentSettings: false, knownModels: true, target: false };

		const { container } = render(<SettingsTranscribe isAdmin />);

		expect(container.textContent).not.toContain('(unavailable)');
	});

	it('shows the no-key message once the queries loaded without a usable provider', () => {
		mocks.agentSettings = { transcribe: { enabled: true } };
		mocks.knownModels = { openai: { models: [], hasCredentials: false } };
		mocks.target = { provider: null, modelId: null, error: 'No transcription provider configured.' };

		const { container } = render(<SettingsTranscribe isAdmin />);

		expect(container.textContent).toMatch(/must be\s+configured/);
	});
});
