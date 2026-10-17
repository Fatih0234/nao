// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MicWarningBanner } from './chat-input';
import type { ReactNode } from 'react';

vi.mock('maplibre-gl', () => ({}));
vi.mock('@/main', () => ({
	trpc: {},
	trpcClient: {},
}));
vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => vi.fn(),
	Link: ({ to, search, children }: { to: string; search?: object; children: ReactNode }) => (
		<a href={to} data-search={JSON.stringify(search)}>
			{children}
		</a>
	),
}));

afterEach(() => {
	cleanup();
});

describe('MicWarningBanner', () => {
	it.each([
		['with a target error', 'No API key configured for OpenAI. Add one in Settings > Models.'],
		['without a target error', undefined],
	])('links to the Agent settings page that has the transcription card %s', (_name, message) => {
		render(<MicWarningBanner onDismiss={vi.fn()} message={message} />);

		const link = screen.getByRole('link', { name: 'Go to Settings > Transcription' });
		expect(link.getAttribute('href')).toBe('/settings/project/agent');
		expect(JSON.parse(link.getAttribute('data-search') ?? '{}')).toEqual({ tab: 'models' });
	});

	it('shows the target error without telling the user to ask an admin', () => {
		const message = 'Groq is disabled via DISABLED_PROVIDERS. Choose another provider in Settings > Transcription.';
		const { container } = render(<MicWarningBanner onDismiss={vi.fn()} message={message} />);

		expect(container.textContent).toContain(message);
		expect(container.textContent).not.toMatch(/ask your admin/i);
	});

	it('does not tell the user to ask an admin when voice input is not configured', () => {
		const { container } = render(<MicWarningBanner onDismiss={vi.fn()} />);

		expect(container.textContent).toContain('Voice input is not configured.');
		expect(container.textContent).not.toMatch(/ask your admin/i);
	});
});
