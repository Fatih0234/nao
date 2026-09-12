import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { catalogueGranularityLabel } from '@/components/settings/web-source-recipe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ErrorMessage } from '@/components/ui/error-message';
import { SettingsCard } from '@/components/ui/settings-card';
import { trpc } from '@/main';

export function WebSourceReverification({
	robotId,
	definitionHash,
	onApplied,
}: {
	robotId: string;
	definitionHash: string;
	onApplied: () => Promise<void>;
}) {
	const [scopeConfirmed, setScopeConfirmed] = useState(false);
	const preview = useMutation(trpc.webRobot.previewRepair.mutationOptions());
	const apply = useMutation(trpc.webRobot.applyRepair.mutationOptions());
	const result = preview.data;
	const applicable = result && 'scope' in result && 'recipe' in result && result.recipe ? result : undefined;

	const handleAnalyze = () => {
		setScopeConfirmed(false);
		apply.reset();
		preview.mutate({ id: robotId });
	};

	return (
		<SettingsCard
			title='Complete setup'
			description='Analyze this source to define its scope and quality requirements before the first refresh.'
			action={
				<Button
					type='button'
					size='sm'
					variant='secondary'
					isLoading={preview.isPending}
					onClick={handleAnalyze}
				>
					Analyze source
				</Button>
			}
		>
			{preview.error && <ErrorMessage message={preview.error.message} />}
			{result && (
				<div className='grid gap-3'>
					<div className='flex flex-wrap items-center gap-2'>
						<Badge variant={result.status === 'ready' ? 'success' : 'outline'}>{result.status}</Badge>
						<span className='text-xs text-muted-foreground'>{result.sourceUrl}</span>
					</div>
					{'reason' in result && <p className='text-sm text-muted-foreground'>{result.reason}</p>}
					{result.warnings.length > 0 && (
						<div className='grid gap-1 text-xs text-muted-foreground'>
							{result.warnings.slice(0, 5).map((warning) => (
								<div key={warning}>{warning}</div>
							))}
						</div>
					)}
					{applicable && (
						<>
							<div className='grid gap-1 rounded-md border p-3 text-sm'>
								<span className='font-medium'>{applicable.scope.label}</span>
								<span className='break-all text-xs text-muted-foreground'>
									{applicable.scope.entryUrl}
								</span>
								<span className='text-xs text-muted-foreground'>
									{catalogueGranularityLabel(applicable.contract.entityGranularity)}
								</span>
							</div>
							{applicable.sampleProducts.length > 0 && (
								<div className='grid gap-1.5'>
									{applicable.sampleProducts.slice(0, 5).map((product, index) => (
										<span key={index} className='truncate text-xs text-muted-foreground'>
											{productName(product)}
										</span>
									))}
								</div>
							)}
							<label className='flex items-start gap-2 rounded-md border bg-muted/20 p-3 text-sm'>
								<Checkbox
									checked={scopeConfirmed}
									onCheckedChange={(checked) => setScopeConfirmed(checked === true)}
								/>
								<span>This is the catalogue scope I intend to publish.</span>
							</label>
							<Button
								type='button'
								size='sm'
								className='justify-self-start'
								disabled={!scopeConfirmed}
								isLoading={apply.isPending}
								onClick={async () => {
									await apply.mutateAsync({
										id: robotId,
										expectedDefinitionHash: definitionHash,
										recipe: applicable.recipe,
										scope: applicable.scope,
										contract: applicable.contract,
										verificationPlan: applicable.verificationPlan,
										sourceAssessment: applicable.sourceAssessment,
										scopeEvidence: applicable.scopeEvidence,
										countSignals: applicable.countSignals,
									});
									await onApplied();
								}}
							>
								Save and start first refresh
							</Button>
						</>
					)}
					{apply.error && <ErrorMessage message={apply.error.message} />}
				</div>
			)}
		</SettingsCard>
	);
}

const productName = (product: Record<string, unknown>): string => {
	for (const key of ['name', 'title', 'sku']) {
		const value = product[key];
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
		if (typeof value === 'number' && Number.isFinite(value)) {
			return String(value);
		}
	}
	return 'Product';
};
