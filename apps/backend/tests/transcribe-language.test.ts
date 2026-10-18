import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
	agentSettings: null as { transcribe?: Record<string, unknown> } | null,
	result: undefined as
		| {
				text: string;
				language?: string;
				responses: Array<{ body?: unknown }>;
		  }
		| undefined,
}));

vi.mock('../src/queries/project.queries', () => ({
	getProjectById: vi.fn(async () => ({ id: 'project-id', path: '', envVars: {} })),
	getAgentSettings: vi.fn(async () => testState.agentSettings),
}));

vi.mock('../src/queries/project-llm-config.queries', () => ({
	getProjectLlmConfigs: vi.fn(async () => []),
	getProjectLlmConfigByProvider: vi.fn(async () => null),
}));

vi.mock('ai', async (importOriginal) => {
	const original = await importOriginal<typeof import('ai')>();
	return {
		...original,
		experimental_transcribe: vi.fn(async () => testState.result),
	};
});

vi.mock('../src/utils/logger', () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { transcribeAudio } from '../src/services/transcribe.service';

describe('transcribeAudio result', () => {
	beforeEach(() => {
		process.env.OPENAI_API_KEY = 'test-openai-key';
		testState.agentSettings = { transcribe: { provider: 'openai' } };
	});

	it('returns the SDK text and language', async () => {
		testState.result = { text: 'hello', language: 'tr', responses: [] };

		expect(await transcribeAudio('project-id', 'aGk=')).toEqual({ text: 'hello', language: 'tr' });
	});

	it('falls back to a string language from the raw response body', async () => {
		testState.result = { text: 'hello', responses: [{ body: { language: 'English' } }] };

		expect(await transcribeAudio('project-id', 'aGk=')).toEqual({ text: 'hello', language: 'English' });
	});
});
