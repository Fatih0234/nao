// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsTranscribe } from './settings-transcribe';

const mocks = vi.hoisted(() => ({
	agentSettings: null as unknown,
	knownModels: null as unknown,
	target: null as unknown,
	pending: { agentSettings: false, knownModels: false, target: false },
	mutate: vi.fn(),
	transcribeMutate: vi.fn(),
	recorders: [] as Array<{
		ondataavailable: ((e: { data: Blob }) => void) | null;
		onstop: (() => void | Promise<void>) | null;
		state: string;
		mimeType: string;
		start: () => void;
		stop: () => void;
	}>,
}));

vi.mock('@/main', () => ({
	trpc: {
		project: {
			getAgentSettings: { queryOptions: () => ({ queryKey: ['getAgentSettings'] }) },
			getKnownTranscribeModels: { queryOptions: () => ({ queryKey: ['getKnownTranscribeModels'] }) },
			updateAgentSettings: {
				mutationOptions: (options: object) => ({ ...options, mutationKey: ['updateAgentSettings'] }),
			},
		},
		transcribe: {
			getTarget: { queryOptions: () => ({ queryKey: ['getTarget'] }) },
		},
	},
	trpcClient: {
		transcribe: { transcribe: { mutate: mocks.transcribeMutate } },
	},
}));

vi.mock('@tanstack/react-query', () => ({
	useQuery: (options: { queryKey: string[] }) => {
		if (options.queryKey[0] === 'getAgentSettings') {
			return { data: mocks.agentSettings, isPending: mocks.pending.agentSettings };
		}
		if (options.queryKey[0] === 'getKnownTranscribeModels') {
			return { data: mocks.knownModels, isPending: mocks.pending.knownModels };
		}
		if (options.queryKey[0] === 'getTarget') {
			return { data: mocks.target, isPending: mocks.pending.target };
		}
		return { data: undefined, isPending: false };
	},
	useMutation: () => ({ isPending: false, mutate: mocks.mutate, error: null }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

class MockMediaRecorder {
	static isTypeSupported = () => true;
	state = 'inactive';
	mimeType = 'audio/webm';
	ondataavailable: ((e: { data: Blob }) => void) | null = null;
	onstop: (() => void | Promise<void>) | null = null;

	constructor(
		public stream: unknown,
		public options: unknown,
	) {
		mocks.recorders.push(this as unknown as (typeof mocks.recorders)[number]);
	}

	start() {
		this.state = 'recording';
	}

	stop() {
		this.state = 'inactive';
		this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
		void this.onstop?.();
	}
}

class MockFileReader {
	result: string | null = null;
	onloadend: (() => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;

	readAsDataURL(_blob: Blob) {
		this.result = 'data:audio/webm;base64,aGk=';
		setTimeout(() => this.onloadend?.(), 0);
	}
}

function baseSetup() {
	mocks.agentSettings = {
		transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3' },
	};
	mocks.knownModels = {
		groq: {
			models: [{ id: 'whisper-large-v3', name: 'Whisper Large V3', default: true }],
			hasCredentials: true,
		},
	};
	mocks.target = { provider: 'groq', modelId: 'whisper-large-v3', error: null };
}

const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

beforeEach(() => {
	mocks.mutate.mockReset();
	mocks.transcribeMutate.mockReset();
	mocks.recorders.length = 0;
	mocks.pending = { agentSettings: false, knownModels: false, target: false };
	baseSetup();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	if (originalMediaDevicesDescriptor) {
		Object.defineProperty(navigator, 'mediaDevices', originalMediaDevicesDescriptor);
	} else {
		Reflect.deleteProperty(navigator, 'mediaDevices');
	}
});

function openAdvanced() {
	const toggle = screen.getByRole('button', { name: /advanced settings/i });
	if (!screen.queryByPlaceholderText('e.g. en, tr, de')) {
		fireEvent.click(toggle);
	}
}

describe('SettingsTranscribe advanced settings', () => {
	it('auto-opens when language is saved', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', language: 'en' },
		};
		render(<SettingsTranscribe isAdmin />);

		expect(screen.getByPlaceholderText('e.g. en, tr, de')).toBeTruthy();
	});

	it('auto-opens when prompt is saved', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', prompt: 'hello' },
		};
		render(<SettingsTranscribe isAdmin />);

		expect(screen.getByPlaceholderText('e.g. revenue, jaffle_shop, dbt, stripe_invoice_id')).toBeTruthy();
	});

	it('auto-opens when temperature is saved', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', temperature: 0.5 },
		};
		render(<SettingsTranscribe isAdmin />);

		expect(screen.getByPlaceholderText('e.g. en, tr, de')).toBeTruthy();
	});

	it('stays closed when nothing is saved until toggled', () => {
		render(<SettingsTranscribe isAdmin />);

		expect(screen.queryByPlaceholderText('e.g. en, tr, de')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));
		expect(screen.getByPlaceholderText('e.g. en, tr, de')).toBeTruthy();
	});

	it('stays closed when saved values arrive after the user collapses advanced settings', () => {
		const { rerender } = render(<SettingsTranscribe isAdmin />);
		const toggle = screen.getByRole('button', { name: /advanced settings/i });
		fireEvent.click(toggle);

		const languageInput = screen.getByPlaceholderText('e.g. en, tr, de');
		fireEvent.change(languageInput, { target: { value: 'en' } });
		fireEvent.blur(languageInput);
		fireEvent.click(toggle);
		expect(screen.queryByPlaceholderText('e.g. en, tr, de')).toBeNull();

		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', language: 'en' },
		};
		rerender(<SettingsTranscribe isAdmin />);

		expect(screen.queryByPlaceholderText('e.g. en, tr, de')).toBeNull();
	});

	it('saves language with only that key on blur', () => {
		render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		const input = screen.getByPlaceholderText('e.g. en, tr, de');
		fireEvent.change(input, { target: { value: 'de' } });
		fireEvent.blur(input);

		expect(mocks.mutate).toHaveBeenCalledTimes(1);
		expect(mocks.mutate).toHaveBeenCalledWith({ transcribe: { language: 'de' } });
	});

	it('saves language on Enter', () => {
		render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		const input = screen.getByPlaceholderText('e.g. en, tr, de');
		fireEvent.change(input, { target: { value: 'tr' } });
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(mocks.mutate).toHaveBeenCalledWith({ transcribe: { language: 'tr' } });
	});

	it('sends uppercase EN as en', () => {
		render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		const input = screen.getByPlaceholderText('e.g. en, tr, de') as HTMLInputElement;
		fireEvent.change(input, { target: { value: 'EN' } });
		fireEvent.blur(input);

		expect(mocks.mutate).toHaveBeenCalledWith({ transcribe: { language: 'en' } });
	});

	it('sends empty language as empty string to clear', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', language: 'en' },
		};
		render(<SettingsTranscribe isAdmin />);

		const input = screen.getByPlaceholderText('e.g. en, tr, de') as HTMLInputElement;
		expect(input.value).toBe('en');
		fireEvent.change(input, { target: { value: '' } });
		fireEvent.blur(input);

		expect(mocks.mutate).toHaveBeenCalledWith({ transcribe: { language: '' } });
	});

	it('shows an inline error for invalid language and sends nothing', () => {
		render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		const input = screen.getByPlaceholderText('e.g. en, tr, de');
		fireEvent.change(input, { target: { value: 'eng' } });
		fireEvent.blur(input);

		expect(screen.getByRole('alert').textContent).toBe('Enter a two-letter ISO-639-1 code (e.g. en, tr, de).');
		expect(mocks.mutate).not.toHaveBeenCalled();
	});

	it('saves prompt with only that key on blur', () => {
		render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		const input = screen.getByPlaceholderText('e.g. revenue, jaffle_shop, dbt, stripe_invoice_id');
		fireEvent.change(input, { target: { value: 'Keep table names intact.' } });
		fireEvent.blur(input);

		expect(mocks.mutate).toHaveBeenCalledWith({ transcribe: { prompt: 'Keep table names intact.' } });
	});

	it('saves temperature with only that key on blur', () => {
		render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		const input = screen.getByPlaceholderText('Default (0)');
		fireEvent.change(input, { target: { value: '0.5' } });
		fireEvent.blur(input);

		expect(mocks.mutate).toHaveBeenCalledWith({ transcribe: { temperature: 0.5 } });
	});

	it('sends empty temperature as null to clear', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', temperature: 0.5 },
		};
		render(<SettingsTranscribe isAdmin />);

		const input = screen.getByPlaceholderText('Default (0)') as HTMLInputElement;
		expect(input.value).toBe('0.5');
		fireEvent.change(input, { target: { value: '' } });
		fireEvent.blur(input);

		expect(mocks.mutate).toHaveBeenCalledWith({ transcribe: { temperature: null } });
	});

	it('shows an inline error for invalid temperature and sends nothing', () => {
		render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		const input = screen.getByPlaceholderText('Default (0)');
		fireEvent.change(input, { target: { value: '2' } });
		fireEvent.blur(input);

		expect(screen.getByRole('alert')).toBeTruthy();
		expect(mocks.mutate).not.toHaveBeenCalled();
	});

	it('shows an inline error for unparseable temperature and sends nothing', () => {
		render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		const input = screen.getByPlaceholderText('Default (0)') as HTMLInputElement;
		for (const bad of ['-', '1e', '.']) {
			fireEvent.change(input, { target: { value: bad } });
			fireEvent.blur(input);

			expect(screen.getByRole('alert').textContent).toBe('Enter a number between 0 and 1.');
			expect(mocks.mutate).not.toHaveBeenCalled();
		}
	});

	it('does not send a request when the value did not change', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', language: 'en' },
		};
		render(<SettingsTranscribe isAdmin />);

		const input = screen.getByPlaceholderText('e.g. en, tr, de');
		fireEvent.blur(input);

		expect(mocks.mutate).not.toHaveBeenCalled();
	});

	it('stays collapsed after a refetch when the user collapsed it', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', language: 'en' },
		};
		const { rerender } = render(<SettingsTranscribe isAdmin />);

		expect(screen.getByPlaceholderText('e.g. en, tr, de')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));
		expect(screen.queryByPlaceholderText('e.g. en, tr, de')).toBeNull();

		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', language: 'fr' },
		};
		rerender(<SettingsTranscribe isAdmin />);

		expect(screen.queryByPlaceholderText('e.g. en, tr, de')).toBeNull();
	});

	it('picks up new server values for untouched fields', () => {
		const { rerender } = render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		expect((screen.getByPlaceholderText('e.g. en, tr, de') as HTMLInputElement).value).toBe('');

		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', language: 'fr' },
		};
		rerender(<SettingsTranscribe isAdmin />);

		expect((screen.getByPlaceholderText('e.g. en, tr, de') as HTMLInputElement).value).toBe('fr');
	});

	it('shows saved values and follows server changes, but keeps the field being edited', () => {
		const { rerender } = render(<SettingsTranscribe isAdmin />);
		openAdvanced();

		const input = screen.getByPlaceholderText('e.g. en, tr, de') as HTMLInputElement;
		input.focus();
		fireEvent.change(input, { target: { value: 'de' } });

		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', language: 'fr' },
		};
		rerender(<SettingsTranscribe isAdmin />);

		expect((screen.getByPlaceholderText('e.g. en, tr, de') as HTMLInputElement).value).toBe('de');
	});

	it('disables advanced inputs for non-admins', () => {
		mocks.agentSettings = {
			transcribe: { enabled: true, provider: 'groq', modelId: 'whisper-large-v3', language: 'en' },
		};
		render(<SettingsTranscribe isAdmin={false} />);

		const languageInput = screen.getByPlaceholderText('e.g. en, tr, de') as HTMLInputElement;
		const promptInput = screen.getByPlaceholderText(
			'e.g. revenue, jaffle_shop, dbt, stripe_invoice_id',
		) as HTMLTextAreaElement;
		const temperatureInput = screen.getByPlaceholderText('Default (0)') as HTMLInputElement;

		expect(languageInput.disabled).toBe(true);
		expect(promptInput.disabled).toBe(true);
		expect(temperatureInput.disabled).toBe(true);
	});

	it('shows detected language after a successful Test', async () => {
		vi.stubGlobal('MediaRecorder', MockMediaRecorder);
		vi.stubGlobal('FileReader', MockFileReader);
		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				getUserMedia: vi.fn(async () => ({
					getTracks: () => [{ stop: vi.fn() }],
				})),
			},
			configurable: true,
		});
		mocks.transcribeMutate.mockResolvedValue({ text: 'hello world', language: 'en' });

		render(<SettingsTranscribe isAdmin />);

		const testButton = screen.getByRole('button', { name: 'Test' });
		await act(async () => {
			fireEvent.click(testButton);
		});

		expect(mocks.recorders.length).toBe(1);

		await act(async () => {
			mocks.recorders[0].stop();
			await new Promise((resolve) => setTimeout(resolve, 20));
		});

		await waitFor(() => {
			expect(screen.getByText(/Detected language: en/)).toBeTruthy();
		});
	});
});
