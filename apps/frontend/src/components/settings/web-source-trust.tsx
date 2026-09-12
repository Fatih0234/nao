import type { CatalogueCurrentState, CatalogueTrustSummary } from '@nao/shared/web-robot-trust';

import {
	catalogueExecutionLabel,
	catalogueGranularityLabel,
	cataloguePublicationStatusLabel,
	catalogueQualityPresentation,
	catalogueTrustBasisLabel,
	catalogueTrustStatusLabel,
	formatDateTime,
} from '@/components/settings/web-source-recipe';
import { Badge } from '@/components/ui/badge';
import { SettingsCard } from '@/components/ui/settings-card';

const DIMENSION_LABELS = {
	scope: 'Scope',
	records: 'Records',
	identity: 'Identity',
	semantics: 'Required product data',
	freshness: 'Freshness',
} as const;

export function WebSourceTrust({ state }: { state: CatalogueCurrentState }) {
	const presentation = catalogueQualityPresentation(state);
	const summary = state.activeSummary;
	const latest = state.latestSummary;

	return (
		<SettingsCard
			title='Quality checks'
			description='Scope, completeness, identity, required product data, and freshness.'
			action={<Badge variant={presentation.variant}>{presentation.label}</Badge>}
		>
			<p className='text-sm text-muted-foreground'>{presentation.detail}</p>

			{summary ? (
				<TrustSummaryDetails summary={summary} />
			) : (
				<div className='grid gap-2 text-sm text-muted-foreground'>
					<p>No agent-visible dataset exists for this source yet.</p>
					{!latest && (
						<div className='flex flex-wrap gap-2'>
							{state.executionStatus && (
								<Badge variant='outline'>{catalogueExecutionLabel(state.executionStatus)}</Badge>
							)}
							{state.trustStatus && (
								<Badge variant='outline'>{catalogueTrustStatusLabel(state.trustStatus)}</Badge>
							)}
							{state.publicationStatus && (
								<Badge variant='outline'>
									{cataloguePublicationStatusLabel(state.publicationStatus)}
								</Badge>
							)}
						</div>
					)}
				</div>
			)}

			{latest && (
				<div className='grid gap-3 border-t pt-4'>
					<span className='text-xs font-medium text-muted-foreground'>Latest refresh checks</span>
					<TrustSummaryDetails summary={latest} />
				</div>
			)}
		</SettingsCard>
	);
}

function TrustSummaryDetails({ summary }: { summary: CatalogueTrustSummary }) {
	return (
		<>
			<div className='grid gap-3 md:grid-cols-4'>
				<TrustStat label='Scope' value={summary.scopeLabel} />
				<TrustStat
					label='Products checked'
					value={`${summary.entityCount} ${catalogueGranularityLabel(summary.granularity)}`}
				/>
				<TrustStat label='Completeness evidence' value={catalogueTrustBasisLabel(summary.basis)} />
				<TrustStat label='Checked' value={formatDateTime(summary.verifiedAt)} />
			</div>
			<div className='grid gap-2'>
				{(Object.entries(DIMENSION_LABELS) as [keyof typeof DIMENSION_LABELS, string][]).map(([key, label]) => {
					const dimension = summary.dimensions[key];
					return (
						<div key={key} className='flex flex-wrap items-center gap-2 text-sm'>
							<Badge variant={dimensionBadgeVariant(dimension.status)}>{dimension.status}</Badge>
							<span className='font-medium'>{label}</span>
							{dimension.reasons.length > 0 && (
								<span className='text-xs text-muted-foreground'>{dimension.reasons.join(' ')}</span>
							)}
						</div>
					);
				})}
			</div>
			{summary.requiredCoverage.length > 0 && (
				<div className='grid gap-1'>
					<span className='text-xs font-medium text-muted-foreground'>Required product data</span>
					<div className='flex flex-wrap gap-2'>
						{summary.requiredCoverage.map((metric) => (
							<Badge
								key={metric.concept}
								variant={metric.coverage >= metric.minimumCoverage ? 'success' : 'destructive'}
							>
								{metric.concept} {Math.round(metric.coverage * 100)}% (minimum{' '}
								{Math.round(metric.minimumCoverage * 100)}%)
							</Badge>
						))}
					</div>
				</div>
			)}
			{summary.limitations.length > 0 && (
				<div className='grid gap-1 text-xs text-muted-foreground'>
					<span className='font-medium'>Limitations</span>
					{summary.limitations.map((limitation) => (
						<div key={limitation}>{limitation}</div>
					))}
				</div>
			)}
			{summary.blockerCodes.length > 0 && (
				<div className='flex flex-wrap gap-2'>
					{summary.blockerCodes.map((code) => (
						<Badge key={code} variant='destructive'>
							{code}
						</Badge>
					))}
				</div>
			)}
		</>
	);
}

const dimensionBadgeVariant = (status: string) =>
	status === 'passed'
		? 'success'
		: status === 'failed'
			? 'destructive'
			: status === 'limited'
				? 'context_admin'
				: 'outline';

function TrustStat({ label, value }: { label: string; value: string }) {
	return (
		<div className='rounded-md border bg-muted/20 p-3'>
			<div className='text-xs text-muted-foreground'>{label}</div>
			<div className='mt-1 truncate text-sm font-medium'>{value}</div>
		</div>
	);
}
