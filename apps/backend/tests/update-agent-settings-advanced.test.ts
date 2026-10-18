import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSettings } from '../src/types/agent-settings';

const testState = vi.hoisted(() => ({
	agentSettings: null as AgentSettings | null,
	updatedSettings: null as AgentSettings | null,
}));

vi.mock('../src/queries/project.queries', () => ({
	getProjectById: vi.fn(async () => project()),
	getProjectByUserId: vi.fn(async () => project()),
	getUserRoleInProject: vi.fn(async () => 'admin'),
	getAgentSettings: vi.fn(async () => testState.agentSettings),
	updateAgentSettings: vi.fn(async (_projectId: string, settings: AgentSettings) => {
		testState.updatedSettings = settings;
		return settings;
	}),
}));

vi.mock('../src/queries/chat.queries', () => ({}));
vi.mock('../src/queries/project-llm-config.queries', () => ({}));
vi.mock('../src/queries/project-saved-prompt.queries', () => ({}));
vi.mock('../src/queries/project-slack-config.queries', () => ({}));
vi.mock('../src/queries/project-teams-config.queries', () => ({}));
vi.mock('../src/queries/project-telegram-config.queries', () => ({}));
vi.mock('../src/queries/project-whatsapp-config.queries', () => ({}));
vi.mock('../src/queries/project-whatsapp-link.queries', () => ({}));
vi.mock('../src/queries/user.queries', () => ({}));
vi.mock('../src/agents/user-rules', () => ({ getDatabaseObjects: vi.fn() }));
vi.mock('../src/auth', () => ({ getAuth: vi.fn() }));
vi.mock('../src/services/posthog', () => ({
	posthog: { capture: vi.fn() },
	PostHogEvent: { ProjectAgentSettingsUpdated: 'agent_settings_updated' },
}));
vi.mock('../src/services/slack', () => ({ slackService: {} }));
vi.mock('../src/services/transcribe.service', () => ({ listAvailableTranscribeModels: vi.fn() }));
vi.mock('../src/utils/logger', () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { projectRoutes } from '../src/trpc/project.routes';
import { router } from '../src/trpc/trpc';

const testRouter = router(projectRoutes);

describe('project.updateAgentSettings transcription options', () => {
	beforeEach(() => {
		testState.agentSettings = null;
		testState.updatedSettings = null;
	});

	it('rejects invalid language codes without saving', async () => {
		for (const language of ['EN', 'eng', 'en-US']) {
			await expect(caller().updateAgentSettings({ transcribe: { language } })).rejects.toMatchObject({
				code: 'BAD_REQUEST',
				message: expect.stringContaining('Language must be a lowercase ISO-639-1 code or empty'),
			});
			expect(testState.updatedSettings).toBeNull();
		}
	});

	it('rejects prompts over 1000 characters without saving', async () => {
		await expect(caller().updateAgentSettings({ transcribe: { prompt: 'x'.repeat(1001) } })).rejects.toMatchObject({
			code: 'BAD_REQUEST',
			message: expect.stringContaining('expected string to have <=1000 characters'),
		});
		expect(testState.updatedSettings).toBeNull();
	});

	it.each([
		[1.5, 'expected number to be <=1'],
		[-0.1, 'expected number to be >=0'],
	])('rejects temperature %s without saving', async (temperature, message) => {
		await expect(caller().updateAgentSettings({ transcribe: { temperature } })).rejects.toMatchObject({
			code: 'BAD_REQUEST',
			message: expect.stringContaining(message),
		});
		expect(testState.updatedSettings).toBeNull();
	});

	it('trims values before saving and accepts temperature zero', async () => {
		await caller().updateAgentSettings({
			transcribe: { language: ' fr ', prompt: '  Preserve product names.  ', temperature: 0 },
		});

		expect(testState.updatedSettings?.transcribe).toEqual({
			language: 'fr',
			prompt: 'Preserve product names.',
			temperature: 0,
		});
	});

	it('removes language, blank prompt, and null temperature when cleared', async () => {
		testState.agentSettings = { transcribe: { language: 'en', prompt: 'old prompt', temperature: 0.7 } };

		await caller().updateAgentSettings({ transcribe: { language: '', prompt: '   ', temperature: null } });

		expect(testState.updatedSettings?.transcribe).toEqual({});
	});

	it('keeps audio settings across provider changes while dropping the provider model id', async () => {
		testState.agentSettings = {
			transcribe: {
				provider: 'openai',
				modelId: 'gpt-4o-mini-transcribe',
				language: 'en',
				prompt: 'Keep names intact.',
				temperature: 0.4,
			},
		};

		await caller().updateAgentSettings({ transcribe: { provider: 'groq' } });

		expect(testState.updatedSettings?.transcribe).toEqual({
			provider: 'groq',
			language: 'en',
			prompt: 'Keep names intact.',
			temperature: 0.4,
		});
	});
});

function caller() {
	return testRouter.createCaller({
		session: { user: { id: 'user-id', email: 'admin@test.dev' } },
		selectedProjectId: 'project-id',
	} as never);
}

function project() {
	return {
		id: 'project-id',
		name: 'Test project',
		path: '/tmp/test-project',
		envVars: {},
	};
}
