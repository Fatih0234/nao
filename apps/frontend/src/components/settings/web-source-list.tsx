import { Link } from '@tanstack/react-router';
import { Archive, Play, Plus } from 'lucide-react';
import { useState } from 'react';

import type { WebRobotListItem } from '@/components/settings/web-source-recipe';
import {
	catalogueExecutionLabel,
	catalogueGranularityLabel,
	cataloguePublicationStatusLabel,
	catalogueTrustBasisLabel,
	catalogueTrustPresentation,
	catalogueTrustStatusLabel,
	formatDateTime,
	isActiveWebRobotRun,
	webSourcePrimaryActionLabel,
} from '@/components/settings/web-source-recipe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Empty } from '@/components/ui/empty';
import { SettingsCard } from '@/components/ui/settings-card';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function WebSourceList({
	robots,
	onRunNow,
	onSetEnabled,
	onArchive,
	runningRobotId,
	archivingRobotId,
	archiveError,
}: {
	robots: WebRobotListItem[];
	onRunNow: (robot: WebRobotListItem) => void;
	onSetEnabled: (robot: WebRobotListItem, enabled: boolean) => void;
	onArchive: (robot: WebRobotListItem) => Promise<void>;
	runningRobotId?: string | null;
	archivingRobotId?: string | null;
	archiveError?: string | null;
}) {
	const [archiveTarget, setArchiveTarget] = useState<WebRobotListItem | null>(null);

	return (
		<>
			<SettingsCard
				title='Web sources'
				description='Deterministic catalogue robots that publish queryable product datasets.'
				action={
					<Button asChild size='sm'>
						<Link to='/settings/web-sources/new'>
							<Plus className='size-3.5' />
							New source
						</Link>
					</Button>
				}
				flush
			>
				{robots.length === 0 ? (
					<Empty className='p-10'>
						No web sources yet. Create one to publish a product catalogue dataset.
					</Empty>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Source and scope</TableHead>
								<TableHead>Data status</TableHead>
								<TableHead>Active data</TableHead>
								<TableHead>Latest refresh</TableHead>
								<TableHead>Schedule</TableHead>
								<TableHead className='w-0'>Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{robots.map((robot) => (
								<WebSourceRow
									key={robot.id}
									robot={robot}
									onRunNow={onRunNow}
									onSetEnabled={onSetEnabled}
									onArchive={() => setArchiveTarget(robot)}
									isRunning={runningRobotId === robot.id}
								/>
							))}
						</TableBody>
					</Table>
				)}
			</SettingsCard>

			<ConfirmationDialog
				open={archiveTarget !== null}
				onOpenChange={(open) => !open && setArchiveTarget(null)}
				title={`Archive ${archiveTarget?.name ?? 'web source'}?`}
				description='This disables its schedule and hides it from the list. Generated dataset files are preserved.'
				confirmLabel='Archive'
				isPending={Boolean(archivingRobotId)}
				error={archiveError ?? undefined}
				onConfirm={async () => {
					if (!archiveTarget) {
						return;
					}
					try {
						await onArchive(archiveTarget);
						setArchiveTarget(null);
					} catch {
						return;
					}
				}}
			/>
		</>
	);
}

function WebSourceRow({
	robot,
	onRunNow,
	onSetEnabled,
	onArchive,
	isRunning,
}: {
	robot: WebRobotListItem;
	onRunNow: (robot: WebRobotListItem) => void;
	onSetEnabled: (robot: WebRobotListItem, enabled: boolean) => void;
	onArchive: () => void;
	isRunning: boolean;
}) {
	const active = isActiveWebRobotRun(robot.lastRunStatus);
	const state = robot.currentState;
	const hasPendingConfiguration = Boolean(robot.pendingConfigurationId);
	const trust = catalogueTrustPresentation(state, { hasPendingConfiguration });
	const primaryActionLabel = webSourcePrimaryActionLabel({
		state,
		hasPendingConfiguration,
		isActionPending: active || isRunning,
	});
	const activeSummary = state.activeSummary;
	const published = Boolean(robot.lastPublishedRunId);
	const nextRun =
		published && robot.enabled && robot.scheduledJob?.runAt ? formatDateTime(robot.scheduledJob.runAt) : null;

	return (
		<TableRow>
			<TableCell>
				<Link
					to='/settings/web-sources/$robotId'
					params={{ robotId: robot.id }}
					className='block max-w-72 min-w-0 hover:underline'
				>
					<div className='truncate font-medium'>{robot.name}</div>
					<div className='truncate text-xs text-muted-foreground'>{robot.slug}</div>
					<div className='truncate text-xs text-muted-foreground'>
						{activeSummary?.scopeLabel ?? 'Awaiting successful first refresh'}
					</div>
				</Link>
			</TableCell>
			<TableCell>
				<Badge variant={trust.variant}>{trust.label}</Badge>
			</TableCell>
			<TableCell>
				{activeSummary ? (
					<div className='grid gap-0.5'>
						<span className='text-sm'>
							{activeSummary.entityCount} {catalogueGranularityLabel(activeSummary.granularity)}
						</span>
						<span className='text-xs text-muted-foreground'>
							{catalogueTrustBasisLabel(activeSummary.basis)} · {formatDateTime(activeSummary.verifiedAt)}
						</span>
					</div>
				) : (
					<span className='text-xs text-muted-foreground'>Not available to agents</span>
				)}
			</TableCell>
			<TableCell>
				<div className='grid gap-1'>
					<div className='flex flex-wrap gap-1'>
						{state.executionStatus && (
							<Badge variant='outline'>{catalogueExecutionLabel(state.executionStatus)}</Badge>
						)}
						{state.trustStatus && (
							<Badge variant='outline'>{catalogueTrustStatusLabel(state.trustStatus)}</Badge>
						)}
						{state.publicationStatus && (
							<Badge variant='outline'>{cataloguePublicationStatusLabel(state.publicationStatus)}</Badge>
						)}
					</div>
					<span className='text-xs text-muted-foreground'>{formatDateTime(robot.lastRunStartedAt)}</span>
				</div>
			</TableCell>
			<TableCell>
				{published ? (
					<div className='grid gap-1'>
						<div className='flex items-center gap-2'>
							<Switch
								checked={robot.enabled}
								disabled={!robot.cron}
								onCheckedChange={(enabled) => onSetEnabled(robot, enabled)}
							/>
							<span className='font-mono text-xs'>{robot.cron || 'Manual'}</span>
						</div>
						{nextRun && <span className='text-xs text-muted-foreground'>Next: {nextRun}</span>}
					</div>
				) : (
					<span className='text-xs text-muted-foreground'>Available after the first successful refresh</span>
				)}
			</TableCell>
			<TableCell>
				<div className='flex justify-end gap-1'>
					{primaryActionLabel && (
						<Button
							type='button'
							variant='ghost'
							size='sm'
							disabled={active || isRunning || state.setupStatus !== 'configured'}
							isLoading={isRunning}
							onClick={() => onRunNow(robot)}
						>
							<Play className='size-3.5' />
							{primaryActionLabel}
						</Button>
					)}
					<Button type='button' variant='ghost' size='sm' onClick={onArchive}>
						<Archive className='size-3.5' />
						Archive
					</Button>
				</div>
			</TableCell>
		</TableRow>
	);
}
