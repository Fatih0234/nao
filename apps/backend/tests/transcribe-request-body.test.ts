import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
	projectPath: '',
	agentSettings: null as { transcribe?: Record<string, unknown> } | null,
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
	getProjectLlmConfigs: vi.fn(async () => []),
	getProjectLlmConfigByProvider: vi.fn(async () => null),
}));

vi.mock('../src/utils/logger', () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { __reloadEnvForTesting } from '../src/env';
import { transcribeAudio } from '../src/services/transcribe.service';

type CapturedRequest = { contentType: string; body: string };

const capturedRequests: CapturedRequest[] = [];
const directories: string[] = [];
const server = http.createServer(async (request, response) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	capturedRequests.push({
		contentType: request.headers['content-type'] ?? '',
		body: Buffer.concat(chunks).toString('utf8'),
	});
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(JSON.stringify({ text: 'recognized words', language: 'english', segments: [] }));
});

let baseUrl = '';

const providers = [
	{ provider: 'openai', modelId: 'gpt-4o-mini-transcribe', responseFormat: 'json' },
	{ provider: 'groq', modelId: 'whisper-large-v3', responseFormat: 'verbose_json' },
	{ provider: 'openrouter', modelId: 'whisper-1', responseFormat: 'verbose_json' },
	{ provider: 'openaiCompatible/test-whisper', modelId: 'whisper-1', responseFormat: 'verbose_json' },
] as const;

beforeAll(async () => {
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Could not start transcription test server');
	}
	baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

beforeEach(() => {
	capturedRequests.length = 0;
	testState.projectPath = '';
	testState.agentSettings = null;
	for (const name of [
		'OPENAI_API_KEY',
		'OPENAI_BASE_URL',
		'GROQ_API_KEY',
		'GROQ_BASE_URL',
		'OPENROUTER_API_KEY',
		'OPENROUTER_BASE_URL',
		'OPENAI_COMPATIBLE_API_KEY',
		'OPENAI_COMPATIBLE_BASE_URL',
		'DISABLED_PROVIDERS',
	]) {
		delete process.env[name];
	}
	process.env.OPENAI_API_KEY = 'test-openai-key';
	process.env.OPENAI_BASE_URL = baseUrl;
	process.env.GROQ_API_KEY = 'test-groq-key';
	process.env.GROQ_BASE_URL = baseUrl;
	process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
	process.env.OPENROUTER_BASE_URL = baseUrl;
	process.env.OPENAI_COMPATIBLE_API_KEY = 'test-compatible-key';
	process.env.OPENAI_COMPATIBLE_BASE_URL = baseUrl;
	__reloadEnvForTesting();
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	for (const directory of directories) {
		fs.rmSync(directory, { force: true, recursive: true });
	}
});

describe('transcription request body', () => {
	it('sends saved language, prompt, and temperature through each provider', async () => {
		for (const { provider, modelId } of providers) {
			configureNamedProvider(provider);
			testState.agentSettings = {
				transcribe: { provider, modelId, language: 'fr', prompt: 'Preserve brand names.', temperature: 0.35 },
			};

			const before = capturedRequests.length;
			const result = await transcribeAudio('project-id', 'aGk=');

			expect(result.text).toBe('recognized words');
			const request = capturedRequests[before];
			expect(request).toBeDefined();
			expect(formField(request!, 'language')).toBe('fr');
			expect(formField(request!, 'prompt')).toBe('Preserve brand names.');
			expect(formField(request!, 'temperature')).toBe('0.35');
		}
	});

	it('omits language and prompt and keeps the default temperature when saved options are unset', async () => {
		for (const { provider, modelId } of providers) {
			configureNamedProvider(provider);
			testState.agentSettings = { transcribe: { provider, modelId } };

			const before = capturedRequests.length;
			await transcribeAudio('project-id', 'aGk=');

			const request = capturedRequests[before];
			expect(request).toBeDefined();
			expect(formField(request!, 'language')).toBeUndefined();
			expect(formField(request!, 'prompt')).toBeUndefined();
			expect([undefined, '0']).toContain(formField(request!, 'temperature'));
		}
	});

	it('requests the response format that carries the language when no advanced settings are saved', async () => {
		for (const { provider, modelId, responseFormat } of providers) {
			configureNamedProvider(provider);
			testState.agentSettings = { transcribe: { provider, modelId } };

			const before = capturedRequests.length;
			await transcribeAudio('project-id', 'aGk=');

			const request = capturedRequests[before];
			expect(request).toBeDefined();
			expect(formField(request!, 'response_format')).toBe(responseFormat);
		}
	});

	it('uses saved options for an explicit provider override and sends temperature zero', async () => {
		testState.agentSettings = {
			transcribe: { provider: 'groq', language: 'en', prompt: 'Use saved guidance.', temperature: 0 },
		};

		await transcribeAudio('project-id', 'aGk=', { provider: 'openai', modelId: 'gpt-4o-mini-transcribe' });

		const request = capturedRequests[0];
		expect(request).toBeDefined();
		expect(formField(request!, 'language')).toBe('en');
		expect(formField(request!, 'prompt')).toBe('Use saved guidance.');
		expect(formField(request!, 'temperature')).toBe('0');
	});
});

function configureNamedProvider(provider: string): void {
	if (!provider.startsWith('openaiCompatible/')) {
		testState.projectPath = '';
		return;
	}

	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nao-transcribe-request-'));
	directories.push(directory);
	testState.projectPath = directory;
	fs.writeFileSync(
		path.join(directory, 'nao_config.yaml'),
		[
			'llm:',
			'  providers:',
			'  - provider: openai-compatible/test-whisper',
			'    api_key: test-named-key',
			`    base_url: ${baseUrl}`,
		].join('\n'),
	);
}

function formField(request: CapturedRequest, name: string): string | undefined {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return request.body.match(
		new RegExp(`Content-Disposition: form-data; name="${escapedName}"\\r\\n\\r\\n([^\\r]*)`),
	)?.[1];
}
