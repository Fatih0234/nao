import { createOpenAI } from '@ai-sdk/openai';
import type { LlmProvider } from '@nao/shared/types';
import { providerKind, providerLabel } from '@nao/shared/types';
import type { TranscriptionModel } from 'ai';

import type { ProviderSettings, TranscribeModelDef } from '../types/llm';
import { getProviderMeta, OPENAI_COMPATIBLE_BASE_URLS, supportsTranscription } from './provider-meta';

export { supportsTranscription };

export function getTranscribeModels(provider: LlmProvider): readonly TranscribeModelDef[] {
	return getProviderMeta(provider).transcription?.models ?? [];
}

export function getDefaultTranscribeModelId(provider: LlmProvider): string {
	const models = getTranscribeModels(provider);
	return models.find((m) => m.default)?.id ?? models[0]?.id ?? '';
}

/** The rule behind `createTranscribeModel`'s precondition, shared with the resolver so they cannot disagree. */
export function getMissingBaseUrlError(provider: LlmProvider, settings: ProviderSettings): string | null {
	if (resolveBaseUrl(provider, settings) || !getProviderMeta(provider).requiresBaseUrl) {
		return null;
	}
	return `${providerLabel(provider)} needs a base URL: set one on the provider before using it`;
}

/**
 * Every transcription-capable provider speaks the OpenAI audio API, so a single creator
 * covers them all; only the base URL differs. `createOpenAI` rejects an empty key, so
 * endpoints that need no auth (a local Whisper server) get a placeholder.
 */
export function createTranscribeModel(
	provider: LlmProvider,
	settings: ProviderSettings,
	modelId: string,
): TranscriptionModel {
	const missingBaseUrlError = getMissingBaseUrlError(provider, settings);
	if (missingBaseUrlError) {
		throw new Error(missingBaseUrlError);
	}
	const baseURL = resolveBaseUrl(provider, settings);
	return createOpenAI({ apiKey: settings.apiKey || 'nao', ...(baseURL && { baseURL }) }).transcription(modelId);
}

function resolveBaseUrl(provider: LlmProvider, settings: ProviderSettings): string | undefined {
	return (
		settings.baseURL ??
		OPENAI_COMPATIBLE_BASE_URLS[providerKind(provider)] ??
		getProviderMeta(provider).defaultBaseUrl
	);
}
