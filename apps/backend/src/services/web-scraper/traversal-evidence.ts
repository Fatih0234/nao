import { createHash } from 'node:crypto';

import type { WebRobotSource } from '@nao/shared/web-robot';

import { type RenderedHttpRequest, renderHttpRequest, SENSITIVE_HEADERS } from './request';
import { renderTemplate, type TemplateScope } from './template';
import type { WebRobotLoadedSource } from './types';
import { canonicalHttpUrl } from './url-policy';

const SENSITIVE_VALUE_PATTERN =
	/token|secret|password|authorization|cookie|session|cursor|after|next_token|csrf|api_key/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_KEYS = 32;
const MAX_ARRAY = 16;
const MAX_STRING = 300;

export const stableEvidenceStringify = (value: unknown): string => {
	if (Array.isArray(value)) {
		return `[${value.map(stableEvidenceStringify).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableEvidenceStringify(entry)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};

export const fingerprintEvidence = (value: unknown): string =>
	createHash('sha256').update(stableEvidenceStringify(value)).digest('hex');

export const redactedRequestTarget = (method: string, url: string): string =>
	`${method.toUpperCase()} ${redactedUrlString(url)}`.slice(0, 2048);

export const sanitizeTraversalError = (error: unknown): string => {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactedUrlString(match)).slice(0, 1024);
};

export const renderedTargetEvidence = (
	source: WebRobotSource,
	scope: TemplateScope,
	env: Record<string, string>,
): { fingerprint: string; redactedTarget: string; url: string } => {
	if (source.type === 'browser') {
		const rendered = renderTemplate(source, scope);
		const url = canonicalHttpUrl(rendered.url);
		const headerNames = safeHeaderNames(rendered.headers);
		const actions = (rendered.actions ?? []).map((action) => action.type);
		const fingerprint = fingerprintEvidence({
			type: 'browser',
			method: 'GET',
			url: hashedUrlString(url),
			headerNames,
			actions,
		});
		return { fingerprint, redactedTarget: `GET ${redactedUrlString(url)}`, url };
	}
	const request = renderHttpRequest(source, scope, env);
	return renderedRequestEvidence(request);
};

export const renderedRequestEvidence = (
	request: RenderedHttpRequest,
): { fingerprint: string; redactedTarget: string; url: string } => {
	const url = request.url.toString();
	const fingerprint = fingerprintEvidence({
		method: request.method,
		url: hashedUrlString(url),
		headerNames: Object.keys(request.headers)
			.filter((name) => !SENSITIVE_HEADERS.has(name.toLowerCase()))
			.map((name) => name.toLowerCase())
			.sort(),
		body: request.bodyValue === undefined ? undefined : hashEvidence(request.bodyValue),
	});
	return { fingerprint, redactedTarget: redactedRequestTarget(request.method, url), url };
};

export const responseFingerprint = (loaded: WebRobotLoadedSource): string =>
	fingerprintEvidence({
		status: loaded.status,
		finalUrl: loaded.finalUrl,
		contentType: loaded.contentType,
		bodyText: loaded.bodyText,
		bodyJson: loaded.bodyJson,
		captures: loaded.captures.map((capture) => ({
			status: capture.status,
			url: capture.url,
			body: capture.body,
		})),
	});

export const identitySetFingerprint = (descriptors: string[]): string =>
	fingerprintEvidence([...new Set(descriptors)].sort());

const safeHeaderNames = (headers: Record<string, string | { env: string }> | undefined): string[] =>
	Object.keys(headers ?? {})
		.filter((name) => !SENSITIVE_HEADERS.has(name.toLowerCase()))
		.map((name) => name.toLowerCase())
		.sort();

export const redactedUrlString = (url: string): string => {
	try {
		const parsed = new URL(url);
		for (const key of [...parsed.searchParams.keys()]) {
			if (SENSITIVE_VALUE_PATTERN.test(key)) {
				const count = parsed.searchParams.getAll(key).length;
				parsed.searchParams.delete(key);
				for (let index = 0; index < count; index += 1) {
					parsed.searchParams.append(key, REDACTED);
				}
			}
		}
		return parsed.toString();
	} catch {
		return url.split('?')[0] ?? url;
	}
};

const hashedUrlString = (url: string): string => {
	try {
		const parsed = new URL(url);
		for (const key of [...parsed.searchParams.keys()]) {
			if (SENSITIVE_VALUE_PATTERN.test(key)) {
				const values = parsed.searchParams.getAll(key).map((value) => `h:${fingerprintEvidence(value)}`);
				parsed.searchParams.delete(key);
				for (const value of values) {
					parsed.searchParams.append(key, value);
				}
			}
		}
		return parsed.toString();
	} catch {
		return url.split('?')[0] ?? url;
	}
};

const hashEvidence = (value: unknown, depth = 0): unknown => {
	if (depth > MAX_DEPTH) {
		return '[truncated]';
	}
	if (typeof value === 'string') {
		return value.length > MAX_STRING ? `h:${fingerprintEvidence(value)}` : value;
	}
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY).map((entry) => hashEvidence(entry, depth + 1));
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.slice(0, MAX_KEYS)
				.map(([key, entry]) => [
					key,
					SENSITIVE_VALUE_PATTERN.test(key)
						? `h:${fingerprintEvidence(entry)}`
						: hashEvidence(entry, depth + 1),
				]),
		);
	}
	return value;
};
