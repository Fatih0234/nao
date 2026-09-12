import type { WebRobotBrowserScrollState } from './types';

export const browserStateStable = (
	previous: WebRobotBrowserScrollState,
	current: WebRobotBrowserScrollState,
): boolean =>
	Math.abs(previous.scrollExtent - current.scrollExtent) <= 1 &&
	Math.abs(previous.scrollTop - current.scrollTop) <= 1 &&
	previous.rangeStart === current.rangeStart &&
	previous.rangeEnd === current.rangeEnd &&
	previous.setSize === current.setSize &&
	previous.relevantNetworkIdle &&
	current.relevantNetworkIdle &&
	!previous.loadingIndicatorPresent &&
	!current.loadingIndicatorPresent;

export const virtualRangeGap = (previous: WebRobotBrowserScrollState, current: WebRobotBrowserScrollState): boolean => {
	if (
		previous.rangeStart === undefined ||
		previous.rangeEnd === undefined ||
		current.rangeStart === undefined ||
		current.rangeEnd === undefined
	) {
		return false;
	}
	return current.rangeStart > previous.rangeEnd + 1 || current.rangeEnd < previous.rangeStart - 1;
};

export const virtualizationObserved = (
	previousIdentityKeys: ReadonlySet<string>,
	currentIdentityKeys: ReadonlySet<string>,
	_previousState: WebRobotBrowserScrollState,
	currentState: WebRobotBrowserScrollState,
): boolean => {
	if (currentState.rangeStart !== undefined || currentState.setSize !== undefined) {
		return true;
	}
	const removed = [...previousIdentityKeys].some((key) => !currentIdentityKeys.has(key));
	const added = [...currentIdentityKeys].some((key) => !previousIdentityKeys.has(key));
	return removed && added;
};
