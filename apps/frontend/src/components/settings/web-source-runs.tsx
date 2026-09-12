import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, List, Wrench, X } from 'lucide-react';
import { useState } from 'react';

import type { WebRobotRun } from '@/components/settings/web-source-recipe';
import {
	catalogueExecutionLabel,
	catalogueGranularityLabel,
	cataloguePublicationStatusLabel,
	catalogueTrustBasisLabel,
	catalogueTrustStatusLabel,
	formatDateTime,
	formatDuration,
	webRobotRunBadgeVariant,
	webRobotTriggerLabel,
} from '@/components/settings/web-source-recipe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/empty';
import { ErrorMessage } from '@/components/ui/error-message';
import { SettingsCard } from '@/components/ui/settings-card';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { trpc } from '@/main';

export function WebSourceRuns({
	robotId,
	definitionHash,
	runs,
	onCancelRun,
	onRepairApplied,
	cancellingRunId,
}: {
	robotId: string;
	definitionHash: string;
	runs: WebRobotRun[];
	onCancelRun: (run: WebRobotRun) => void;
	onRepairApplied: () => Promise<void>;
	cancellingRunId?: string | null;
}) {
	return (
		<SettingsCard
			title='Refresh history'
			description='Manual and scheduled refreshes, quality results, changes, and diagnostic artifacts.'
			flush
		>
			{runs.length === 0 ? (
				<Empty className='p-8'>No refreshes yet.</Empty>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Result</TableHead>
							<TableHead>Started by</TableHead>
							<TableHead>Requested</TableHead>
							<TableHead>Duration</TableHead>
							<TableHead>Products found</TableHead>
							<TableHead>Changes</TableHead>
							<TableHead>Issues</TableHead>
							<TableHead>Output</TableHead>
							<TableHead className='w-0' />
						</TableRow>
					</TableHeader>
					<TableBody>
						{runs.map((run) => (
							<WebSourceRunRow
								key={run.id}
								robotId={robotId}
								definitionHash={definitionHash}
								run={run}
								onCancelRun={onCancelRun}
								onRepairApplied={onRepairApplied}
								isCancelling={cancellingRunId === run.id}
							/>
						))}
					</TableBody>
				</Table>
			)}
		</SettingsCard>
	);
}

function WebSourceRunRow({
	robotId,
	definitionHash,
	run,
	onCancelRun,
	onRepairApplied,
	isCancelling,
}: {
	robotId: string;
	definitionHash: string;
	run: WebRobotRun;
	onCancelRun: (run: WebRobotRun) => void;
	onRepairApplied: () => Promise<void>;
	isCancelling: boolean;
}) {
	const { isCopied, copy } = useCopyToClipboard();
	const [showArtifacts, setShowArtifacts] = useState(false);
	const previewRepair = useMutation(trpc.webRobot.previewRepair.mutationOptions());
	const applyRepair = useMutation(trpc.webRobot.applyRepair.mutationOptions());
	const canCancel = run.status === 'queued' || run.status === 'running';
	const canRepair = run.status === 'failed' || run.status === 'partial';
	const stats = run.stats;
	const warnings = stats.warnings ?? [];
	const coverage = Object.entries(stats.fieldCoverage ?? {});
	const repairPreview = previewRepair.data;
	const repairConfiguration =
		repairPreview && 'scope' in repairPreview && 'recipe' in repairPreview && repairPreview.recipe
			? repairPreview
			: undefined;
	const runError = run.executionErrorMessage ?? run.publicationErrorMessage ?? run.errorMessage;
	const trustSummary = run.trustSummary;

	return (
		<>
			<TableRow>
				<TableCell>
					<div className='flex flex-wrap items-center gap-1'>
						<Badge variant={webRobotRunBadgeVariant(run.status)}>
							{catalogueExecutionLabel(run.executionStatus)}
						</Badge>
						{run.trustStatus && (
							<Badge variant='outline'>{catalogueTrustStatusLabel(run.trustStatus)}</Badge>
						)}
						{run.publicationStatus && run.publicationStatus !== 'not_evaluated' && (
							<Badge variant='outline'>{cataloguePublicationStatusLabel(run.publicationStatus)}</Badge>
						)}
						{run.cancelRequestedAt && canCancel && <Badge variant='outline'>Cancelling</Badge>}
					</div>
				</TableCell>
				<TableCell>{webRobotTriggerLabel(run.trigger)}</TableCell>
				<TableCell>{formatDateTime(run.queuedAt)}</TableCell>
				<TableCell>{formatDuration(run.startedAt, run.completedAt)}</TableCell>
				<TableCell>{stats.itemsExtracted}</TableCell>
				<TableCell>
					<span
						className='text-xs text-muted-foreground'
						title={`${stats.productsAdded} added, ${stats.productsChanged} changed, ${stats.productsRemoved} removed, ${stats.productsUnchanged} unchanged`}
					>
						+{stats.productsAdded} · ~{stats.productsChanged} · −{stats.productsRemoved} · =
						{stats.productsUnchanged}
					</span>
				</TableCell>
				<TableCell>
					{runError ? (
						<span className='block max-w-52 truncate text-xs text-destructive' title={runError}>
							{runError}
						</span>
					) : (
						<span className='text-xs text-muted-foreground' title={warnings.join('\n')}>
							{stats.failedRequests + stats.extractionErrors || '—'}
							{warnings.length > 0
								? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
								: ''}
						</span>
					)}
				</TableCell>
				<TableCell>
					{run.artifactPrefix ? (
						<Button
							type='button'
							variant='ghost'
							size='sm'
							className='h-7 max-w-56 gap-1.5 px-1.5 font-mono text-xs'
							title={run.artifactPrefix}
							onClick={() => copy(run.artifactPrefix ?? '')}
						>
							{isCopied ? <Check className='size-3.5' /> : <Copy className='size-3.5' />}
							<span className='truncate'>{run.artifactPrefix}</span>
						</Button>
					) : (
						'—'
					)}
				</TableCell>
				<TableCell>
					<div className='flex items-center gap-1'>
						{canRepair && (
							<Button
								type='button'
								variant='ghost'
								size='sm'
								className='text-muted-foreground'
								isLoading={previewRepair.isPending}
								onClick={() => {
									setShowArtifacts(true);
									previewRepair.mutate({ id: robotId, runId: run.id });
								}}
							>
								<Wrench className='size-3.5' />
								Repair
							</Button>
						)}
						<Button
							type='button'
							variant='ghost'
							size='sm'
							className='text-muted-foreground'
							onClick={() => setShowArtifacts((current) => !current)}
						>
							<List className='size-3.5' />
							Details
						</Button>
						{canCancel && (
							<Button
								type='button'
								variant='ghost'
								size='sm'
								className='text-muted-foreground hover:text-destructive'
								disabled={isCancelling || Boolean(run.cancelRequestedAt)}
								isLoading={isCancelling}
								onClick={() => onCancelRun(run)}
							>
								<X className='size-3.5' />
								Cancel refresh
							</Button>
						)}
					</div>
				</TableCell>
			</TableRow>
			{showArtifacts && (
				<TableRow>
					<TableCell colSpan={9} className='bg-muted/10 p-0'>
						{(previewRepair.error || repairPreview || applyRepair.error) && (
							<div className='grid gap-3 border-b p-4 text-sm'>
								{previewRepair.error && <ErrorMessage message={previewRepair.error.message} />}
								{repairPreview && (
									<>
										<div className='flex flex-wrap items-center gap-2'>
											<Badge variant={repairPreview.status === 'ready' ? 'success' : 'outline'}>
												{repairPreview.status}
											</Badge>
											{'score' in repairPreview && (
												<span className='text-xs text-muted-foreground'>
													score {repairPreview.score}
												</span>
											)}
											<span className='text-xs text-muted-foreground'>
												{repairPreview.sourceUrl}
											</span>
										</div>
										{repairPreview.changes.length > 0 && (
											<div className='grid gap-1 text-xs text-muted-foreground'>
												{repairPreview.changes.map((change) => (
													<div
														key={`${change.kind}-${change.stageId ?? ''}-${change.message}`}
													>
														{change.message}
													</div>
												))}
											</div>
										)}
										{'reason' in repairPreview && (
											<div className='text-xs text-muted-foreground'>{repairPreview.reason}</div>
										)}
										{repairPreview.warnings.length > 0 && (
											<div className='grid gap-1 text-xs text-muted-foreground'>
												{repairPreview.warnings.slice(0, 5).map((warning) => (
													<div key={warning}>{warning}</div>
												))}
											</div>
										)}
										{repairConfiguration && (
											<Button
												type='button'
												variant='secondary'
												size='sm'
												className='justify-self-start'
												isLoading={applyRepair.isPending}
												onClick={async () => {
													await applyRepair.mutateAsync({
														id: robotId,
														expectedDefinitionHash: definitionHash,
														recipe: repairConfiguration.recipe,
														scope: repairConfiguration.scope,
														contract: repairConfiguration.contract,
														verificationPlan: repairConfiguration.verificationPlan,
														sourceAssessment: repairConfiguration.sourceAssessment,
														scopeEvidence: repairConfiguration.scopeEvidence,
														countSignals: repairConfiguration.countSignals,
													});
													await onRepairApplied();
												}}
											>
												Apply repair and retry
											</Button>
										)}
									</>
								)}
								{applyRepair.error && <ErrorMessage message={applyRepair.error.message} />}
							</div>
						)}
						{(trustSummary ||
							run.trustReportPath ||
							run.executionErrorMessage ||
							run.publicationErrorMessage) && (
							<div className='grid gap-2 border-b p-4 text-xs'>
								{trustSummary && (
									<>
										<div className='flex flex-wrap items-center gap-2'>
											<Badge
												variant={trustSummary.status === 'ready' ? 'success' : 'context_admin'}
											>
												{catalogueTrustStatusLabel(trustSummary.status)}
											</Badge>
											<span className='text-muted-foreground'>
												{trustSummary.entityCount}{' '}
												{catalogueGranularityLabel(trustSummary.granularity)} ·{' '}
												{catalogueTrustBasisLabel(trustSummary.basis)} · checked{' '}
												{formatDateTime(trustSummary.verifiedAt)}
											</span>
										</div>
										<div className='flex flex-wrap gap-2'>
											{(
												[
													['scope', 'Scope'],
													['records', 'Records'],
													['identity', 'Identity'],
													['semantics', 'Required product data'],
													['freshness', 'Freshness'],
												] as const
											).map(([key, label]) => {
												const dimension = trustSummary.dimensions[key];
												return (
													<Badge
														key={key}
														variant={
															dimension.status === 'passed'
																? 'success'
																: dimension.status === 'failed'
																	? 'destructive'
																	: 'outline'
														}
														title={dimension.reasons.join('\n')}
													>
														{label}: {dimension.status}
													</Badge>
												);
											})}
										</div>
										{trustSummary.requiredCoverage.length > 0 && (
											<div className='flex flex-wrap gap-2'>
												{trustSummary.requiredCoverage.map((metric) => (
													<Badge
														key={metric.concept}
														variant={
															metric.coverage >= metric.minimumCoverage
																? 'success'
																: 'destructive'
														}
													>
														{metric.concept} {Math.round(metric.coverage * 100)}% (min{' '}
														{Math.round(metric.minimumCoverage * 100)}%)
													</Badge>
												))}
											</div>
										)}
										{trustSummary.limitations.map((limitation) => (
											<div key={limitation} className='text-muted-foreground'>
												{limitation}
											</div>
										))}
										{trustSummary.blockerCodes.map((code) => (
											<div key={code} className='text-destructive'>
												{code}
											</div>
										))}
									</>
								)}
								{run.executionErrorMessage && (
									<div className='text-destructive'>{run.executionErrorMessage}</div>
								)}
								{run.publicationErrorMessage && (
									<div className='text-destructive'>{run.publicationErrorMessage}</div>
								)}
								{run.trustReportPath && (
									<div className='font-mono text-muted-foreground'>{run.trustReportPath}</div>
								)}
							</div>
						)}
						{(coverage.length > 0 || warnings.length > 0) && (
							<div className='grid gap-2 border-b p-4 text-xs'>
								{coverage.length > 0 && (
									<div className='flex flex-wrap gap-2'>
										{coverage.map(([field, value]) => (
											<Badge key={field} variant='outline'>
												{field}: {value}%
											</Badge>
										))}
									</div>
								)}
								{warnings.map((warning) => (
									<div key={warning} className='text-muted-foreground'>
										{warning}
									</div>
								))}
							</div>
						)}
						<WebSourceRunArtifacts runId={run.id} />
					</TableCell>
				</TableRow>
			)}
		</>
	);
}

function WebSourceRunArtifacts({ runId }: { runId: string }) {
	const artifacts = useQuery(trpc.webRobot.getRunArtifacts.queryOptions({ runId }));

	if (artifacts.isLoading) {
		return (
			<div className='flex items-center gap-2 p-4 text-sm text-muted-foreground'>
				<Spinner /> Loading artifacts…
			</div>
		);
	}
	if (artifacts.error) {
		return <ErrorMessage message={artifacts.error.message} />;
	}
	if (!artifacts.data || artifacts.data.files.length === 0) {
		return <div className='p-4 text-sm text-muted-foreground'>No artifact files for this run.</div>;
	}

	const manifest = artifacts.data.manifest as {
		counts?: { products?: number; attributes?: number; documents?: number; changes?: number };
		trust?: {
			trustSummary?: WebRobotRun['trustSummary'];
			trustReportHash?: string;
			trustReportPath?: string;
			traversalStepsPath?: string;
		};
	} | null;
	const manifestSummary = manifest?.trust?.trustSummary;
	return (
		<div className='grid gap-3 p-4'>
			{manifest && (
				<div className='flex flex-wrap items-center gap-2 text-xs'>
					{manifestSummary && (
						<>
							<Badge variant={manifestSummary.status === 'ready' ? 'success' : 'context_admin'}>
								{catalogueTrustStatusLabel(manifestSummary.status)}
							</Badge>
							<span className='text-muted-foreground'>
								{manifestSummary.entityCount} {catalogueGranularityLabel(manifestSummary.granularity)} ·{' '}
								{catalogueTrustBasisLabel(manifestSummary.basis)}
							</span>
						</>
					)}
					{manifest.counts && (
						<span className='text-muted-foreground'>
							{manifest.counts.products} products · {manifest.counts.attributes} attributes ·{' '}
							{manifest.counts.documents} documents · {manifest.counts.changes} changes
						</span>
					)}
					{manifest.trust?.trustReportPath && (
						<span className='font-mono text-muted-foreground'>{manifest.trust.trustReportPath}</span>
					)}
				</div>
			)}
			<div className='grid gap-1 font-mono text-xs'>
				{artifacts.data.files.map((file) => (
					<div key={file.relativePath} className='flex justify-between gap-4'>
						<span className='truncate'>{file.path}</span>
						<span className='shrink-0 text-muted-foreground'>{file.size ?? '—'} B</span>
					</div>
				))}
			</div>
		</div>
	);
}
