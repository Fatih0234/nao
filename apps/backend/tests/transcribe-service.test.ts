import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
	projectPath: '',
	dbConfigs: [] as Array<{ provider: string; apiKey: string | null; baseUrl: string | null }>,
	agentSettings: null as { transcribe?: Record<string, unknown> } | null,
	transcribeCalls: [] as Array<{
		providerOptions?: { openai?: Record<string, unknown> };
		model?: { modelId?: string };
	}>,
	transcribeResult: undefined as
		| { text: string; segments: unknown[]; language?: string; durationInSeconds?: number; responses?: unknown[] }
		| undefined,
}));

vi.mock('../src/queries/project.queries', () => ({
	getProjectById: vi.fn(async () => ({
		id: 'project-id',
		name: 'Test project',
		path: testState.projectPath,
		envVars: {},
	})),
	getAgentSettings: vi.fn(async () => testState.agentSettings),
}));

vi.mock('../src/queries/project-llm-config.queries', () => ({
	getProjectLlmConfigs: vi.fn(async () => testState.dbConfigs),
	getProjectLlmConfigByProvider: vi.fn(async (_projectId: string, provider: string) => {
		return testState.dbConfigs.find((c) => c.provider === provider) ?? null;
	}),
}));

vi.mock('../src/utils/logger', () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('ai', async (importOriginal) => {
	const original = await importOriginal<typeof import('ai')>();
	return {
		...original,
		experimental_transcribe: vi.fn(
			async (args: { providerOptions?: { openai?: Record<string, unknown> }; model?: { modelId?: string } }) => {
				testState.transcribeCalls.push(args);
				return (
					testState.transcribeResult ?? {
						text: 'hello',
						segments: [],
						language: 'tr',
						durationInSeconds: 5,
						responses: [],
					}
				);
			},
		),
	};
});

import { PROVIDER_META } from '../src/agents/provider-meta';
import { __reloadEnvForTesting } from '../src/env';
import {
	listAvailableTranscribeModels,
	resolveTranscribeTarget,
	transcribeAudio,
} from '../src/services/transcribe.service';
import type { TranscribeModelDef } from '../src/types/llm';

const directories: string[] = [];

beforeEach(() => {
	testState.dbConfigs = [];
	testState.projectPath = '';
	testState.agentSettings = null;
	testState.transcribeCalls = [];
	testState.transcribeResult = undefined;
	for (const name of Object.keys(process.env)) {
		if (/^(OPENAI|GROQ|OPENROUTER|MISTRAL|REQUESTY|DISABLED_PROVIDERS)/.test(name)) {
			delete process.env[name];
		}
	}
	__reloadEnvForTesting();
});

afterAll(() => {
	for (const directory of directories) {
		fs.rmSync(directory, { force: true, recursive: true });
	}
});

describe('listAvailableTranscribeModels', () => {
	it('lists every transcription-capable kind, marking the env-configured ones', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';

		const available = await listAvailableTranscribeModels('project-id');

		expect(Object.keys(available)).toEqual(['openai', 'openrouter', 'groq', 'openaiCompatible']);
		expect(available.groq.hasCredentials).toBe(true);
		expect(available.openai.hasCredentials).toBe(false);
		expect(available.groq.models[0]?.id).toBe('whisper-large-v3');
	});

	it('counts credentials declared only in nao_config.yaml', async () => {
		writeConfig(['llm:', '  providers:', '  - provider: openrouter', '    api_key: sk-or-from-config']);

		const available = await listAvailableTranscribeModels('project-id');

		expect(available.openrouter.hasCredentials).toBe(true);
	});

	it('lists a named openaiCompatible instance with its own credentials', async () => {
		writeConfig([
			'llm:',
			'  providers:',
			'  - provider: openai-compatible/my-stt',
			'    base_url: http://localhost:8788/v1',
		]);

		const available = await listAvailableTranscribeModels('project-id');

		expect(available['openaiCompatible/my-stt']).toEqual({ models: [], hasCredentials: true });
	});

	it('offers bare openaiCompatible credentials without enabling transcription', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-test';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:8788/v1';

		const available = await listAvailableTranscribeModels('project-id');

		expect(available.openaiCompatible).toEqual({ models: [], hasCredentials: true });
	});

	it('never lists a kind that has no audio endpoint', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

		const available = await listAvailableTranscribeModels('project-id');

		expect(available.anthropic).toBeUndefined();
	});
});

describe('transcribeAudio', () => {
	it('uses the saved provider and model id', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';
		testState.agentSettings = {
			transcribe: { provider: 'groq', modelId: 'whisper-large-v3-turbo' },
		};

		const result = await transcribeAudio('project-id', 'aGk=');

		expect(result).toEqual({ text: 'hello', language: 'tr' });
		expect(testState.transcribeCalls.at(-1)?.model?.modelId).toBe('whisper-large-v3-turbo');
	});

	it('rejects a saved non-transcription provider without falling back', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';
		testState.agentSettings = {
			transcribe: { provider: 'anthropic', modelId: 'claude-not-audio' },
		};

		await expect(transcribeAudio('project-id', 'aGk=')).rejects.toThrow(
			'Anthropic is not a transcription-capable provider',
		);

		expect(testState.transcribeCalls).toHaveLength(0);
	});

	it('reports when a saved named provider no longer exists', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';
		testState.agentSettings = {
			transcribe: { provider: 'openaiCompatible/missing-stt', modelId: 'custom-whisper' },
		};

		await expect(transcribeAudio('project-id', 'aGk=')).rejects.toThrow('missing-stt is no longer configured');
		expect(testState.transcribeCalls).toHaveLength(0);
	});

	it('uses the first keyed provider when nothing was saved', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';
		testState.transcribeResult = { text: 'hi', segments: [], responses: [] };

		await transcribeAudio('project-id', 'aGk=');

		expect(testState.transcribeCalls.at(-1)?.model?.modelId).toBe('whisper-large-v3');
	});

	it('does not auto-pick bare openaiCompatible when it has no catalog model', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-test';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:8788/v1';

		await expect(resolveTranscribeTarget('project-id')).resolves.toMatchObject({
			ok: false,
			provider: null,
			error: expect.stringContaining('No transcription provider configured.'),
		});
		await expect(transcribeAudio('project-id', 'aGk=')).rejects.toThrow('No transcription provider configured.');
		expect(testState.transcribeCalls).toHaveLength(0);
	});

	it('auto-picks Groq instead of bare openaiCompatible when both have credentials', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-test';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:8788/v1';
		process.env.GROQ_API_KEY = 'gsk-test';

		const target = await resolveTranscribeTarget('project-id');

		expect(target).toMatchObject({ ok: true, provider: 'groq', modelId: 'whisper-large-v3' });
	});

	it('ignores a saved model id when no provider was saved', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';
		testState.agentSettings = { transcribe: { modelId: 'stale-model' } };

		const target = await resolveTranscribeTarget('project-id');

		expect(target).toMatchObject({ ok: true, provider: 'groq', modelId: 'whisper-large-v3' });
	});

	it('ignores a modelId override passed without an override provider', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';

		await transcribeAudio('project-id', 'aGk=', { modelId: 'x' });

		expect(testState.transcribeCalls.at(-1)?.model?.modelId).toBe('whisper-large-v3');
	});

	it('uses an explicit override provider default instead of another saved provider model', async () => {
		process.env.OPENAI_API_KEY = 'sk-test';
		testState.agentSettings = { transcribe: { provider: 'groq', modelId: 'whisper-large-v3-turbo' } };

		await transcribeAudio('project-id', 'aGk=', { provider: 'openai' });

		expect(testState.transcribeCalls.at(-1)?.model?.modelId).toBe('gpt-4o-mini-transcribe');
	});

	it('rejects a saved provider disabled via DISABLED_PROVIDERS without calling transcription', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';
		process.env.DISABLED_PROVIDERS = 'groq';
		__reloadEnvForTesting();
		testState.agentSettings = { transcribe: { provider: 'groq' } };

		await expect(transcribeAudio('project-id', 'aGk=')).rejects.toThrow('Groq is disabled via DISABLED_PROVIDERS');
		await expect(resolveTranscribeTarget('project-id')).resolves.toMatchObject({
			ok: false,
			provider: 'groq',
			error: expect.stringContaining('Groq'),
		});
		expect(testState.transcribeCalls).toHaveLength(0);
	});

	it('throws a clear error when the provider has no model id', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-test';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:8788/v1';
		testState.agentSettings = { transcribe: { provider: 'openaiCompatible' } };

		await expect(transcribeAudio('project-id', 'aGk=')).rejects.toThrow('Select a transcription model');
	});

	it('rejects an explicit override without credentials instead of falling back', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';

		await expect(
			transcribeAudio('project-id', 'aGk=', { provider: 'openai', modelId: 'whisper-1' }),
		).rejects.toThrow('No API key configured for OpenAI');
		expect(testState.transcribeCalls).toHaveLength(0);
	});

	it('rejects a saved provider without credentials instead of falling back', async () => {
		process.env.GROQ_API_KEY = 'gsk-test';
		testState.agentSettings = {
			transcribe: { provider: 'openai', modelId: 'gpt-4o-mini-transcribe' },
		};

		await expect(transcribeAudio('project-id', 'aGk=')).rejects.toThrow(
			'No API key configured for OpenAI. Add one in Settings > Models.',
		);
		expect(testState.transcribeCalls).toHaveLength(0);
	});

	it('rejects a saved named openaiCompatible instance without a base URL before calling transcription', async () => {
		writeConfig(['llm:', '  providers:', '  - provider: openai-compatible/my-stt', '    api_key: sk-test']);
		testState.agentSettings = { transcribe: { provider: 'openaiCompatible/my-stt', modelId: 'custom-whisper' } };

		await expect(resolveTranscribeTarget('project-id')).resolves.toMatchObject({
			ok: false,
			provider: 'openaiCompatible/my-stt',
			error: expect.stringContaining('needs a base URL'),
		});
		await expect(transcribeAudio('project-id', 'aGk=')).rejects.toThrow('my-stt needs a base URL');
		expect(testState.transcribeCalls).toHaveLength(0);
	});

	it('rejects a saved bare openaiCompatible with a key but no base URL', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-test';
		testState.agentSettings = { transcribe: { provider: 'openaiCompatible', modelId: 'custom-whisper' } };

		await expect(resolveTranscribeTarget('project-id')).resolves.toMatchObject({
			ok: false,
			provider: 'openaiCompatible',
			error: expect.stringContaining('needs a base URL'),
		});
		await expect(transcribeAudio('project-id', 'aGk=')).rejects.toThrow('needs a base URL');
		expect(testState.transcribeCalls).toHaveLength(0);
	});

	it('rejects an explicit openaiCompatible override without a base URL', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-test';
		const override = { provider: 'openaiCompatible', modelId: 'custom-whisper' } as const;

		await expect(resolveTranscribeTarget('project-id', override)).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining('needs a base URL'),
		});
		await expect(transcribeAudio('project-id', 'aGk=', override)).rejects.toThrow('needs a base URL');
		expect(testState.transcribeCalls).toHaveLength(0);
	});

	it('does not auto-pick a provider that needs a base URL it does not have', async () => {
		writeConfig(['llm:', '  providers:', '  - provider: openai-compatible/my-stt', '    api_key: sk-test']);

		await withTranscriptionCatalog(
			'openaiCompatible',
			[{ id: 'whisper-1', name: 'Whisper', default: true }],
			async () => {
				await expect(resolveTranscribeTarget('project-id')).resolves.toMatchObject({
					ok: false,
					provider: null,
					error: expect.stringContaining('No transcription provider configured.'),
				});
			},
		);
	});

	it('uses a saved custom model for openaiCompatible', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-test';
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:8788/v1';
		testState.agentSettings = { transcribe: { provider: 'openaiCompatible', modelId: 'custom-whisper' } };

		const available = await listAvailableTranscribeModels('project-id');
		await transcribeAudio('project-id', 'aGk=');

		expect(available.openaiCompatible).toEqual({ models: [], hasCredentials: true });
		expect(testState.transcribeCalls.at(-1)?.model?.modelId).toBe('custom-whisper');
	});
});

function writeConfig(lines: string[]): void {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nao-transcribe-'));
	directories.push(directory);
	fs.writeFileSync(path.join(directory, 'nao_config.yaml'), lines.join('\n'));
	testState.projectPath = directory;
}

async function withTranscriptionCatalog(
	kind: 'openaiCompatible',
	models: TranscribeModelDef[],
	run: () => Promise<void>,
): Promise<void> {
	const transcription = PROVIDER_META[kind].transcription;
	if (!transcription) {
		throw new Error(`${kind} does not support transcription`);
	}
	const original = transcription.models;
	transcription.models = models;
	try {
		await run();
	} finally {
		transcription.models = original;
	}
}
