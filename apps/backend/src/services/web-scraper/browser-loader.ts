import type { WebRobotBrowserAction, WebRobotRecipe, WebRobotSource, WebRobotStage } from '@nao/shared/web-robot';
import type { Browser, ElementHandle, HTTPRequest, HTTPResponse, Page } from 'puppeteer-core';

import { env } from '../../env';
import { browserLaunchArgs, findChromePath } from '../../utils/headless-browser';
import { delay, headersForOrigin, resolveHeaders } from './request';
import type { TemplateScope } from './template';
import { renderStringTemplate, renderTemplate } from './template';
import { responseFingerprint } from './traversal-evidence';
import type {
	ClickPagination,
	WebRobotBrowserControlState,
	WebRobotBrowserScrollState,
	WebRobotBrowserTraversalSnapshot,
	WebRobotCapturedResponse,
	WebRobotInteractiveBrowser,
	WebRobotLoadedSource,
	WebRobotRunWarning,
} from './types';
import { assertPublicHttpUrl } from './url-policy';

type BrowserSource = Extract<WebRobotSource, { type: 'browser' }>;

export type BrowserLoaderOptions = {
	recipe: WebRobotRecipe;
	scope: TemplateScope;
	env: Record<string, string>;
	signal?: AbortSignal;
	onWarning?: (warning: WebRobotRunWarning) => void;
};

type ScrollPagination = Extract<NonNullable<WebRobotStage['paginate']>, { type: 'scroll' }>;
type InteractivePagination = ClickPagination | ScrollPagination;

export type WebRobotPaginationObservation = {
	clickSelector?: string;
	scroll?: boolean;
	actions?: string[];
	loaded?: WebRobotLoadedSource;
};

type OpenBrowserPage = {
	page: Page;
	url: string;
	captures: WebRobotCapturedResponse[];
	pendingCaptures: Set<Promise<void>>;
	requestCount: () => number;
	relevantCount: () => number;
	captureLimitReached: () => boolean;
	main: { status: number; contentType?: string };
};

const ALLOWED_RESOURCE_TYPES = new Set(['document', 'script', 'xhr', 'fetch', 'stylesheet', 'eventsource']);
const MAX_CAPTURED_RESPONSES = 512;
const MAX_CAPTURED_REQUEST_BYTES = 128 * 1024;

class BrowserLoadLimiter {
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	async acquire(signal?: AbortSignal): Promise<() => void> {
		throwIfAborted(signal);
		if (this.active < env.WEB_ROBOT_BROWSER_MAX_CONCURRENCY) {
			this.active += 1;
			return () => this.release();
		}

		await new Promise<void>((resolve, reject) => {
			const waiter = () => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			};
			const onAbort = () => {
				const index = this.waiting.indexOf(waiter);
				if (index >= 0) {
					this.waiting.splice(index, 1);
				}
				reject(new Error('Web robot run was cancelled'));
			};
			this.waiting.push(waiter);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
		throwIfAborted(signal);
		return () => this.release();
	}

	private release(): void {
		this.active -= 1;
		const next = this.waiting.shift();
		if (next) {
			this.active += 1;
			next();
		}
	}
}

const browserLoadLimiter = new BrowserLoadLimiter();

export const acquireWebRobotBrowserLoad = (signal?: AbortSignal): Promise<() => void> =>
	browserLoadLimiter.acquire(signal);

export class WebRobotBrowserSession {
	private browserPromise: Promise<Browser> | null = null;
	private readonly resolvedHosts = new Map<string, Promise<void>>();

	async load(source: BrowserSource, options: BrowserLoaderOptions): Promise<WebRobotLoadedSource> {
		const release = await browserLoadLimiter.acquire(options.signal);
		try {
			return await this.loadPage(source, options);
		} finally {
			release();
		}
	}

	async loadPaginated(
		source: BrowserSource,
		options: BrowserLoaderOptions,
		pagination: InteractivePagination,
	): Promise<WebRobotLoadedSource[]> {
		const release = await browserLoadLimiter.acquire(options.signal);
		try {
			return pagination.type === 'click'
				? await this.loadClickPages(source, options, pagination)
				: await this.loadScrollPages(source, options, pagination);
		} finally {
			release();
		}
	}

	async probePagination(
		source: BrowserSource,
		options: BrowserLoaderOptions,
		clickSelectors: string[],
		actionSelectors: string[] = [],
	): Promise<WebRobotPaginationObservation> {
		const release = await browserLoadLimiter.acquire(options.signal);
		try {
			const opened = await this.openPage(source, options);
			try {
				const actions: string[] = [];
				let effectiveSource = source;
				for (const selector of actionSelectors.slice(0, 3)) {
					const observed = await this.probeClick(opened, selector);
					if (!observed) {
						await this.restorePage(opened, effectiveSource, options);
						continue;
					}
					actions.push(selector);
					effectiveSource = {
						...effectiveSource,
						actions: [{ type: 'click', selector }, { type: 'delay', ms: 500 }, ...effectiveSource.actions],
					};
				}
				const loaded = actions.length ? (await this.snapshotPage(opened, 0, 0)).loaded : undefined;
				for (const selector of clickSelectors.slice(0, 4)) {
					const observed = await this.probeClick(opened, selector);
					if (observed) {
						return { clickSelector: selector, actions, loaded };
					}
					await this.restorePage(opened, effectiveSource, options);
				}
				await this.restorePage(opened, effectiveSource, options);
				return { scroll: await this.probeScroll(opened), actions, loaded };
			} finally {
				await opened.page.close().catch(() => undefined);
			}
		} finally {
			release();
		}
	}

	async openInteractive(source: BrowserSource, options: BrowserLoaderOptions): Promise<WebRobotInteractiveBrowser> {
		const release = await browserLoadLimiter.acquire(options.signal);
		let opened: OpenBrowserPage;
		try {
			opened = await this.openPage(source, options);
		} catch (error) {
			release();
			throw error;
		}

		let requestOffset = 0;
		let captureOffset = 0;
		let closed = false;

		const scrollState = async (): Promise<WebRobotBrowserScrollState> => {
			const state = await readScrollState(opened.page);
			await Promise.all(opened.pendingCaptures);
			return { ...state, relevantNetworkIdle: opened.relevantCount() === 0 };
		};

		const observeStability = async (): Promise<{ textLength: number; scrollExtent: number }> =>
			opened.page.evaluate(`${EFFECTIVE_SCROLL_TARGET}
				const target = effectiveScrollTarget();
				return {
					textLength: document.body?.innerText.length ?? 0,
					scrollExtent: target.scrollHeight,
				};`) as Promise<{ textLength: number; scrollExtent: number }>;

		return {
			snapshot: async (pagination?: ClickPagination): Promise<WebRobotBrowserTraversalSnapshot> => {
				throwIfAborted(options.signal);
				const result = await this.snapshotPage(opened, requestOffset, captureOffset);
				requestOffset = result.requestOffset;
				captureOffset = result.captureOffset;
				const loaded = result.loaded;
				loaded.responseFingerprint = responseFingerprint(loaded);
				const scroll = await scrollState();
				const control = pagination ? await this.inspectInteractiveControl(opened, pagination) : undefined;
				return { loaded, control, scroll };
			},
			inspectControl: (pagination: ClickPagination) => this.inspectInteractiveControl(opened, pagination),
			click: async (pagination: ClickPagination): Promise<WebRobotBrowserControlState> => {
				throwIfAborted(options.signal);
				const state = await this.inspectInteractiveControl(opened, pagination);
				if (!state.present || !state.enabled) {
					return state;
				}
				if (state.relocated) {
					const relocated = await this.fingerprintControl(opened.page, pagination.fingerprint);
					try {
						await relocated?.click();
					} finally {
						await relocated?.dispose();
					}
					return state;
				}
				const control = state.selector ? await opened.page.$(state.selector) : null;
				try {
					await control?.click();
				} finally {
					await control?.dispose();
				}
				return state;
			},
			scrollIncrement: async (): Promise<void> => {
				throwIfAborted(options.signal);
				await opened.page.evaluate(`${EFFECTIVE_SCROLL_TARGET}
					const target = effectiveScrollTarget();
					target.scrollTop += Math.max(1, Math.floor(target.clientHeight * 0.75));`);
			},
			settle: async (waitMs: number): Promise<void> => {
				throwIfAborted(options.signal);
				if (waitMs > 0) {
					await delay(waitMs, options.signal);
				}
				const deadline = Date.now() + 2_000;
				let previous = await observeStability();
				while (Date.now() < deadline) {
					throwIfAborted(options.signal);
					await delay(100, options.signal);
					await Promise.all(opened.pendingCaptures);
					const next = await observeStability();
					if (
						opened.relevantCount() === 0 &&
						next.textLength === previous.textLength &&
						next.scrollExtent === previous.scrollExtent
					) {
						return;
					}
					previous = next;
				}
			},
			close: async (): Promise<void> => {
				if (closed) {
					return;
				}
				closed = true;
				await opened.page.close().catch(() => undefined);
				release();
			},
		};
	}

	private async inspectInteractiveControl(
		opened: OpenBrowserPage,
		pagination: ClickPagination,
	): Promise<WebRobotBrowserControlState> {
		for (const selector of [pagination.selector, ...(pagination.selectors ?? [])]) {
			const control = await opened.page.$(selector);
			if (!control) {
				continue;
			}
			const disabled = await control.evaluate(
				(element) =>
					element.hasAttribute('disabled') ||
					element.getAttribute('aria-disabled') === 'true' ||
					Array.from(element.classList).some((name) => name.includes('disabled')),
			);
			await control.dispose();
			return { present: true, enabled: !disabled, selector };
		}
		const relocated = await this.fingerprintControl(opened.page, pagination.fingerprint);
		if (!relocated) {
			return { present: false, enabled: false };
		}
		const disabled = await relocated.evaluate(
			(element) =>
				element.hasAttribute('disabled') ||
				element.getAttribute('aria-disabled') === 'true' ||
				Array.from(element.classList).some((name) => name.includes('disabled')),
		);
		await relocated.dispose();
		return {
			present: true,
			enabled: !disabled,
			relocated: true,
			selector: `fingerprint:${pagination.fingerprint?.tag ?? 'control'}`,
		};
	}

	private async loadPage(source: BrowserSource, options: BrowserLoaderOptions): Promise<WebRobotLoadedSource> {
		const opened = await this.openPage(source, options);
		try {
			return (await this.snapshotPage(opened, 0, 0)).loaded;
		} finally {
			await opened.page.close().catch(() => undefined);
		}
	}

	private async loadClickPages(
		source: BrowserSource,
		options: BrowserLoaderOptions,
		pagination: ClickPagination,
	): Promise<WebRobotLoadedSource[]> {
		const opened = await this.openPage(source, options);
		try {
			const snapshots: WebRobotLoadedSource[] = [];
			let requestOffset = 0;
			let captureOffset = 0;
			const snapshot = async () => {
				const result = await this.snapshotPage(opened, requestOffset, captureOffset);
				requestOffset = result.requestOffset;
				captureOffset = result.captureOffset;
				return result.loaded;
			};

			let current = await snapshot();
			snapshots.push(current);
			for (let page = 1; page < pagination.maxPages; page++) {
				throwIfAborted(options.signal);
				const selector = await this.clickNext(opened.page, pagination);
				if (!selector) {
					break;
				}
				if (selector !== pagination.selector) {
					options.onWarning?.({
						kind: 'pagination_fallback',
						selector: pagination.selector,
						fallback: selector,
						relocated: selector.startsWith('fingerprint:'),
						message: `Pagination selector '${pagination.selector}' did not match; used '${selector}'`,
					});
				}
				await new Promise((resolve) => setTimeout(resolve, pagination.waitMs));
				await resetScroll(opened.page);
				const next = await snapshot();
				if (next.bodyText === current.bodyText) {
					break;
				}
				snapshots.push(next);
				current = next;
			}
			return snapshots;
		} finally {
			await opened.page.close().catch(() => undefined);
		}
	}

	private async loadScrollPages(
		source: BrowserSource,
		options: BrowserLoaderOptions,
		pagination: ScrollPagination,
	): Promise<WebRobotLoadedSource[]> {
		const opened = await this.openPage(source, options);
		try {
			const snapshots: WebRobotLoadedSource[] = [];
			let requestOffset = 0;
			let captureOffset = 0;
			const snapshot = async () => {
				const result = await this.snapshotPage(opened, requestOffset, captureOffset);
				requestOffset = result.requestOffset;
				captureOffset = result.captureOffset;
				return result.loaded;
			};

			let current = await snapshot();
			snapshots.push(current);
			for (let page = 1; page < pagination.maxPages; page++) {
				throwIfAborted(options.signal);
				await opened.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
				await new Promise((resolve) => setTimeout(resolve, pagination.waitMs));
				const next = await snapshot();
				if (next.bodyText === current.bodyText) {
					break;
				}
				snapshots.push(next);
				current = next;
			}
			return snapshots;
		} finally {
			await opened.page.close().catch(() => undefined);
		}
	}

	private async probeClick(opened: OpenBrowserPage, selector: string): Promise<boolean> {
		const before = await this.interactionSignal(opened);
		const control = await opened.page.$(selector);
		if (!control) {
			return false;
		}
		const disabled = await control.evaluate(
			(element) =>
				element.hasAttribute('disabled') ||
				element.getAttribute('aria-disabled') === 'true' ||
				Array.from(element.classList).some((name) => name.includes('disabled')),
		);
		if (disabled) {
			return false;
		}
		try {
			await control.click();
		} catch {
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		await Promise.all(opened.pendingCaptures);
		return interactionChanged(before, await this.interactionSignal(opened));
	}

	private async probeScroll(opened: OpenBrowserPage): Promise<boolean> {
		const before = await this.interactionSignal(opened);
		await opened.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		await Promise.all(opened.pendingCaptures);
		return interactionChanged(before, await this.interactionSignal(opened));
	}

	private async restorePage(
		opened: OpenBrowserPage,
		source: BrowserSource,
		options: BrowserLoaderOptions,
	): Promise<void> {
		const response = await opened.page.goto(opened.url, {
			waitUntil: 'domcontentloaded',
			timeout: options.recipe.request.timeoutMs,
		});
		opened.main.status = response?.status() ?? opened.main.status;
		opened.main.contentType = response?.headers()['content-type'] ?? opened.main.contentType;
		for (const action of source.actions) {
			await runAction(opened.page, action, options.recipe.request.timeoutMs);
		}
		await Promise.all(opened.pendingCaptures);
	}

	private async interactionSignal(opened: OpenBrowserPage): Promise<{
		bodyText: string;
		links: number;
		textLength: number;
		captures: number;
	}> {
		await Promise.all(opened.pendingCaptures);
		const bodyText = await opened.page.content();
		const dom = await opened.page.evaluate(() => ({
			links: document.querySelectorAll('a[href]').length,
			textLength: document.body?.innerText.length ?? 0,
		}));
		return { bodyText, links: dom.links, textLength: dom.textLength, captures: opened.captures.length };
	}

	private async openPage(source: BrowserSource, options: BrowserLoaderOptions): Promise<OpenBrowserPage> {
		const rendered = renderTemplate(source, options.scope);
		const url = renderStringTemplate(rendered.url, options.scope);
		await assertPublicHttpUrl(url, options.recipe.allowedHosts);

		const browser = await this.browser();
		const page = await browser.newPage();
		const captures: WebRobotCapturedResponse[] = [];
		const captureBudget = { count: 0, reached: false };
		const pendingCaptures = new Set<Promise<void>>();
		const relevantRequests = new Set<HTTPRequest>();
		const main: { status: number; contentType?: string } = { status: 0 };
		let requests = 0;

		try {
			await page.setViewport(rendered.viewport);
			if (options.recipe.request.userAgent) {
				await page.setUserAgent(options.recipe.request.userAgent);
			}
			const headers = resolveHeaders(rendered.headers, options.env);
			const initialOrigin = new URL(url).origin;
			page.setDefaultTimeout(options.recipe.request.timeoutMs);
			await page.setRequestInterception(true);

			page.on('request', (request) => {
				void this.handleRequest(request, options, headers, initialOrigin).catch(() => request.abort());
			});
			page.on('response', (response) => {
				const request = response.request();
				if (request.isNavigationRequest() && response.frame() === page.mainFrame()) {
					main.status = response.status();
					main.contentType = response.headers()['content-type'];
				}
				const pending = captureResponse(
					response,
					rendered.capture,
					captures,
					captureBudget,
					options.recipe.limits.maxResponseBytes,
				)
					.catch(() => undefined)
					.finally(() => pendingCaptures.delete(pending));
				pendingCaptures.add(pending);
			});
			page.on('request', (request) => {
				requests += 1;
				const resourceType = request.resourceType();
				if (
					(resourceType === 'xhr' || resourceType === 'fetch') &&
					(rendered.capture.length === 0 ||
						rendered.capture.some((rule) => matchesPattern(request.url(), rule.urlPattern)))
				) {
					relevantRequests.add(request);
				}
			});
			page.on('requestfinished', (request) => relevantRequests.delete(request));
			page.on('requestfailed', (request) => relevantRequests.delete(request));

			const response = await page.goto(url, {
				waitUntil: 'domcontentloaded',
				timeout: options.recipe.request.timeoutMs,
			});
			main.status = response?.status() ?? 0;
			main.contentType = response?.headers()['content-type'];

			for (const action of rendered.actions) {
				throwIfAborted(options.signal);
				await runAction(page, action, options.recipe.request.timeoutMs);
			}

			return {
				page,
				url,
				captures,
				pendingCaptures,
				requestCount: () => requests,
				relevantCount: () => relevantRequests.size,
				captureLimitReached: () => captureBudget.reached,
				main,
			};
		} catch (error) {
			await page.close().catch(() => undefined);
			throw error;
		}
	}

	private async snapshotPage(
		opened: OpenBrowserPage,
		requestOffset: number,
		captureOffset: number,
	): Promise<{ loaded: WebRobotLoadedSource; requestOffset: number; captureOffset: number }> {
		await Promise.all(opened.pendingCaptures);
		const requestTotal = opened.requestCount();
		return {
			loaded: {
				url: opened.url,
				finalUrl: opened.page.url(),
				status: opened.main.status,
				contentType: opened.main.contentType,
				bodyText: await opened.page.content(),
				captures: opened.captures.slice(captureOffset),
				requests: requestTotal - requestOffset,
				captureLimitReached: opened.captureLimitReached() || undefined,
			},
			requestOffset: requestTotal,
			captureOffset: opened.captures.length,
		};
	}

	private async clickNext(page: Page, pagination: ClickPagination): Promise<string | null> {
		for (const selector of [pagination.selector, ...(pagination.selectors ?? [])]) {
			const control = await page.$(selector);
			if (!control) {
				continue;
			}
			const disabled = await control.evaluate(
				(element) =>
					element.hasAttribute('disabled') ||
					element.getAttribute('aria-disabled') === 'true' ||
					Array.from(element.classList).some((name) => name.includes('disabled')),
			);
			if (disabled) {
				continue;
			}
			await control.click();
			return selector;
		}
		const relocated = await this.fingerprintControl(page, pagination.fingerprint);
		if (relocated) {
			await relocated.click();
			return `fingerprint:${pagination.fingerprint?.tag}`;
		}
		return null;
	}

	private async fingerprintControl(
		page: Page,
		fingerprint: ClickPagination['fingerprint'],
	): Promise<ElementHandle<Element> | null> {
		if (!fingerprint) {
			return null;
		}
		const index = await page.evaluate((expected) => {
			const normalize = (value: string | null | undefined) =>
				(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
			const elements = Array.from(document.getElementsByTagName(expected.tag));
			let bestIndex = -1;
			let bestScore = 0;
			elements.forEach((element, elementIndex) => {
				const attributes = Object.fromEntries(
					element
						.getAttributeNames()
						.filter((name) => name !== 'class' && name !== 'style')
						.map((name) => [name, element.getAttribute(name) ?? '']),
				);
				const classes = Array.from(element.classList);
				const childTags = Array.from(element.children).map((child) => child.tagName.toLowerCase());
				const text = normalize(element instanceof HTMLElement ? element.innerText : element.textContent);
				let score = 30;
				let attributeScore = 0;
				for (const [name, value] of Object.entries(expected.attributes)) {
					if (name in attributes) {
						attributeScore += attributes[name] === value ? 16 : 8;
					}
				}
				score += Math.min(attributeScore, 32);
				score += Math.min(expected.classes.filter((name) => classes.includes(name)).length * 5, 20);
				score += Math.min(expected.childTags.filter((tag) => childTags.includes(tag)).length * 10, 30);
				const expectedText = normalize(expected.text);
				if (expectedText && text && (expectedText === text || text.includes(expectedText))) {
					score += 12;
				}
				if (score > bestScore) {
					bestScore = score;
					bestIndex = elementIndex;
				}
			});
			return bestScore >= 35 ? bestIndex : -1;
		}, fingerprint);
		if (index < 0) {
			return null;
		}
		const handle = await page.evaluateHandle(
			(expected, elementIndex) => document.getElementsByTagName(expected.tag)[elementIndex] ?? null,
			fingerprint,
			index,
		);
		const element = handle.asElement() as ElementHandle<Element> | null;
		if (!element) {
			await handle.dispose();
		}
		return element;
	}

	async close(): Promise<void> {
		const browser = await this.browserPromise?.catch(() => null);
		this.browserPromise = null;
		await browser?.close().catch(() => undefined);
	}

	private browser(): Promise<Browser> {
		this.browserPromise ??= launchBrowser();
		return this.browserPromise;
	}

	private async handleRequest(
		request: HTTPRequest,
		options: BrowserLoaderOptions,
		configuredHeaders: Record<string, string>,
		initialOrigin: string,
	): Promise<void> {
		const url = request.url();
		if (url.startsWith('data:') || url.startsWith('blob:')) {
			await request.continue();
			return;
		}
		if (!ALLOWED_RESOURCE_TYPES.has(request.resourceType())) {
			await request.abort();
			return;
		}

		const parsed = new URL(url);
		let checked = this.resolvedHosts.get(parsed.hostname);
		if (!checked) {
			checked = assertPublicHttpUrl(url, options.recipe.allowedHosts).then(() => undefined);
			this.resolvedHosts.set(parsed.hostname, checked);
		}
		await checked;
		throwIfAborted(options.signal);
		await request.continue({
			headers: {
				...request.headers(),
				...headersForOrigin(configuredHeaders, parsed.origin, initialOrigin),
			},
		});
	}
}

const EFFECTIVE_SCROLL_TARGET = `const effectiveScrollTarget = () => {
	const documentTarget = document.scrollingElement ?? document.documentElement;
	let best = documentTarget;
	let bestExtent = documentTarget.scrollHeight - documentTarget.clientHeight;
	for (const element of Array.from(document.querySelectorAll('*'))) {
		const style = getComputedStyle(element);
		if (
			(style.overflowY === 'auto' || style.overflowY === 'scroll') &&
			element.scrollHeight > element.clientHeight
		) {
			const extent = element.scrollHeight - element.clientHeight;
			if (extent > bestExtent) {
				best = element;
				bestExtent = extent;
			}
		}
	}
	return best;
};`;

const readScrollState = async (page: Page): Promise<Omit<WebRobotBrowserScrollState, 'relevantNetworkIdle'>> =>
	page.evaluate(`${EFFECTIVE_SCROLL_TARGET}
		const target = effectiveScrollTarget();
		const viewportExtent = target.clientHeight;
		const scrollTop = target.scrollTop;
		const scrollExtent = target.scrollHeight;
		const atEffectiveBottom = scrollExtent - scrollTop - viewportExtent <= Math.max(2, viewportExtent * 0.05);
		const isVisible = (element) => element.getClientRects().length > 0;
		const loadingIndicatorPresent = Array.from(
			document.querySelectorAll('[aria-busy="true"],[role="progressbar"],[class*="loading" i],[class*="spinner" i]'),
		).some(isVisible);
		let rangeStart;
		let rangeEnd;
		let setSize;
		for (const element of document.querySelectorAll('[aria-posinset]')) {
			if (!isVisible(element)) {
				continue;
			}
			const position = Number.parseInt(element.getAttribute('aria-posinset') ?? '', 10);
			if (position > 0) {
				rangeStart = rangeStart === undefined ? position : Math.min(rangeStart, position);
				rangeEnd = rangeEnd === undefined ? position : Math.max(rangeEnd, position);
			}
		}
		for (const element of document.querySelectorAll('[aria-setsize]')) {
			if (!isVisible(element)) {
				continue;
			}
			const size = Number.parseInt(element.getAttribute('aria-setsize') ?? '', 10);
			if (size > 0) {
				setSize = setSize === undefined ? size : Math.max(setSize, size);
			}
		}
		return { scrollTop, scrollExtent, viewportExtent, atEffectiveBottom, loadingIndicatorPresent, rangeStart, rangeEnd, setSize };
	`) as Promise<Omit<WebRobotBrowserScrollState, 'relevantNetworkIdle'>>;

const interactionChanged = (
	before: { bodyText: string; links: number; textLength: number; captures: number },
	after: { bodyText: string; links: number; textLength: number; captures: number },
): boolean => {
	const textDelta = Math.abs(after.textLength - before.textLength);
	return (
		after.links > before.links ||
		after.captures > before.captures ||
		(after.bodyText !== before.bodyText && textDelta > Math.max(40, before.textLength * 0.05))
	);
};

const launchBrowser = async (): Promise<Browser> => {
	const puppeteer = await import('puppeteer-core');
	return puppeteer.default.launch({
		headless: true,
		executablePath: findChromePath(),
		args: browserLaunchArgs(),
	});
};

const resetScroll = async (page: Page): Promise<void> => {
	await page.evaluate(() => window.scrollTo(0, 0));
	await new Promise((resolve) => setTimeout(resolve, 250));
	for (let index = 0; index < 2; index++) {
		await page.evaluate(() => window.scrollBy(0, window.innerHeight));
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
};

const runAction = async (page: Page, action: WebRobotBrowserAction, timeoutMs: number): Promise<void> => {
	switch (action.type) {
		case 'waitForSelector':
			await page.waitForSelector(action.selector, { timeout: action.timeoutMs ?? timeoutMs });
			return;
		case 'waitForResponse':
			await page.waitForResponse((response) => matchesPattern(response.url(), action.urlPattern), {
				timeout: action.timeoutMs ?? timeoutMs,
			});
			return;
		case 'waitForNavigation':
			await page.waitForNavigation({ timeout: action.timeoutMs ?? timeoutMs });
			return;
		case 'click':
			for (const selector of [action.selector, ...(action.selectors ?? [])]) {
				if (await page.$(selector)) {
					await page.click(selector);
					return;
				}
			}
			throw new Error(`Click action found no matching selector: ${action.selector}`);
		case 'select':
			await page.select(action.selector, action.value);
			return;
		case 'scroll':
			for (let index = 0; index < action.times; index += 1) {
				await page.evaluate(() => window.scrollBy(0, window.innerHeight));
				await new Promise((resolve) => setTimeout(resolve, action.delayMs));
			}
			return;
		case 'delay':
			await new Promise((resolve) => setTimeout(resolve, action.ms));
			return;
	}
};

const captureResponse = async (
	response: HTTPResponse,
	rules: BrowserSource['capture'],
	captures: WebRobotCapturedResponse[],
	captureBudget: { count: number; reached: boolean },
	maxResponseBytes: number,
): Promise<void> => {
	for (const rule of rules) {
		if (!matchesPattern(response.url(), rule.urlPattern)) {
			continue;
		}
		if (captureBudget.count >= MAX_CAPTURED_RESPONSES) {
			captureBudget.reached = true;
			continue;
		}
		captureBudget.count += 1;

		const text = await response.text();
		if (Buffer.byteLength(text) > maxResponseBytes) {
			throw new Error(`Captured response exceeds the ${maxResponseBytes} byte limit`);
		}
		const request = response.request();
		const postData = request.postData();
		captures.push({
			name: rule.name,
			url: response.url(),
			status: response.status(),
			requestMethod: request.method(),
			requestContentType: request.headers()['content-type'],
			...(postData && postData.length <= MAX_CAPTURED_REQUEST_BYTES
				? { requestBody: parseCapturedRequestBody(postData, request.headers()['content-type']) }
				: {}),
			contentType: response.headers()['content-type'],
			body: rule.body === 'json' ? JSON.parse(text) : text,
		});
	}
};

const parseCapturedRequestBody = (body: string, contentType?: string): unknown => {
	if (!contentType?.includes('json') && !body.trim().startsWith('{') && !body.trim().startsWith('[')) {
		return body;
	}
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
};

const matchesPattern = (url: string, pattern: string): boolean => {
	if (pattern.includes('*')) {
		const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
		return regex.test(url);
	}
	return url.includes(pattern);
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const throwIfAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) {
		throw new Error('Web robot run was cancelled');
	}
};
