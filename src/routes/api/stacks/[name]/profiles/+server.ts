import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { parseEnvParam } from '$lib/server/env-param';
import { getStackSource, setStackProfiles } from '$lib/server/db';
import { getStackComposeFile } from '$lib/server/stacks';
import { normalizeProfileSelection, parseDeclaredProfiles } from '$lib/utils/compose-profiles';

/**
 * @openapi
 * summary: Get a stack's compose profiles - the ones selected to be active and the ones its compose file declares
 * description: `profiles` is the stored selection, applied to every compose command Dockhand runs for the stack. `declared` lists the profile names found on services in the stack's compose file (empty when the file is not available locally). `managed` is false until a profile has been selected for the stack at least once; an unmanaged stack is run exactly as compose would run it on its own.
 * path: name:string! Stack name
 * query: env:integer Environment id the stack belongs to
 * resp-200: {profiles:array<string>!, declared:array<string>!, managed:boolean!}
 * resp-200-example: {"profiles":["cron"],"declared":["cron","debug"],"managed":true}
 * resp-403: Permission denied (needs stacks:view)
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnvParam(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('stacks', 'view', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envId);
	if (envAccessDenied) return envAccessDenied;

	const source = await getStackSource(params.name, envId);
	const compose = await getStackComposeFile(params.name, envId);
	return json({
		profiles: source?.profiles ?? [],
		declared: compose.success && compose.content ? parseDeclaredProfiles(compose.content) : [],
		managed: source?.profiles != null
	});
};

/**
 * @openapi
 * summary: Set which compose profiles are active for a stack (takes effect on the next deploy)
 * description: Stores the selection without touching running containers. The next deploy starts the services of the selected profiles and removes the containers of services whose profile is no longer selected. Names do not have to be declared in the current compose file. An empty array clears the selection, leaving compose on its own default (COMPOSE_PROFILES from the stack's env file, if set).
 * path: name:string! Stack name
 * query: env:integer Environment id the stack belongs to
 * body: {profiles:array<string>!}
 * body-example: {"profiles":["cron"]}
 * resp-200: {profiles:array<string>!}
 * resp-200-example: {"profiles":["cron"]}
 * resp-400: profiles is missing, not an array of strings, or contains a malformed profile name
 * resp-403: Permission denied (needs stacks:edit)
 * resp-404: Stack is not tracked by Dockhand
 */
export const PUT: RequestHandler = async ({ params, url, request, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnvParam(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envId);
	if (envAccessDenied) return envAccessDenied;

	const body = await request.json().catch(() => ({}));
	const selection = normalizeProfileSelection(body?.profiles);
	if (!selection.ok) {
		return json({ error: selection.error }, { status: 400 });
	}

	const stored = await setStackProfiles(params.name, envId, selection.profiles);
	if (stored === undefined) {
		return json({ error: `Stack "${params.name}" is not tracked by Dockhand` }, { status: 404 });
	}
	return json({ profiles: stored ?? [] });
};
