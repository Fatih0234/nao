import { useMutation } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import type { WebRobotRecipe } from '@nao/shared/web-robot';

import type { WebSourceFormInitial, WebSourceFormSubmit } from '@/components/settings/web-source-recipe';
import { WebSourceCreateFromUrl } from '@/components/settings/web-source-create-from-url';
import { WebSourceForm } from '@/components/settings/web-source-form';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { trpc } from '@/main';

export const Route = createFileRoute('/_sidebar-layout/settings/web-sources/new')({
	component: NewWebSourcePage,
});

function NewWebSourcePage() {
	const navigate = useNavigate();
	const create = useMutation(trpc.webRobot.create.mutationOptions());
	const [initial, setInitial] = useState<WebSourceFormInitial>();
	const [formKey, setFormKey] = useState(0);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [advanced, setAdvanced] = useState<string[]>([]);

	const handleSubmit = async (input: WebSourceFormSubmit) => {
		setSubmitError(null);
		try {
			const robot = await create.mutateAsync(input);
			await navigate({ to: '/settings/web-sources/$robotId', params: { robotId: robot.id } });
		} catch (error) {
			setSubmitError(error instanceof Error ? error.message : String(error));
		}
	};

	const handlePrefillRecipe = (recipe: WebRobotRecipe, title?: string) => {
		setInitial({ name: title ? `${title} products` : '', recipe, cron: '', enabled: false });
		setFormKey((key) => key + 1);
		setAdvanced(['advanced']);
	};

	return (
		<div className='flex flex-col gap-6'>
			<WebSourceCreateFromUrl
				onCreated={(robotId) => void navigate({ to: '/settings/web-sources/$robotId', params: { robotId } })}
				onPrefillRecipe={handlePrefillRecipe}
			/>
			<Accordion type='multiple' value={advanced} onValueChange={setAdvanced} className='rounded-md border'>
				<AccordionItem value='advanced' className='border-b-0'>
					<AccordionTrigger className='px-4'>
						<span className='grid gap-0.5'>
							<span>Advanced setup</span>
							<span className='text-xs font-normal text-muted-foreground'>
								Configure a technical recipe manually
							</span>
						</span>
					</AccordionTrigger>
					<AccordionContent className='px-4'>
						<WebSourceForm
							key={formKey}
							isCreate
							initial={initial}
							submitLabel='Create web source'
							isPending={create.isPending}
							submitError={submitError}
							scheduleLocked
							onSubmit={handleSubmit}
						/>
					</AccordionContent>
				</AccordionItem>
			</Accordion>
		</div>
	);
}
