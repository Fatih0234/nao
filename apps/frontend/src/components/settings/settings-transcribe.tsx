import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, Mic, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isLlmProvider, providerLabel } from '@nao/shared/types';
import type { LlmProvider } from '@nao/shared/types';

import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-fields';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsCard } from '@/components/ui/settings-card';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { trpc, trpcClient } from '@/main';

const TEST_DURATION_MS = 5000;
const CUSTOM_MODEL_VALUE = '__custom__';

interface SettingsTranscribeProps {
	isAdmin: boolean;
}

export function SettingsTranscribe({ isAdmin }: SettingsTranscribeProps) {
	const queryClient = useQueryClient();
	const agentSettings = useQuery(trpc.project.getAgentSettings.queryOptions());
	const knownModels = useQuery(trpc.project.getKnownTranscribeModels.queryOptions());
	const transcribeTarget = useQuery(trpc.transcribe.getTarget.queryOptions());

	const updateAgentSettings = useMutation(
		trpc.project.updateAgentSettings.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: trpc.project.getAgentSettings.queryOptions().queryKey,
				});
				queryClient.invalidateQueries({
					queryKey: trpc.project.getKnownTranscribeModels.queryOptions().queryKey,
				});
				queryClient.invalidateQueries({
					queryKey: trpc.transcribe.getTarget.queryOptions().queryKey,
				});
			},
		}),
	);

	const allProviders = Object.entries(knownModels.data ?? {});
	const selectableProviders = allProviders.filter(([, config]) => config.hasCredentials);
	const providerNames = selectableProviders.map(([name]) => name);

	const savedProvider = agentSettings.data?.transcribe?.provider;
	const savedModelId = agentSettings.data?.transcribe?.modelId;
	const targetProvider = transcribeTarget.data?.provider;
	const targetModelId = transcribeTarget.data?.modelId;
	const targetError = transcribeTarget.data?.error;
	const isTargetLoading = transcribeTarget.isPending;
	const isLoading = agentSettings.isPending || knownModels.isPending || isTargetLoading;
	const currentProvider = isTargetLoading
		? (targetProvider ?? savedProvider ?? providerNames[0] ?? '')
		: (targetProvider ?? '');
	const isTargetUnavailable = !isLoading && currentProvider !== '' && !providerNames.includes(currentProvider);
	const hasNoProviders = !isLoading && targetProvider == null && selectableProviders.length === 0;

	const isEnabled = agentSettings.data?.transcribe?.enabled ?? false;
	const providerConfig = knownModels.data?.[currentProvider];
	const providerModels = providerConfig?.models ?? [];
	const currentModelId =
		savedProvider === currentProvider && savedModelId
			? savedModelId
			: (targetModelId ?? providerModels.find((m) => m.default)?.id ?? '');
	const [customMode, setCustomMode] = useState(false);
	const [forceCatalog, setForceCatalog] = useState(false);
	const [modelDraft, setModelDraft] = useState('');
	const isCustomModel =
		!forceCatalog &&
		(customMode ||
			providerModels.length === 0 ||
			(currentModelId !== '' && !providerModels.some((m) => m.id === currentModelId)));
	const testModelId = isCustomModel ? modelDraft.trim() : currentModelId;

	const savedLanguage = agentSettings.data?.transcribe?.language ?? '';
	const savedPrompt = agentSettings.data?.transcribe?.prompt ?? '';
	const savedTemperature: number | null = agentSettings.data?.transcribe?.temperature ?? null;

	const [showAdvanced, setShowAdvanced] = useState(false);
	const [languageDraft, setLanguageDraft] = useState('');
	const [promptDraft, setPromptDraft] = useState('');
	const [temperatureDraft, setTemperatureDraft] = useState('');
	const [languageError, setLanguageError] = useState<string | null>(null);
	const [temperatureError, setTemperatureError] = useState<string | null>(null);
	const languageRef = useRef<HTMLInputElement>(null);
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const temperatureRef = useRef<HTMLInputElement>(null);
	const hasAutoOpenedRef = useRef(false);

	useEffect(() => {
		if (hasAutoOpenedRef.current || !agentSettings.data) {
			return;
		}
		hasAutoOpenedRef.current = true;
		if (savedLanguage || savedPrompt || savedTemperature != null) {
			setShowAdvanced(true);
		}
	}, [agentSettings.data, savedLanguage, savedPrompt, savedTemperature]);

	useEffect(() => {
		if (document.activeElement !== languageRef.current) {
			setLanguageDraft(savedLanguage);
		}
	}, [savedLanguage]);

	useEffect(() => {
		if (document.activeElement !== promptRef.current) {
			setPromptDraft(savedPrompt);
		}
	}, [savedPrompt]);

	useEffect(() => {
		if (document.activeElement !== temperatureRef.current) {
			setTemperatureDraft(savedTemperature != null ? String(savedTemperature) : '');
		}
	}, [savedTemperature]);

	useEffect(() => {
		setCustomMode(false);
		setForceCatalog(false);
		setModelDraft(savedModelId ?? '');
	}, [savedModelId, currentProvider]);

	const commitLanguage = () => {
		const normalized = languageDraft.trim().toLowerCase();
		if (normalized !== '' && !/^[a-z]{2}$/.test(normalized)) {
			setLanguageError('Enter a two-letter ISO-639-1 code (e.g. en, tr, de).');
			return;
		}
		setLanguageError(null);
		if (normalized !== languageDraft) {
			setLanguageDraft(normalized);
		}
		if (normalized === savedLanguage) {
			return;
		}
		updateAgentSettings.mutate({ transcribe: { language: normalized } });
	};

	const commitPrompt = () => {
		const prompt = promptDraft.trim();
		if (prompt !== promptDraft) {
			setPromptDraft(prompt);
		}
		if (prompt === savedPrompt) {
			return;
		}
		updateAgentSettings.mutate({ transcribe: { prompt } });
	};

	const commitTemperature = () => {
		const raw = temperatureDraft.trim();
		if (raw === '') {
			setTemperatureError(null);
			if (savedTemperature == null) {
				return;
			}
			updateAgentSettings.mutate({ transcribe: { temperature: null } });
			return;
		}
		const temperature = Number(raw);
		if (Number.isNaN(temperature) || temperature < 0 || temperature > 1) {
			setTemperatureError('Enter a number between 0 and 1.');
			return;
		}
		setTemperatureError(null);
		const normalized = String(temperature);
		if (normalized !== temperatureDraft) {
			setTemperatureDraft(normalized);
		}
		if (savedTemperature != null && temperature === savedTemperature) {
			return;
		}
		updateAgentSettings.mutate({ transcribe: { temperature } });
	};

	const commitCustomModel = () => {
		const modelId = modelDraft.trim();
		if (!modelId) {
			return;
		}
		updateAgentSettings.mutate({ transcribe: { provider: currentProvider as LlmProvider, modelId } });
	};

	const handleToggle = (enabled: boolean) => {
		updateAgentSettings.mutate({
			transcribe: { enabled },
		});
	};

	const handleProviderChange = (provider: string) => {
		const config = knownModels.data?.[provider];
		const models = config?.models ?? [];
		const defaultModelId = models.find((m) => m.default)?.id ?? models[0]?.id ?? '';
		updateAgentSettings.mutate({
			transcribe: { provider: provider as LlmProvider, modelId: defaultModelId },
		});
	};

	const handleModelChange = (modelId: string) => {
		updateAgentSettings.mutate({
			transcribe: { provider: currentProvider as LlmProvider, modelId },
		});
	};

	const { testState, testResult, countdown, startTest } = useTranscribeTest(currentProvider, testModelId);

	const isMutating = updateAgentSettings.isPending;
	const isTesting = testState !== 'idle';
	const advancedDisabled = !isAdmin || isMutating || isTesting || isTargetUnavailable || !currentProvider;

	return (
		<SettingsCard
			title='Transcription'
			action={<Switch checked={isEnabled} onCheckedChange={handleToggle} disabled={!isAdmin} />}
		>
			{isEnabled && (
				<div className='space-y-4'>
					<p className='text-sm text-muted-foreground'>
						Configure the speech-to-text provider and model used for voice input in the chat.
					</p>

					{hasNoProviders ? (
						<p className='text-sm text-muted-foreground'>
							Transcription compatible provider API key (
							{allProviders.map(([name]) => providerLabel(name as LlmProvider)).join(', ')}) must be
							configured in the <span className='font-medium text-foreground'>LLM Configuration</span>{' '}
							section above.
						</p>
					) : (
						<>
							<div className='grid gap-2'>
								<label className='text-sm font-medium text-foreground'>Provider</label>
								<Select
									value={currentProvider}
									onValueChange={handleProviderChange}
									disabled={
										!isAdmin ||
										isMutating ||
										isTesting ||
										providerNames.length === 0 ||
										(providerNames.length <= 1 && providerNames.includes(currentProvider))
									}
								>
									<SelectTrigger className='w-full'>
										<SelectValue placeholder='Select a provider' />
									</SelectTrigger>
									<SelectContent>
										{providerNames.map((provider) => (
											<SelectItem key={provider} value={provider}>
												{providerLabel(provider as LlmProvider)}
											</SelectItem>
										))}
										{isTargetUnavailable && (
											<SelectItem key={currentProvider} value={currentProvider} disabled>
												{isLlmProvider(currentProvider)
													? `${providerLabel(currentProvider)} (unavailable)`
													: `${currentProvider} (unavailable)`}
											</SelectItem>
										)}
									</SelectContent>
								</Select>
							</div>

							<div className='grid gap-2'>
								<label className='text-sm font-medium text-foreground'>Model</label>
								{isCustomModel ? (
									<div className='flex gap-2'>
										<Input
											value={modelDraft}
											onChange={(e) => setModelDraft(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													commitCustomModel();
												}
											}}
											placeholder='Model ID, e.g. whisper-large-v3'
											disabled={
												!isAdmin ||
												isMutating ||
												isTesting ||
												isTargetUnavailable ||
												!currentProvider
											}
										/>
										<Button
											variant='outline'
											size='sm'
											onClick={commitCustomModel}
											disabled={
												!isAdmin ||
												!modelDraft.trim() ||
												isMutating ||
												isTesting ||
												isTargetUnavailable ||
												!currentProvider
											}
										>
											Save
										</Button>
										{providerModels.length > 0 && (
											<Button
												variant='ghost'
												size='sm'
												onClick={() => {
													setForceCatalog(true);
													setCustomMode(false);
												}}
												disabled={isTargetUnavailable || !currentProvider}
											>
												List
											</Button>
										)}
									</div>
								) : (
									<Select
										value={currentModelId}
										onValueChange={(value) => {
											if (value === CUSTOM_MODEL_VALUE) {
												setCustomMode(true);
												setModelDraft('');
												return;
											}
											handleModelChange(value);
										}}
										disabled={
											!isAdmin ||
											isMutating ||
											isTesting ||
											isTargetUnavailable ||
											!currentProvider
										}
									>
										<SelectTrigger className='w-full'>
											<SelectValue placeholder='Model ID' />
										</SelectTrigger>
										<SelectContent>
											{providerModels.map((model) => (
												<SelectItem key={model.id} value={model.id}>
													{model.name}
													{model.pricePerMinute != null && (
														<span className='text-muted-foreground'>
															${model.pricePerMinute}/min
														</span>
													)}
												</SelectItem>
											))}
											<SelectItem value={CUSTOM_MODEL_VALUE} className='text-muted-foreground'>
												Custom model ID…
											</SelectItem>
										</SelectContent>
									</Select>
								)}
							</div>

							<div>
								<button
									type='button'
									onClick={() => setShowAdvanced(!showAdvanced)}
									className='flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors'
								>
									<ChevronDown
										className={`size-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
									/>
									Advanced settings
								</button>

								{showAdvanced && (
									<div className='mt-3 space-y-4'>
										<div className='grid gap-2'>
											<label className='text-sm font-medium text-foreground'>Language</label>
											<Input
												ref={languageRef}
												value={languageDraft}
												onChange={(e) => {
													setLanguageDraft(e.target.value);
													if (languageError) {
														setLanguageError(null);
													}
												}}
												onBlur={commitLanguage}
												onKeyDown={(e) => {
													if (e.key === 'Enter') {
														e.preventDefault();
														commitLanguage();
													}
												}}
												placeholder='e.g. en, tr, de'
												disabled={advancedDisabled}
											/>
											{languageError && (
												<p role='alert' className='text-xs text-destructive'>
													{languageError}
												</p>
											)}
											<p className='text-xs text-muted-foreground'>
												ISO-639-1 code of the spoken language. Improves accuracy and latency.
												Leave empty for auto-detection. Applies to voice input everywhere,
												including connected messengers.
											</p>
										</div>

										<div className='grid gap-2'>
											<div className='flex items-center justify-between'>
												<label className='text-sm font-medium text-foreground'>Prompt</label>
												<span className='text-xs text-muted-foreground'>
													{promptDraft.length}/1000
												</span>
											</div>
											<Textarea
												ref={promptRef}
												value={promptDraft}
												onChange={(e) => {
													setPromptDraft(e.target.value);
												}}
												onBlur={commitPrompt}
												placeholder='e.g. revenue, jaffle_shop, dbt, stripe_invoice_id'
												rows={2}
												maxLength={1000}
												disabled={advancedDisabled}
											/>
											<p className='text-xs text-muted-foreground'>
												Guides spelling and style; list domain terms like table or metric names
												so they transcribe correctly.
											</p>
										</div>

										<div className='grid gap-2'>
											<label className='text-sm font-medium text-foreground'>Temperature</label>
											<Input
												ref={temperatureRef}
												type='text'
												inputMode='decimal'
												value={temperatureDraft}
												onChange={(e) => {
													setTemperatureDraft(e.target.value);
													if (temperatureError) {
														setTemperatureError(null);
													}
												}}
												onBlur={commitTemperature}
												onKeyDown={(e) => {
													if (e.key === 'Enter') {
														e.preventDefault();
														commitTemperature();
													}
												}}
												placeholder='Default (0)'
												disabled={advancedDisabled}
											/>
											{temperatureError && (
												<p role='alert' className='text-xs text-destructive'>
													{temperatureError}
												</p>
											)}
											<p className='text-xs text-muted-foreground'>
												Sampling temperature from 0 to 1, leave empty for the provider default
												(0). Higher values make transcription more creative on low-confidence
												segments.
											</p>
										</div>

										<p className='text-xs text-muted-foreground'>
											These settings are kept when switching provider.
										</p>
									</div>
								)}
							</div>

							{updateAgentSettings.error && <FormError error={updateAgentSettings.error.message} />}
							{isEnabled && targetError && <FormError error={targetError} />}

							<div className='space-y-2'>
								<div className='flex items-center gap-3'>
									<Button
										variant='outline'
										size='sm'
										onClick={startTest}
										disabled={isTesting || !currentProvider || !testModelId || isTargetUnavailable}
									>
										{testState === 'recording' ? (
											<>
												<Mic className='size-3.5 text-red-500 animate-pulse' />
												Recording… {countdown}s
											</>
										) : testState === 'transcribing' ? (
											<>
												<Loader2 className='size-3.5 animate-spin' />
												Transcribing…
											</>
										) : (
											<>
												<Mic className='size-3.5' />
												Test
											</>
										)}
									</Button>
									{testState === 'idle' && testResult === null && (
										<span className='text-xs text-muted-foreground'>
											Records 5s of audio to verify transcription
										</span>
									)}
								</div>

								{testResult && (
									<div
										className={`rounded-md border px-3 py-2 text-sm ${
											testResult.success
												? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200'
												: 'border-destructive/30 bg-destructive/10 text-destructive'
										}`}
									>
										{testResult.success ? (
											<>
												<p>
													<span className='font-medium'>Transcript: </span>
													{testResult.text || (
														<span className='italic text-muted-foreground'>
															(no speech detected)
														</span>
													)}
												</p>
												{testResult.language && (
													<p className='mt-1 text-xs opacity-75'>
														Detected language: {testResult.language}
													</p>
												)}
											</>
										) : (
											<p className='flex items-center gap-1.5'>
												<X className='size-3.5 shrink-0' />
												{testResult.error}
											</p>
										)}
									</div>
								)}
							</div>
						</>
					)}
				</div>
			)}

			{!isEnabled && (
				<div className='space-y-2'>
					<p className='text-sm text-muted-foreground'>
						Transcription is disabled. Enable it to use voice input in the chat.
					</p>
				</div>
			)}
		</SettingsCard>
	);
}

type TestState = 'idle' | 'recording' | 'transcribing';
type TestResult = { success: true; text: string; language?: string } | { success: false; error: string };

function useTranscribeTest(provider: string, modelId: string) {
	const [testState, setTestState] = useState<TestState>('idle');
	const [testResult, setTestResult] = useState<TestResult | null>(null);
	const [countdown, setCountdown] = useState(0);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const startingRef = useRef(false);
	const disposedRef = useRef(false);
	const chunksRef = useRef<Blob[]>([]);

	useEffect(() => {
		return () => {
			disposedRef.current = true;
			const recorder = mediaRecorderRef.current;
			if (recorder) {
				// Detach handlers so the stop below does not fire an upload after unmount.
				recorder.onstop = null;
				recorder.ondataavailable = null;
				if (recorder.state !== 'inactive') {
					try {
						recorder.stop();
					} catch {
						// already stopped
					}
				}
			}
			streamRef.current?.getTracks().forEach((t) => t.stop());
		};
	}, []);

	useEffect(() => {
		if (testState !== 'recording' || countdown <= 0) {
			return;
		}

		const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
		return () => clearTimeout(timer);
	}, [testState, countdown]);

	useEffect(() => {
		if (testState === 'recording' && countdown === 0) {
			try {
				mediaRecorderRef.current?.stop();
			} catch {
				// already stopped
			}
		}
	}, [testState, countdown]);

	const startTest = useCallback(async () => {
		if (testState !== 'idle' || startingRef.current) {
			return;
		}
		startingRef.current = true;

		setTestResult(null);
		setCountdown(TEST_DURATION_MS / 1000);

		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			startingRef.current = false;
			setTestResult({ success: false, error: 'Microphone access denied' });
			return;
		}
		startingRef.current = false;
		if (disposedRef.current) {
			stream.getTracks().forEach((t) => t.stop());
			return;
		}

		setTestState('recording');
		streamRef.current = stream;
		chunksRef.current = [];

		const mimeType = getSupportedMimeType();
		const recorder = new MediaRecorder(stream, { mimeType });
		mediaRecorderRef.current = recorder;

		recorder.ondataavailable = (e) => {
			if (e.data.size > 0) {
				chunksRef.current.push(e.data);
			}
		};

		recorder.onstop = async () => {
			stream.getTracks().forEach((t) => t.stop());

			const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
			if (blob.size === 0) {
				setTestState('idle');
				setTestResult({ success: false, error: 'No audio captured' });
				return;
			}

			setTestState('transcribing');

			try {
				const base64 = await blobToBase64(blob);
				const { text, language } = await trpcClient.transcribe.transcribe.mutate({
					audio: base64,
					provider: provider as LlmProvider,
					modelId,
				});
				setTestResult({ success: true, text: text?.trim() ?? '', language });
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Transcription failed';
				setTestResult({ success: false, error: message });
			} finally {
				setTestState('idle');
			}
		};

		recorder.start();
	}, [testState, provider, modelId]);

	return { testState, testResult, countdown, startTest };
}

function getSupportedMimeType(): string {
	const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
	return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.split(',')[1]);
		};
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}
