import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
	target: {
		ok: true as boolean,
		provider: 'groq' as string | null,
		modelId: 'whisper-large-v3' as string | null,
		settings: { apiKey: 'secret-key' },
		error: 'Groq is disabled',
	},
}));

vi.mock('../src/queries/project.queries', () => ({
	getProjectByUserId: vi.fn(async () => ({
		id: 'project-id',
		name: 'Test project',
		path: '/tmp/test-project',
		envVars: {},
	})),
	getUserRoleInProject: vi.fn(async () => 'admin'),
}));

vi.mock('../src/services/transcribe.service', () => ({
	resolveTranscribeTarget: vi.fn(async () => testState.target),
	listAvailableTranscribeModels: vi.fn(),
	transcribeAudio: vi.fn(),
}));

import { transcribeRoutes } from '../src/trpc/transcribe.routes';
import { router } from '../src/trpc/trpc';

const testRouter = router(transcribeRoutes);

describe('transcribe.getTarget', () => {
	beforeEach(() => {
		testState.target = {
			ok: true,
			provider: 'groq',
			modelId: 'whisper-large-v3',
			settings: { apiKey: 'secret-key' },
			error: 'Groq is disabled',
		};
	});

	it('returns the target without provider credentials', async () => {
		await expect(caller().getTarget()).resolves.toEqual({
			provider: 'groq',
			modelId: 'whisper-large-v3',
			error: null,
		});
	});

	it('returns the saved provider and its actionable error when resolution fails', async () => {
		testState.target = {
			ok: false,
			provider: 'groq',
			modelId: null,
			settings: { apiKey: 'secret-key' },
			error: 'Groq is disabled via DISABLED_PROVIDERS.',
		};

		await expect(caller().getTarget()).resolves.toEqual({
			provider: 'groq',
			modelId: null,
			error: 'Groq is disabled via DISABLED_PROVIDERS.',
		});
	});
});

function caller() {
	return testRouter.createCaller({
		session: { user: { id: 'user-id', email: 'user@test.dev' } },
		selectedProjectId: 'project-id',
	} as never);
}
