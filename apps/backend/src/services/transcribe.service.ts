import { isLlmProvider, type LlmProvider, providerLabel, providerName } from '@nao/shared/types';
import { experimental_transcribe as transcribe } from 'ai';

import { PROVIDER_META } from '../agents/provider-meta';
import {
	createTranscribeModel,
	getDefaultTranscribeModelId,
	getTranscribeModels,
	supportsTranscription,
} from '../agents/transcribe.providers';
import * as projectQueries from '../queries/project.queries';
import type { TranscribeModelDef } from '../types/llm';
import { getProjectModelSources, isProviderDisabled, resolveProviderSettings } from '../utils/llm';

export async function transcribeAudio(
	projectId: string,
	audio: string,
	overrides?: { provider?: LlmProvider; modelId?: string },
): Promise<string> {
	const agentSettings = await projectQueries.getAgentSettings(projectId);
	const transcribeSettings = agentSettings?.transcribe;

	const candidate = overrides?.provider ?? transcribeSettings?.provider;
	const provider = await resolveTranscribeProvider(projectId, candidate);
	const modelId =
		overrides?.modelId ??
		(provider === candidate ? transcribeSettings?.modelId : undefined) ??
		getDefaultTranscribeModelId(provider);
	if (!modelId) {
		throw new Error(`Select a transcription model for ${providerLabel(provider)} in Settings > Transcription.`);
	}

	const settings = await resolveProviderSettings(projectId, provider);
	if (!settings) {
		throw new Error(`No API key configured for ${providerLabel(provider)}. Add one in Settings > Models.`);
	}

	const model = createTranscribeModel(provider, settings, modelId);
	const audioBuffer = Buffer.from(audio, 'base64');

	const result = await transcribe({ model, audio: audioBuffer });
	return result.text;
}

/**
 * Provider used for transcription when the saved one is missing or cannot transcribe.
 * A usable saved/override provider always wins; otherwise the first source with
 * credentials — same order the settings dropdown lists them — so the backend picks
 * what the UI shows. 'openai' is the last resort for the sake of its error message.
 */
async function resolveTranscribeProvider(projectId: string, candidate: string | undefined): Promise<LlmProvider> {
	if (candidate && isLlmProvider(candidate) && supportsTranscription(candidate)) {
		if (isProviderDisabled(candidate)) {
			throw new Error(`${providerLabel(candidate)} is disabled via DISABLED_PROVIDERS.`);
		}
		return candidate;
	}

	for (const [kind, meta] of Object.entries(PROVIDER_META)) {
		if (!meta.transcription || isProviderDisabled(kind as LlmProvider)) {
			continue;
		}
		if (await resolveProviderSettings(projectId, kind as LlmProvider)) {
			return kind as LlmProvider;
		}
	}

	const sources = await getProjectModelSources(projectId);
	for (const { provider } of sources) {
		if (!providerName(provider) || !supportsTranscription(provider)) {
			continue;
		}
		if (await resolveProviderSettings(projectId, provider)) {
			return provider;
		}
	}

	return 'openai';
}

/**
 * Transcription models of every configured provider whose kind speaks the audio API. Bare kinds
 * are always listed (so the settings hint can name them); named instances only appear when
 * configured, since they exist only through DB or nao_config.yaml declarations.
 */
export async function listAvailableTranscribeModels(projectId: string) {
	const available: Record<string, { models: readonly TranscribeModelDef[]; hasKey: boolean }> = {};

	for (const [kind, meta] of Object.entries(PROVIDER_META)) {
		if (!meta.transcription || isProviderDisabled(kind as LlmProvider)) {
			continue;
		}
		available[kind] = {
			models: meta.transcription.models,
			hasKey: (await resolveProviderSettings(projectId, kind as LlmProvider)) !== null,
		};
	}

	const sources = await getProjectModelSources(projectId);
	for (const { provider } of sources) {
		if (!providerName(provider) || !supportsTranscription(provider)) {
			continue;
		}
		available[provider] = {
			models: getTranscribeModels(provider),
			hasKey: (await resolveProviderSettings(projectId, provider)) !== null,
		};
	}

	return available;
}
