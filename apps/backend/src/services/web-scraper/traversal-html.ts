import type { WebRobotStage } from '@nao/shared/web-robot';
import type { CatalogueAnomaly, TraversalTerminalEvidence } from '@nao/shared/web-robot-trust';
import type { Cheerio } from 'cheerio';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

import { findNextLink } from './extract-dom';
import type { WebRobotLoadedSource } from './types';
import { canonicalHttpUrl } from './url-policy';

export type NextLinkPagination = Extract<NonNullable<WebRobotStage['paginate']>, { type: 'nextLink' }>;

export type HtmlNextTarget = {
	nextUrl?: string;
	terminalEvidence?: TraversalTerminalEvidence;
	anomaly?: CatalogueAnomaly;
};

const PAGINATION_PARAM_PATTERN = /^(page|p|pg|pageno|page_number|pagenumber|offset|cursor|start|from|startindex)$/i;

const terminal = (kind: TraversalTerminalEvidence['kind'], summary: string): TraversalTerminalEvidence => ({
	kind,
	summary,
	details: {},
});

const blocking = (code: string, summary: string): CatalogueAnomaly => ({
	code,
	severity: 'blocking',
	summary,
	evidenceIds: [],
	details: {},
});

export const deriveHtmlNextTarget = (
	loaded: WebRobotLoadedSource,
	pagination: NextLinkPagination,
	initialUrl: string,
): HtmlNextTarget => {
	const html = loaded.bodyText ?? '';
	const control = nextLinkControl(html, pagination);

	if (control) {
		const href = control.attr(pagination.attr);
		if (controlDisabled(control) || !href) {
			return { terminalEvidence: terminal('next_control_disabled', 'The next-page control is disabled.') };
		}
		return validateScopeUrl(href, initialUrl, loaded.finalUrl);
	}

	const href = html ? findNextLink(html, '', pagination.attr, loaded.finalUrl, [], pagination.fingerprint) : null;
	if (!href) {
		return { terminalEvidence: terminal('next_control_absent', 'No next-page control was found.') };
	}
	return validateScopeUrl(href, initialUrl, loaded.finalUrl);
};

export const validateScopeUrl = (href: string, initialUrl: string, baseUrl: string): HtmlNextTarget => {
	let nextUrl: URL;
	let initial: URL;
	try {
		nextUrl = new URL(canonicalHttpUrl(href, baseUrl));
		initial = new URL(canonicalHttpUrl(initialUrl));
	} catch {
		return { anomaly: blocking('out_of_scope_redirect', 'Next-page URL is not a valid URL.') };
	}

	if (nextUrl.hostname !== initial.hostname) {
		return {
			anomaly: blocking(
				'out_of_scope_redirect',
				`Next-page URL host '${nextUrl.hostname}' leaves the scope host '${initial.hostname}'.`,
			),
		};
	}

	for (const [key, value] of initial.searchParams.entries()) {
		if (PAGINATION_PARAM_PATTERN.test(key)) {
			continue;
		}
		if (!nextUrl.searchParams.getAll(key).includes(value)) {
			return {
				anomaly: blocking('filter_lost', `Next-page URL dropped the active filter parameter '${key}'.`),
			};
		}
	}

	return { nextUrl: nextUrl.toString() };
};

const nextLinkControl = (html: string, pagination: NextLinkPagination) => {
	if (!html) {
		return undefined;
	}
	const $ = cheerio.load(html);
	for (const selector of [pagination.selector, ...(pagination.selectors ?? [])]) {
		try {
			const element = $(selector).first();
			if (element.length) {
				return element;
			}
		} catch {
			continue;
		}
	}
	return undefined;
};

const controlDisabled = (element: Cheerio<AnyNode>): boolean => {
	return (
		element.is('[disabled]') ||
		element.attr('aria-disabled') === 'true' ||
		(element.attr('class') ?? '').split(/\s+/).some((token) => token.toLowerCase().includes('disabled'))
	);
};
