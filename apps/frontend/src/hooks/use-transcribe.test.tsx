// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTranscribe } from './use-transcribe';

const mocks = vi.hoisted(() => ({
	mutate: vi.fn(),
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
	trpcClient: {
		transcribe: { transcribe: { mutate: mocks.mutate } },
	},
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

class MockAudioContext {
	createMediaStreamSource = () => ({ connect: vi.fn() });
	createAnalyser = () => ({ fftSize: 0, smoothingTimeConstant: 0 });
	close = vi.fn();
}

beforeEach(() => {
	mocks.mutate.mockReset();
	mocks.recorders.length = 0;
	vi.stubGlobal('MediaRecorder', MockMediaRecorder);
	vi.stubGlobal('FileReader', MockFileReader);
	vi.stubGlobal('AudioContext', MockAudioContext);
	Object.defineProperty(navigator, 'mediaDevices', {
		value: {
			getUserMedia: vi.fn(async () => ({
				getTracks: () => [{ stop: vi.fn() }],
			})),
		},
		configurable: true,
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('useTranscribe', () => {
	it('exposes the transcription failure message as error', async () => {
		mocks.mutate.mockRejectedValue(new Error('No API key configured for OpenAI. Add one in Settings > Models.'));

		const { result } = renderHook(() => useTranscribe({ onTranscribed: vi.fn() }));

		expect(result.current.error).toBeNull();

		await act(async () => {
			await result.current.toggle();
		});
		expect(result.current.isRecording).toBe(true);
		expect(result.current.error).toBeNull();

		await act(async () => {
			result.current.toggle();
			// Allow the async onstop (FileReader + mutate) to settle.
			await new Promise((resolve) => setTimeout(resolve, 20));
		});

		await waitFor(() => {
			expect(result.current.error).toBe('No API key configured for OpenAI. Add one in Settings > Models.');
		});

		// Dismissing clears the message.
		act(() => {
			result.current.clearError();
		});
		expect(result.current.error).toBeNull();
	});

	it('resets the error when a new recording starts', async () => {
		mocks.mutate.mockRejectedValueOnce(new Error('No API key configured for OpenAI.'));
		mocks.mutate.mockResolvedValue('hello');

		const onTranscribed = vi.fn();
		const { result } = renderHook(() => useTranscribe({ onTranscribed }));

		await act(async () => {
			await result.current.toggle();
		});
		await act(async () => {
			result.current.toggle();
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		await waitFor(() => expect(result.current.error).toBe('No API key configured for OpenAI.'));

		await act(async () => {
			await result.current.toggle();
		});
		expect(result.current.error).toBeNull();
	});

	it('sets an error when getUserMedia rejects', async () => {
		vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new Error('Permission denied'));

		const { result } = renderHook(() => useTranscribe({ onTranscribed: vi.fn() }));

		expect(result.current.error).toBeNull();

		await act(async () => {
			await result.current.toggle();
		});

		await waitFor(() => {
			expect(result.current.error).toBe('Permission denied');
		});
		expect(result.current.isRecording).toBe(false);
	});
});
