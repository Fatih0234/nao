import type { CatalogueTrustReport } from '@nao/shared/web-robot-trust';

import { fingerprintEvidence } from '../web-scraper/traversal-evidence';

export const catalogueTrustReportHash = (report: CatalogueTrustReport): string => fingerprintEvidence(report);

export const catalogueTrustReadme = (report: CatalogueTrustReport, paths: string[]): string => {
	const { summary } = report;
	const lines: string[] = [
		'# Catalogue Trust Report',
		'',
		`Status: ${summary.status}`,
		`Basis: ${summary.basis}`,
		`Scope: ${summary.scopeLabel} (${report.scope.entryUrl})`,
		`Entities: ${summary.entityCount} (${summary.granularity})`,
		`Verified at: ${summary.verifiedAt}`,
		'',
		'## Dimensions',
	];
	for (const [name, dimension] of Object.entries(summary.dimensions)) {
		lines.push(
			`- ${name}: ${dimension.status}${dimension.reasons.length ? ` — ${dimension.reasons.join(' ')}` : ''}`,
		);
	}
	lines.push('', '## Count evidence');
	const positive = (comparison: (typeof report.countComparisons)[number]) =>
		comparison.status === 'match' || comparison.status === 'reconciled';
	const reconciled = report.countComparisons.filter(positive);
	if (reconciled.length > 0) {
		for (const comparison of reconciled) {
			lines.push(
				`- Observed ${comparison.observedUniqueCount} unique entities reconciled with expected count ${comparison.expectedCount ?? 'unknown'}.`,
			);
		}
	} else if (summary.status === 'ready' && summary.basis === 'traversal_complete') {
		lines.push('- Traversal-only basis: no independent comparable count was available to reconcile.');
	} else {
		lines.push('- Count reconciliation did not pass; review the comparison evidence and blockers below.');
	}
	for (const comparison of report.countComparisons.filter((entry) => !positive(entry))) {
		lines.push(`- ${comparison.status}: ${comparison.explanation ?? 'no explanation'}`);
	}
	lines.push('', '## Required concept coverage');
	for (const concept of report.semantics.concepts) {
		lines.push(
			`- ${concept.concept}: ${concept.covered}/${concept.total} (${Math.round(concept.coverage * 100)}%)${concept.required ? ' required' : ' optional'} minimum ${Math.round(concept.minimumCoverage * 100)}%`,
		);
	}
	if (summary.limitations.length > 0) {
		lines.push('', '## Limitations');
		for (const entry of summary.limitations) {
			lines.push(`- ${entry}`);
		}
	}
	if (summary.blockerCodes.length > 0) {
		lines.push('', '## Blockers');
		for (const code of summary.blockerCodes) {
			lines.push(`- ${code}`);
		}
	}
	if (paths.length > 0) {
		lines.push('', '## Artifacts');
		for (const path of paths) {
			lines.push(`- ${path}`);
		}
	}
	return `${lines.join('\n')}\n`;
};

export const catalogueTrustManifestProjection = (
	report: CatalogueTrustReport,
): {
	trustSummary: CatalogueTrustReport['summary'];
	trustReportHash: string;
	scope: {
		id: string;
		label: string;
		entryUrl: string;
		activeFilters: Record<string, string | string[]>;
		searchTerm?: string;
		locale?: string;
	};
	contract: { requiredConcepts: CatalogueTrustReport['contract']['requiredConcepts'] };
	knownLimitations: string[];
} => ({
	trustSummary: report.summary,
	trustReportHash: catalogueTrustReportHash(report),
	scope: {
		id: report.scope.id,
		label: report.scope.label,
		entryUrl: report.scope.entryUrl,
		activeFilters: report.scope.activeFilters,
		...(report.scope.searchTerm ? { searchTerm: report.scope.searchTerm } : {}),
		...(report.scope.locale ? { locale: report.scope.locale } : {}),
	},
	contract: {
		requiredConcepts: report.contract.requiredConcepts,
	},
	knownLimitations: report.summary.limitations,
});
