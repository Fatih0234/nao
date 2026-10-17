// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { getMicWarningMessage, isTranscribeReadyForChat } from './chat-input';

vi.mock('maplibre-gl', () => ({}));
vi.mock('@/main', () => ({
	trpc: {
		project: {
			getAgentSettings: { queryOptions: () => ({ queryKey: ['getAgentSettings'] }) },
			getDatabaseObjects: { queryOptions: () => ({ queryKey: ['getDatabaseObjects'] }) },
		},
		storage: { getUploadLimits: { queryOptions: () => ({ queryKey: ['getUploadLimits'] }) } },
		budget: { checkBudgetStatus: { queryOptions: () => ({ queryKey: ['checkBudgetStatus'] }) } },
		skill: { list: { queryOptions: () => ({ queryKey: ['skillList'] }) } },
		transcribe: { getTarget: { queryOptions: () => ({ queryKey: ['getTarget'] }) } },
	},
	trpcClient: { transcribe: { transcribe: { mutate: vi.fn() } } },
}));

describe('isTranscribeReadyForChat', () => {
	it('is ready when transcription is enabled and the target has no error', () => {
		expect(isTranscribeReadyForChat(true, { provider: 'groq', error: null })).toBe(true);
	});

	it('is not ready when the target has an error', () => {
		expect(
			isTranscribeReadyForChat(true, {
				provider: 'openai',
				error: 'No API key configured for OpenAI. Add one in Settings > Models.',
			}),
		).toBe(false);
	});

	it('is not ready when no provider is configured', () => {
		expect(
			isTranscribeReadyForChat(true, {
				provider: null,
				error: 'No transcription provider configured. Add an API key for a transcription-capable provider in Settings > Models.',
			}),
		).toBe(false);
	});

	it('is not ready when transcription is disabled', () => {
		expect(isTranscribeReadyForChat(false, { provider: 'groq', error: null })).toBe(false);
	});
});

describe('getMicWarningMessage', () => {
	it('returns the target error only when transcription is enabled', () => {
		const target = {
			provider: 'groq',
			error: 'Groq is disabled via DISABLED_PROVIDERS. Enable it or choose another transcription provider in Settings > Transcription.',
		} as const;
		expect(getMicWarningMessage(true, target)).toBe(target.error);
		expect(getMicWarningMessage(false, target)).toBeUndefined();
		expect(getMicWarningMessage(true, { provider: 'groq', error: null })).toBeUndefined();
		expect(getMicWarningMessage(true, undefined)).toBeUndefined();
	});
});
