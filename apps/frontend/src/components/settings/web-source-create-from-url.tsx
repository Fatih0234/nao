import { useMutation } from '@tanstack/react-query';
import { Plus, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { catalogueConceptLabels } from '@nao/shared/web-robot-trust';
import type { WebRobotRecipe } from '@nao/shared/web-robot';

import type { WebRobotAnalysisResult, WebSourceKnowledgeConcept } from '@/components/settings/web-source-recipe';
import {
	catalogueGranularityLabel,
	conceptCapabilityDetail,
	conceptCapabilityFor,
	conceptCapabilityLabel,
	conceptCapabilityVariant,
	DEFAULT_WEB_SOURCE_KNOWLEDGE_CONCEPTS,
	evidenceBasedDefaultConcepts,
	WEB_SOURCE_KNOWLEDGE_CONCEPTS,
} from '@/components/settings/web-source-recipe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ErrorMessage } from '@/components/ui/error-message';
import { Input } from '@/components/ui/input';
import { SettingsCard } from '@/components/ui/settings-card';
import { trpc } from '@/main';

type WebSourceCreateFromUrlProps = {
	onCreated: (robotId: string) => void;
	onPrefillRecipe: (recipe: WebRobotRecipe, title?: string) => void;
};

export function WebSourceCreateFromUrl({ onCreated, onPrefillRecipe }: WebSourceCreateFromUrlProps) {
	const [url, setUrl] = useState('');
	const [scopeConfirmed, setScopeConfirmed] = useState(false);
	const [selectedConcepts, setSelectedConcepts] = useState<WebSourceKnowledgeConcept[]>([
		...DEFAULT_WEB_SOURCE_KNOWLEDGE_CONCEPTS,
	]);
	const analyze = useMutation(trpc.webRobot.analyzeUrl.mutationOptions());
	const verify = useMutation(
		trpc.webRobot.createFromUrl.mutationOptions({
			onSuccess: (result) => {
				if (result.status === 'created') {
					onCreated(result.robot.id);
				}
			},
		}),
	);

	const analysis = analyze.data;
	const verifyResult = verify.data;

	useEffect(() => {
		if (analysis?.status === 'ready' || analysis?.status === 'partial') {
			setSelectedConcepts(evidenceBasedDefaultConcepts(analysis.capabilities));
		}
	}, [analysis]);

	const handleUrlChange = (value: string) => {
		setUrl(value);
		setScopeConfirmed(false);
		setSelectedConcepts([...DEFAULT_WEB_SOURCE_KNOWLEDGE_CONCEPTS]);
		analyze.reset();
		verify.reset();
	};

	const handleAnalyze = () => {
		setScopeConfirmed(false);
		verify.reset();
		analyze.mutate({ url: url.trim() });
	};

	const handleToggleConcept = (concept: WebSourceKnowledgeConcept, checked: boolean) => {
		setSelectedConcepts((current) =>
			checked ? [...new Set([...current, concept])] : current.filter((value) => value !== concept),
		);
	};

	return (
		<SettingsCard
			title='Add a product catalogue'
			description='Paste a public catalogue URL. nao analyses its scope and completeness evidence first — nothing is published during analysis.'
		>
			<label className='grid gap-1.5 text-sm'>
				<span className='text-xs font-medium text-muted-foreground'>Catalogue URL</span>
				<div className='flex gap-2'>
					<Input
						type='url'
						value={url}
						onChange={(event) => handleUrlChange(event.target.value)}
						placeholder='https://example.com/products'
						disabled={analyze.isPending || verify.isPending}
					/>
					<Button
						type='button'
						variant='secondary'
						disabled={!url.trim() || analyze.isPending || verify.isPending}
						isLoading={analyze.isPending}
						onClick={handleAnalyze}
					>
						<Sparkles className='size-3.5' />
						Analyze source
					</Button>
				</div>
			</label>

			{analyze.error && <ErrorMessage message={analyze.error.message} />}

			{analysis?.status === 'ready' && (
				<AnalysisReview
					analysis={analysis}
					scopeConfirmed={scopeConfirmed}
					onScopeConfirmedChange={setScopeConfirmed}
					selectedConcepts={selectedConcepts}
					onToggleConcept={handleToggleConcept}
				/>
			)}

			{analysis && analysis.status !== 'ready' && (
				<AnalysisDiagnostic result={analysis} onPrefillRecipe={onPrefillRecipe} />
			)}

			{verify.isPending && (
				<div className='grid gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm'>
					<span className='font-medium'>Creating source and starting first refresh…</span>
					<span className='text-muted-foreground'>
						nao is preparing the source. The first full refresh continues after creation.
					</span>
				</div>
			)}
			{verify.error && <ErrorMessage message={verify.error.message} />}
			{verifyResult && verifyResult.status !== 'created' && (
				<AnalysisDiagnostic result={verifyResult} onPrefillRecipe={onPrefillRecipe} />
			)}

			{analysis?.status === 'ready' && (
				<div className='flex items-center justify-between gap-3'>
					<p className='text-xs text-muted-foreground'>
						Creates the source and starts its first full refresh. Data becomes available to agents only
						after the quality checks pass.
					</p>
					<Button
						type='button'
						disabled={!scopeConfirmed || verify.isPending}
						isLoading={verify.isPending}
						onClick={() =>
							verify.mutate({
								url: url.trim(),
								confirmedScope: analysis.scope,
								requiredConcepts: selectedConcepts,
							})
						}
					>
						<Plus className='size-3.5' />
						Create source
					</Button>
				</div>
			)}
		</SettingsCard>
	);
}

function AnalysisReview({
	analysis,
	scopeConfirmed,
	onScopeConfirmedChange,
	selectedConcepts,
	onToggleConcept,
}: {
	analysis: Extract<WebRobotAnalysisResult, { status: 'ready' }>;
	scopeConfirmed: boolean;
	onScopeConfirmedChange: (confirmed: boolean) => void;
	selectedConcepts: WebSourceKnowledgeConcept[];
	onToggleConcept: (concept: WebSourceKnowledgeConcept, checked: boolean) => void;
}) {
	const { scope, contract, sourceAssessment, countSignals, sampleProducts } = analysis;
	const decisions = sourceAssessment.slice(0, 4);
	const signals = countSignals.filter((signal) => signal.reliability !== 'weak').slice(0, 4);
	const activeFilters = Object.entries(scope.activeFilters);

	return (
		<div className='grid gap-6 rounded-md border p-4'>
			<div className='grid gap-3'>
				<div className='flex items-center gap-2'>
					<h3 className='text-sm font-medium'>1. Confirm catalogue scope</h3>
					<Badge variant='secondary'>Scope ready</Badge>
				</div>
				<div className='grid gap-1 text-sm'>
					<span className='font-medium'>{scope.label}</span>
					<span className='break-all text-xs text-muted-foreground'>{scope.entryUrl}</span>
					<span className='text-xs text-muted-foreground'>
						{catalogueGranularityLabel(contract.entityGranularity)} · {scope.includedUrls.length} included
						route{scope.includedUrls.length === 1 ? '' : 's'}
						{scope.searchTerm ? ` · search “${scope.searchTerm}”` : ''}
						{scope.locale ? ` · ${scope.locale}` : ''}
					</span>
					{activeFilters.length > 0 && (
						<span className='text-xs text-muted-foreground'>
							Filters:{' '}
							{activeFilters
								.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(', ') : value}`)
								.join(' · ')}
						</span>
					)}
				</div>
				<div className='grid gap-0.5'>
					{scope.includedUrls.map((includedUrl) => (
						<span key={includedUrl} className='break-all font-mono text-xs text-muted-foreground'>
							{includedUrl}
						</span>
					))}
				</div>
				{signals.length > 0 && (
					<div className='flex flex-wrap gap-2'>
						{signals.map((signal) => (
							<Badge key={signal.id} variant='outline'>
								{signal.value} {catalogueGranularityLabel(signal.unit)} ({signal.source})
							</Badge>
						))}
					</div>
				)}
				{decisions.length > 0 && (
					<div className='grid gap-1 text-xs text-muted-foreground'>
						{decisions.map((decision) => (
							<div key={decision.candidateId}>
								{decision.role} · {decision.relation}
							</div>
						))}
					</div>
				)}
				{sampleProducts.length > 0 && (
					<div className='grid gap-1.5'>
						{sampleProducts.slice(0, 5).map((product, index) => (
							<SampleProduct key={index} product={product} />
						))}
					</div>
				)}
				<label className='flex items-start gap-2 rounded-md border bg-muted/20 p-3 text-sm'>
					<Checkbox
						checked={scopeConfirmed}
						onCheckedChange={(checked) => onScopeConfirmedChange(checked === true)}
					/>
					<span>This is the catalogue scope I intend to publish.</span>
				</label>
			</div>

			<div className='grid gap-3'>
				<h3 className='text-sm font-medium'>2. Choose quality requirements</h3>
				<p className='text-xs text-muted-foreground'>
					Name, source URL, and stable identity must be present for every product. Selected requirements must
					be present for at least 95% of products.
				</p>
				<ConceptWarnings analysis={analysis} selectedConcepts={selectedConcepts} />
				<div className='grid gap-2 sm:grid-cols-2'>
					{WEB_SOURCE_KNOWLEDGE_CONCEPTS.map((concept) => {
						const capability = conceptCapabilityFor(analysis.capabilities, concept.value);
						const selected = selectedConcepts.includes(concept.value);
						return (
							<label key={concept.value} className='flex items-start gap-2 rounded-md border p-3 text-sm'>
								<Checkbox
									checked={selected}
									onCheckedChange={(checked) => onToggleConcept(concept.value, checked === true)}
								/>
								<span className='grid gap-0.5'>
									<span className='flex flex-wrap items-center gap-2'>
										{concept.label}
										{capability && (
											<Badge variant={conceptCapabilityVariant(capability, selected)}>
												{conceptCapabilityLabel(capability)}
											</Badge>
										)}
									</span>
									<span className='text-xs text-muted-foreground'>{concept.description}</span>
									{capability && (
										<span className='text-xs text-muted-foreground'>
											{conceptCapabilityDetail(capability)}
										</span>
									)}
								</span>
							</label>
						);
					})}
				</div>
			</div>
		</div>
	);
}

function ConceptWarnings({
	analysis,
	selectedConcepts,
}: {
	analysis: Extract<WebRobotAnalysisResult, { status: 'ready' | 'partial' }>;
	selectedConcepts: WebSourceKnowledgeConcept[];
}) {
	const baseUndetected = (['name', 'source_url', 'stable_identity'] as const).filter(
		(concept) => conceptCapabilityFor(analysis.capabilities, concept)?.status === 'not_detected',
	);
	const selectedUndetected = selectedConcepts.filter(
		(concept) => conceptCapabilityFor(analysis.capabilities, concept)?.status === 'not_detected',
	);
	if (baseUndetected.length === 0 && selectedUndetected.length === 0) {
		return null;
	}
	return (
		<div className='grid gap-2'>
			{baseUndetected.length > 0 && (
				<p className='rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground'>
					The analysed sample did not contain{' '}
					{baseUndetected.map((concept) => catalogueConceptLabels[concept]).join(', ')}. These are required
					for every product — the first refresh may fail.
				</p>
			)}
			{selectedUndetected.length > 0 && (
				<p className='rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground'>
					{selectedUndetected.map((concept) => catalogueConceptLabels[concept]).join(', ')}{' '}
					{selectedUndetected.length === 1 ? 'was' : 'were'} not found in the analysed sample. Requiring{' '}
					{selectedUndetected.length === 1 ? 'it' : 'them'} may block the first refresh.
				</p>
			)}
		</div>
	);
}

function SampleProduct({ product }: { product: Record<string, unknown> }) {
	const name = scalarText(product.name) ?? scalarText(product.title) ?? scalarText(product.sku) ?? 'Product';
	const sku = scalarText(product.sku);
	const brand = scalarText(product.brand);
	const price = scalarText(product.price);
	const currency = scalarText(product.currency);
	const sourceUrl = scalarText(product.source_url) ?? scalarText(product.canonical_url);
	return (
		<div className='grid gap-0.5 rounded-md border bg-muted/20 p-2 text-xs'>
			<span className='truncate font-medium'>{name}</span>
			<span className='truncate text-muted-foreground'>
				{[sku && `SKU ${sku}`, brand, price && `${price}${currency ? ` ${currency}` : ''}`]
					.filter(Boolean)
					.join(' · ')}
			</span>
			{sourceUrl && <span className='truncate text-muted-foreground'>{sourceUrl}</span>}
		</div>
	);
}

const scalarText = (value: unknown): string | undefined => {
	if (typeof value === 'string' && value.trim()) {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
};

function AnalysisDiagnostic({
	result,
	onPrefillRecipe,
}: {
	result: Exclude<WebRobotAnalysisResult, { status: 'ready' }>;
	onPrefillRecipe: (recipe: WebRobotRecipe, title?: string) => void;
}) {
	const label =
		result.status === 'rejected'
			? 'Could not analyze this catalogue'
			: result.status === 'interactive_needed'
				? 'Interaction required'
				: result.status === 'rate_limited'
					? 'Analysis temporarily rate limited'
					: 'Partial evidence only';
	const tone =
		result.status === 'rate_limited'
			? 'border-amber-500/30 bg-amber-500/5'
			: 'border-destructive/30 bg-destructive/5';
	return (
		<div className={`grid gap-3 rounded-md border p-3 ${tone}`}>
			<div className='grid gap-1'>
				<Badge
					variant={result.status === 'rejected' ? 'destructive' : 'context_admin'}
					className='justify-self-start'
				>
					{label}
				</Badge>
				<p className='text-sm'>No source was created.</p>
				<p className='text-xs text-muted-foreground'>{result.reason}</p>
			</div>
			{result.diagnostics.discovery.blockers.length > 0 && (
				<div className='grid gap-1 text-xs text-muted-foreground'>
					{result.diagnostics.discovery.blockers.map((blocker) => (
						<div key={`${blocker.loader}-${blocker.kind}-${blocker.status ?? ''}`}>
							{blocker.kind}: {blocker.message}
						</div>
					))}
				</div>
			)}
			{result.warnings.length > 0 && (
				<div className='grid gap-1 text-xs text-muted-foreground'>
					{result.warnings.slice(0, 5).map((warning) => (
						<div key={warning}>{warning}</div>
					))}
				</div>
			)}
			{result.recipe && (
				<Button
					type='button'
					variant='secondary'
					size='sm'
					className='justify-self-start'
					onClick={() => onPrefillRecipe(result.recipe!, result.diagnostics.discovery.title)}
				>
					Open generated recipe in Advanced
				</Button>
			)}
		</div>
	);
}
