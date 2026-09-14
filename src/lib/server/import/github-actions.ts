export interface GithubActionsConfig {
	owner: string;
	repo: string;
	workflowFileName: string;
	token: string;
}

export interface DispatchImportWorkflowInput {
	jobId: string;
	userId: string;
	sourceUrl: string;
}

/**
 * Triggers the import workflow via GitHub's workflow_dispatch API. The
 * workflow reports progress back via POST /api/import/[jobId]/events
 * (HMAC-authenticated — see webhook-auth.ts), not through this call's
 * response, since workflow_dispatch itself has no return value beyond
 * "accepted" (GitHub queues the run asynchronously).
 */
export async function dispatchImportWorkflow(config: GithubActionsConfig, input: DispatchImportWorkflowInput): Promise<void> {
	const url = `https://api.github.com/repos/${config.owner}/${config.repo}/actions/workflows/${config.workflowFileName}/dispatches`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'cf-music-worker',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			ref: 'main',
			inputs: {
				job_id: input.jobId,
				user_id: input.userId,
				source_url: input.sourceUrl
			}
		})
	});

	if (!response.ok) {
		throw new Error(`Failed to dispatch import workflow: ${response.status} ${response.statusText}`);
	}
}
