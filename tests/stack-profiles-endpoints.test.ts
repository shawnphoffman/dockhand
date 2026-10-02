/**
 * Route tests for compose profile selection:
 *   - GET/PUT /api/stacks/[name]/profiles (the dedicated endpoint)
 *   - the `profiles` field on GET/PUT /api/stacks/[name]/compose
 *
 * What matters here is the contract around the stored selection, not compose itself:
 * a bad name is rejected before anything is written, an omitted field leaves the
 * selection alone, and on Save & redeploy the selection is stored BEFORE the deploy
 * starts (every compose command reads it from the database, so storing it afterwards
 * would deploy with the previous selection).
 *
 * $lib/server/db, $lib/server/authorize and $lib/server/stacks are faked through the
 * shared helpers - see tests/helpers/db-fake.ts for why a direct mock.module() call
 * in this file would collide with the other route tests.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDbFake } from './helpers/db-fake';
import { registerAuthorizeFake } from './helpers/authorize-fake';
import { registerStacksFake } from './helpers/stacks-fake';
import { nextStoredProfiles } from '../src/lib/utils/compose-profiles';

const STACK = 'demo-stack';
const COMPOSE = 'services:\n  app:\n    image: demo:1\n  cron:\n    image: demo:1\n    profiles: [cron]\n  mcp:\n    image: demo:1\n    profiles: [mcp]\n';

// -- $lib/server/authorize ---------------------------------------------------

let authState: { authEnabled: boolean; canView: boolean; canEdit: boolean; envAllowed: boolean };
let canCalls: Array<{ resource: string; action: string; environmentId?: number }>;

registerAuthorizeFake(async () => ({
	authEnabled: authState.authEnabled,
	isAuthenticated: true,
	isEnterprise: false,
	can: async (resource: string, action: string, environmentId?: number) => {
		canCalls.push({ resource, action, environmentId });
		return action === 'view' ? authState.canView : authState.canEdit;
	},
	canAccessEnvironment: async () => authState.envAllowed,
	requireEnvAccess: async (environmentId: number | null | undefined) =>
		!authState.authEnabled || environmentId == null || authState.envAllowed
			? null
			: new Response(JSON.stringify({ error: 'Access denied to this environment' }), { status: 403 })
}));

// -- $lib/server/db: one stack_sources row, keyed by env ----------------------

/** The stored selection per `${name}|${envId}`; a missing key means "no source row". */
let rows: Map<string, string[] | null>;
/** Order of side effects, to assert the selection is stored before the deploy. */
let events: string[];

const key = (name: string, envId: number | null | undefined) => `${name}|${envId ?? 'null'}`;

registerDbFake('getStackSource', async (name: string, envId?: number | null) =>
	rows.has(key(name, envId)) ? { stackName: name, profiles: rows.get(key(name, envId)) } : null
);
registerDbFake('getStackProfiles', async (name: string, envId?: number | null) =>
	rows.get(key(name, envId)) ?? null
);
// Mirrors the real setter: no row -> undefined, otherwise the tri-state rule.
registerDbFake('setStackProfiles', async (name: string, envId: number | null | undefined, profiles: string[]) => {
	const k = key(name, envId);
	if (!rows.has(k)) return undefined;
	const next = nextStoredProfiles(rows.get(k) ?? null, profiles);
	rows.set(k, next);
	events.push(`setProfiles:${JSON.stringify(profiles)}`);
	return next;
});
registerDbFake('createScheduleExecution', async (data: Record<string, unknown>) => ({ id: 1, ...data }));
registerDbFake('updateScheduleExecution', async (id: number, data: Record<string, unknown>) => ({ id, ...data }));

// -- $lib/server/stacks -------------------------------------------------------

let composeFile: { success: boolean; content?: string; needsFileLocation?: boolean; error?: string };
let saveResult: { success: boolean; error?: string };

registerStacksFake('getStackComposeFile', async () => composeFile);
registerStacksFake('saveStackComposeFile', async () => {
	events.push('save');
	return saveResult;
});
registerStacksFake('requireComposeFile', async () => ({
	success: true,
	content: COMPOSE,
	nonSecretVars: {},
	secretVars: {},
	composePath: '/tmp/demo-stack/compose.yaml',
	envPath: '/tmp/demo-stack/.env'
}));
registerStacksFake('deployStack', async () => {
	events.push('deploy');
	return { success: true, output: 'deployed' };
});

// The compose route's run recorder writes a log under DATA_DIR; keep it off the real one.
const previousDataDir = process.env.DATA_DIR;
let dataDir: string;
beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'dv-profiles-endpoints-'));
	process.env.DATA_DIR = dataDir;
});
afterAll(async () => {
	await rm(dataDir, { recursive: true, force: true });
	if (previousDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = previousDataDir;
});

beforeEach(() => {
	authState = { authEnabled: false, canView: true, canEdit: true, envAllowed: true };
	canCalls = [];
	rows = new Map([[key(STACK, null), null]]);
	events = [];
	composeFile = { success: true, content: COMPOSE };
	saveResult = { success: true };
});

// -- Routes under test, imported AFTER the fakes are registered ---------------

const profilesRoute = await import('../src/routes/api/stacks/[name]/profiles/+server');
const composeRoute = await import('../src/routes/api/stacks/[name]/compose/+server');

function makeEvent(method: string, body?: unknown, over: { name?: string; url?: string; rawBody?: string } = {}) {
	const init: RequestInit = {
		method,
		headers: { 'content-type': 'application/json', accept: 'application/json' }
	};
	if (over.rawBody !== undefined) init.body = over.rawBody;
	else if (body !== undefined) init.body = JSON.stringify(body);
	return {
		params: { name: over.name ?? STACK },
		request: new Request('http://x/', init),
		url: new URL(over.url ?? 'http://x/'),
		cookies: { get: () => undefined }
	} as any;
}

describe('GET /api/stacks/[name]/profiles', () => {
	test('an unmanaged stack reports no selection, managed:false, and the declared profiles', async () => {
		const res = await profilesRoute.GET(makeEvent('GET'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ profiles: [], declared: ['cron', 'mcp'], managed: false });
	});

	test('a stored selection is returned in stored order with managed:true', async () => {
		rows.set(key(STACK, null), ['mcp', 'cron']);
		expect(await (await profilesRoute.GET(makeEvent('GET'))).json()).toEqual({
			profiles: ['mcp', 'cron'],
			declared: ['cron', 'mcp'],
			managed: true
		});
	});

	test('managed with nothing selected is distinguishable from unmanaged', async () => {
		rows.set(key(STACK, null), []);
		expect(await (await profilesRoute.GET(makeEvent('GET'))).json()).toEqual({
			profiles: [],
			declared: ['cron', 'mcp'],
			managed: true
		});
	});

	test('declared is empty when the compose file is not available (git stack before its first sync)', async () => {
		rows.set(key(STACK, null), ['cron']);
		composeFile = { success: false, needsFileLocation: true };
		expect(await (await profilesRoute.GET(makeEvent('GET'))).json()).toEqual({
			profiles: ['cron'],
			declared: [],
			managed: true
		});
	});

	test('a stack Dockhand does not track still answers 200 with nothing', async () => {
		composeFile = { success: false, needsFileLocation: true };
		const res = await profilesRoute.GET(makeEvent('GET', undefined, { name: 'untracked' }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ profiles: [], declared: [], managed: false });
	});

	test('the selection is scoped to the environment in ?env=', async () => {
		rows.set(key(STACK, 7), ['cron']);
		const local = await (await profilesRoute.GET(makeEvent('GET'))).json();
		const env7 = await (await profilesRoute.GET(makeEvent('GET', undefined, { url: 'http://x/?env=7' }))).json();
		expect(local.profiles).toEqual([]);
		expect(env7.profiles).toEqual(['cron']);
	});

	test('403 without stacks:view, checked against the requested environment', async () => {
		authState = { authEnabled: true, canView: false, canEdit: true, envAllowed: true };
		const res = await profilesRoute.GET(makeEvent('GET', undefined, { url: 'http://x/?env=7' }));
		expect(res.status).toBe(403);
		expect(canCalls).toEqual([{ resource: 'stacks', action: 'view', environmentId: 7 }]);
	});

	test('403 when the caller cannot access the environment', async () => {
		authState = { authEnabled: true, canView: true, canEdit: true, envAllowed: false };
		const res = await profilesRoute.GET(makeEvent('GET', undefined, { url: 'http://x/?env=7' }));
		expect(res.status).toBe(403);
	});
});

describe('PUT /api/stacks/[name]/profiles', () => {
	test('stores a normalized selection and echoes it', async () => {
		const res = await profilesRoute.PUT(makeEvent('PUT', { profiles: [' cron ', 'mcp', 'cron'] }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ profiles: ['cron', 'mcp'] });
		expect(rows.get(key(STACK, null))).toEqual(['cron', 'mcp']);
	});

	test('names not declared in the compose file are accepted (the file may change later)', async () => {
		const res = await profilesRoute.PUT(makeEvent('PUT', { profiles: ['not-declared'] }));
		expect(res.status).toBe(200);
		expect(rows.get(key(STACK, null))).toEqual(['not-declared']);
	});

	test('clearing a managed stack keeps it managed', async () => {
		rows.set(key(STACK, null), ['cron']);
		const res = await profilesRoute.PUT(makeEvent('PUT', { profiles: [] }));
		expect(await res.json()).toEqual({ profiles: [] });
		expect(rows.get(key(STACK, null))).toEqual([]);
	});

	test('an empty selection on an unmanaged stack leaves it unmanaged', async () => {
		const res = await profilesRoute.PUT(makeEvent('PUT', { profiles: [] }));
		expect(await res.json()).toEqual({ profiles: [] });
		expect(rows.get(key(STACK, null))).toBeNull();
	});

	test('400 for a missing, non-array or malformed selection, and nothing is stored', async () => {
		const bad: unknown[] = [{}, { profiles: 'cron' }, { profiles: [1] }, { profiles: ['--rm'] }, { profiles: ['*'] }, { profiles: ['a b'] }];
		for (const body of bad) {
			const res = await profilesRoute.PUT(makeEvent('PUT', body));
			expect(res.status).toBe(400);
			expect(typeof (await res.json()).error).toBe('string');
		}
		expect(events).toEqual([]);
		expect(rows.get(key(STACK, null))).toBeNull();
	});

	test('400 for a body that is not JSON', async () => {
		const res = await profilesRoute.PUT(makeEvent('PUT', undefined, { rawBody: 'not json' }));
		expect(res.status).toBe(400);
	});

	test('404 for a stack Dockhand does not track', async () => {
		const res = await profilesRoute.PUT(makeEvent('PUT', { profiles: ['cron'] }, { name: 'untracked' }));
		expect(res.status).toBe(404);
	});

	test('403 without stacks:edit - view permission is not enough', async () => {
		authState = { authEnabled: true, canView: true, canEdit: false, envAllowed: true };
		const res = await profilesRoute.PUT(makeEvent('PUT', { profiles: ['cron'] }));
		expect(res.status).toBe(403);
		expect(canCalls.at(-1)?.action).toBe('edit');
		expect(rows.get(key(STACK, null))).toBeNull();
	});

	test('403 when the caller cannot access the environment, and nothing is stored', async () => {
		rows.set(key(STACK, 7), null);
		authState = { authEnabled: true, canView: true, canEdit: true, envAllowed: false };
		const res = await profilesRoute.PUT(makeEvent('PUT', { profiles: ['cron'] }, { url: 'http://x/?env=7' }));
		expect(res.status).toBe(403);
		expect(rows.get(key(STACK, 7))).toBeNull();
	});
});

describe('GET /api/stacks/[name]/compose', () => {
	test('includes the stored selection, [] when unmanaged', async () => {
		expect((await (await composeRoute.GET(makeEvent('GET'))).json()).profiles).toEqual([]);
		rows.set(key(STACK, null), ['cron']);
		expect((await (await composeRoute.GET(makeEvent('GET'))).json()).profiles).toEqual(['cron']);
	});
});

describe('PUT /api/stacks/[name]/compose -- profiles', () => {
	test('a plain save stores the selection after the file is written', async () => {
		const res = await composeRoute.PUT(makeEvent('PUT', { content: COMPOSE, profiles: ['cron'] }));
		expect(res.status).toBe(200);
		expect(events).toEqual(['save', 'setProfiles:["cron"]']);
		expect(rows.get(key(STACK, null))).toEqual(['cron']);
	});

	test('Save & redeploy stores the selection BEFORE the deploy starts', async () => {
		await (await composeRoute.PUT(makeEvent('PUT', { content: COMPOSE, restart: true, profiles: ['mcp'] }))).json();
		expect(events).toEqual(['save', 'setProfiles:["mcp"]', 'deploy']);
	});

	test('omitting profiles leaves the stored selection untouched', async () => {
		rows.set(key(STACK, null), ['cron']);
		await (await composeRoute.PUT(makeEvent('PUT', { content: COMPOSE, restart: true }))).json();
		expect(events).toEqual(['save', 'deploy']);
		expect(rows.get(key(STACK, null))).toEqual(['cron']);
	});

	test('an empty selection from the editor does not opt an unmanaged stack in', async () => {
		await composeRoute.PUT(makeEvent('PUT', { content: COMPOSE, profiles: [] }));
		expect(rows.get(key(STACK, null))).toBeNull();
	});

	test('a malformed selection is rejected before the compose file is written', async () => {
		const res = await composeRoute.PUT(makeEvent('PUT', { content: COMPOSE, restart: true, profiles: ['--rm'] }));
		expect(res.status).toBe(400);
		expect(events).toEqual([]);
	});

	test('a failed file save does not store the selection or deploy', async () => {
		saveResult = { success: false, error: 'disk full' };
		const res = await composeRoute.PUT(makeEvent('PUT', { content: COMPOSE, restart: true, profiles: ['cron'] }));
		expect(res.status).toBe(500);
		expect(events).toEqual(['save']);
		expect(rows.get(key(STACK, null))).toBeNull();
	});
});
