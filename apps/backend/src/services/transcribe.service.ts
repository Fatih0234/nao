import { isLlmProvider, type LlmProvider, providerLabel, providerName } from '@nao/shared/types';
import { experimental_transcribe as transcribe } from 'ai';

import { getProviderMeta, PROVIDER_META } from '../agents/provider-meta';
import {
	createTranscribeModel,
	getDefaultTranscribeModelId,
	getMissingBaseUrlError,
	getTranscribeModels,
	supportsTranscription,
} from '../agents/transcribe.providers';
import * as projectQueries from '../queries/project.queries';
import type { AgentSettings } from '../types/agent-settings';
import type { ProviderSettings, TranscribeModelDef } from '../types/llm';
import { getProjectModelSources, isProviderDisabled, resolveProviderSettings } from '../utils/llm';

type TranscribeOverrides = { provider?: LlmProvider; modelId?: string };
type TranscriptionSettings = Pick<NonNullable<AgentSettings['transcribe']>, 'language' | 'prompt' | 'temperature'>;

export type TranscribeTarget =
	| { ok: true; provider: LlmProvider; modelId: string; settings: ProviderSettings }
	| { ok: false; provider: LlmProvider | null; error: string };

export async function transcribeAudio(
	projectId: string,
	audio: string,
	overrides?: TranscribeOverrides,
): Promise<{ text: string; language: string | undefined }> {
	const { target, transcribeSettings } = await resolveTranscribeTargetWithSettings(projectId, overrides);
	if (!target.ok) {
		throw new Error(target.error);
	}

	const model = createTranscribeModel(target.provider, target.settings, target.modelId);
	const audioBuffer = Buffer.from(audio, 'base64');
	const providerOptions = buildTranscribeProviderOptions(transcribeSettings);

	const result = await transcribe({ model, audio: audioBuffer, providerOptions });
	const rawLanguage = (result.responses[0] as { body?: { language?: unknown } } | undefined)?.body?.language;
	return {
		text: result.text,
		language:
			typeof result.language === 'string'
				? result.language
				: typeof rawLanguage === 'string'
					? rawLanguage
					: undefined,
	};
}

/** The openai key is always present: the SDK only requests verbose_json, which carries the language, when it is. */
function buildTranscribeProviderOptions(settings: TranscriptionSettings | undefined) {
	return {
		openai: {
			...(settings?.language && { language: settings.language }),
			...(settings?.prompt && { prompt: settings.prompt }),
			...(settings?.temperature != null && { temperature: settings.temperature }),
		},
	};
}

/** Resolve the provider and model used by transcription, or return the actionable reason it cannot run. */
export async function resolveTranscribeTarget(
	projectId: string,
	overrides?: TranscribeOverrides,
): Promise<TranscribeTarget> {
	return (await resolveTranscribeTargetWithSettings(projectId, overrides)).target;
}

async function resolveTranscribeTargetWithSettings(
	projectId: string,
	overrides?: TranscribeOverrides,
): Promise<{ target: TranscribeTarget; transcribeSettings: TranscriptionSettings | undefined }> {
	const agentSettings = await projectQueries.getAgentSettings(projectId);
	const transcribeSettings = agentSettings?.transcribe;
	const transcriptionSettings = transcribeSettings
		? {
				language: transcribeSettings.language,
				prompt: transcribeSettings.prompt,
				temperature: transcribeSettings.temperature,
			}
		: undefined;

	if (overrides?.provider) {
		return {
			target: await resolveExplicitTarget(projectId, overrides.provider, overrides.modelId),
			transcribeSettings: transcriptionSettings,
		};
	}

	if (transcribeSettings?.provider) {
		return {
			target: await resolveSavedTarget(projectId, transcribeSettings.provider, transcribeSettings.modelId),
			transcribeSettings: transcriptionSettings,
		};
	}

	return {
		target: await resolveAutomaticTarget(projectId),
		transcribeSettings: transcriptionSettings,
	};
}

async function resolveExplicitTarget(
	projectId: string,
	provider: LlmProvider,
	overrideModelId?: string,
): Promise<TranscribeTarget> {
	if (isProviderDisabled(provider)) {
		return {
			ok: false,
			provider,
			error: `${providerLabel(provider)} is disabled via DISABLED_PROVIDERS. Enable it or choose another transcription provider in Settings > Transcription.`,
		};
	}

	const resolution = await resolveRunnableSettings(projectId, provider);
	if ('error' in resolution) {
		return { ok: false, provider, error: resolution.error };
	}

	const modelId = overrideModelId ?? getDefaultTranscribeModelId(provider);
	if (!modelId) {
		return { ok: false, provider, error: noModelMessage(provider) };
	}

	return { ok: true, provider, modelId, settings: resolution.settings };
}

async function resolveSavedTarget(
	projectId: string,
	savedProvider: string,
	savedModelId: string | undefined,
): Promise<TranscribeTarget> {
	const provider = isLlmProvider(savedProvider) ? savedProvider : null;
	if (!provider || !supportsTranscription(provider)) {
		const name = provider ? providerLabel(provider) : savedProvider;
		return {
			ok: false,
			provider,
			error: `${name} is not a transcription-capable provider. Choose a transcription provider in Settings > Transcription.`,
		};
	}

	if (isProviderDisabled(provider)) {
		return {
			ok: false,
			provider,
			error: `${providerLabel(provider)} is disabled via DISABLED_PROVIDERS. Enable it or choose another transcription provider in Settings > Transcription.`,
		};
	}

	if (providerName(provider)) {
		const sources = await getProjectModelSources(projectId);
		if (!sources.some((source) => source.provider === provider)) {
			return {
				ok: false,
				provider,
				error: `${providerLabel(provider)} is no longer configured. Re-add it in Settings > Models or choose another transcription provider in Settings > Transcription.`,
			};
		}
	}

	const resolution = await resolveRunnableSettings(projectId, provider);
	if ('error' in resolution) {
		return { ok: false, provider, error: resolution.error };
	}

	const modelId = savedModelId ?? getDefaultTranscribeModelId(provider);
	if (!modelId) {
		return { ok: false, provider, error: noModelMessage(provider) };
	}

	return { ok: true, provider, modelId, settings: resolution.settings };
}

async function resolveAutomaticTarget(projectId: string): Promise<TranscribeTarget> {
	for (const provider of await getTranscribeProviders(projectId)) {
		if (isProviderDisabled(provider)) {
			continue;
		}

		const modelId = getDefaultTranscribeModelId(provider);
		if (!modelId) {
			continue;
		}

		const resolution = await resolveRunnableSettings(projectId, provider);
		if ('settings' in resolution) {
			return { ok: true, provider, modelId, settings: resolution.settings };
		}
	}

	return {
		ok: false,
		provider: null,
		error: 'No transcription provider configured. Add an API key for a transcription-capable provider in Settings > Models.',
	};
}

function noCredentialsMessage(provider: LlmProvider): string {
	return `No API key configured for ${providerLabel(provider)}. Add one in Settings > Models.`;
}

function noModelMessage(provider: LlmProvider): string {
	return `Select a transcription model for ${providerLabel(provider)} in Settings > Transcription.`;
}

/** Transcription-capable kinds first, followed by configured named instances in project source order. */
async function getTranscribeProviders(projectId: string): Promise<LlmProvider[]> {
	const kinds = Object.entries(PROVIDER_META)
		.filter(([, meta]) => meta.transcription)
		.map(([kind]) => kind as LlmProvider);
	const sources = await getProjectModelSources(projectId);
	const namedProviders = sources
		.map(({ provider }) => provider)
		.filter((provider) => providerName(provider) !== null && supportsTranscription(provider));
	return [...new Set([...kinds, ...namedProviders])];
}

/**
 * Settings are usable when a key exists, or when the provider does not require one
 * (a local OpenAI-compatible endpoint). An empty key on a required provider means
 * a saved config lost its credential, which should not count as configured.
 */
async function resolveUsableSettings(projectId: string, provider: LlmProvider): Promise<ProviderSettings | null> {
	const settings = await resolveProviderSettings(projectId, provider);
	if (!settings) {
		return null;
	}
	if (getProviderMeta(provider).auth.apiKey === 'required' && !settings.apiKey) {
		return null;
	}
	return settings;
}

type RunnableSettings = { settings: ProviderSettings } | { error: string };

/** Usable settings that `createTranscribeModel` will also accept, or the reason they are not. */
async function resolveRunnableSettings(projectId: string, provider: LlmProvider): Promise<RunnableSettings> {
	const settings = await resolveUsableSettings(projectId, provider);
	if (!settings) {
		return { error: noCredentialsMessage(provider) };
	}

	const baseUrlError = getMissingBaseUrlError(provider, settings);
	return baseUrlError ? { error: baseUrlError } : { settings };
}

/** Lists transcription-capable providers; `hasCredentials` tells whether one can be selected. */
export async function listAvailableTranscribeModels(projectId: string) {
	const available: Record<string, { models: readonly TranscribeModelDef[]; hasCredentials: boolean }> = {};

	for (const provider of await getTranscribeProviders(projectId)) {
		if (isProviderDisabled(provider)) {
			continue;
		}

		const settings = await resolveUsableSettings(projectId, provider);
		available[provider] = { models: getTranscribeModels(provider), hasCredentials: settings !== null };
	}

	return available;
}
