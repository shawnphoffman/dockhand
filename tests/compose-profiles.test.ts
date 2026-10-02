/**
 * Compose profile helpers: validating a selection, the tri-state stored value, and
 * working out which services a selection leaves inactive.
 *
 * The inactive-service logic drives container removal after a deploy, so the cases
 * that matter most are the ones where it must NOT name a service: anything it cannot
 * see clearly has to count as active.
 */
import { describe, expect, test } from 'bun:test';
import {
	MAX_SELECTED_PROFILES,
	containersOfInactiveServices,
	effectiveProfiles,
	inactiveProfileServices,
	isServiceActive,
	nextStoredProfiles,
	normalizeProfileSelection,
	parseComposeProfilesEnv,
	parseDeclaredProfiles,
	parseServiceProfiles,
	parseStoredProfiles,
	readComposeProfilesFromEnvFile,
	serializeStoredProfiles
} from '../src/lib/utils/compose-profiles';

const COMPOSE = `
services:
  app:
    image: nginx
  db:
    image: postgres
    profiles: []
  cron:
    image: alpine
    profiles:
      - cron
  mcp:
    image: alpine
    profiles: ['mcp', 'tools']
`;

describe('normalizeProfileSelection', () => {
	test('accepts well-formed names, trimming and de-duplicating in first-seen order', () => {
		expect(normalizeProfileSelection([' mcp ', 'cron', 'mcp'])).toEqual({
			ok: true,
			profiles: ['mcp', 'cron']
		});
	});

	test('an empty array is a valid (empty) selection', () => {
		expect(normalizeProfileSelection([])).toEqual({ ok: true, profiles: [] });
	});

	test('names with dots, dashes, underscores and a single character are allowed', () => {
		expect(normalizeProfileSelection(['a', 'dev.local', 'front-end', 'db_1'])).toEqual({
			ok: true,
			profiles: ['a', 'dev.local', 'front-end', 'db_1']
		});
	});

	test('rejects anything that is not an array of strings', () => {
		expect(normalizeProfileSelection('cron').ok).toBe(false);
		expect(normalizeProfileSelection(null).ok).toBe(false);
		expect(normalizeProfileSelection({ 0: 'cron' }).ok).toBe(false);
		expect(normalizeProfileSelection(['cron', 1]).ok).toBe(false);
	});

	test('rejects malformed names, including the wildcard and flag-shaped values', () => {
		for (const bad of ['', '   ', '*', '--project-directory', 'a,b', 'has space', '.hidden']) {
			const result = normalizeProfileSelection([bad]);
			expect(result.ok).toBe(false);
		}
	});

	test('rejects an absurdly long selection', () => {
		const many = Array.from({ length: MAX_SELECTED_PROFILES + 1 }, (_, i) => `p${i}`);
		expect(normalizeProfileSelection(many).ok).toBe(false);
		expect(normalizeProfileSelection(many.slice(0, MAX_SELECTED_PROFILES)).ok).toBe(true);
	});
});

describe('stored value (tri-state)', () => {
	test('null stays null and [] stays [] through a round trip', () => {
		expect(serializeStoredProfiles(null)).toBeNull();
		expect(parseStoredProfiles(serializeStoredProfiles(null))).toBeNull();
		expect(serializeStoredProfiles([])).toBe('[]');
		expect(parseStoredProfiles(serializeStoredProfiles([]))).toEqual([]);
	});

	test('a selection round-trips in order', () => {
		expect(parseStoredProfiles(serializeStoredProfiles(['mcp', 'cron']))).toEqual(['mcp', 'cron']);
	});

	test('empty, malformed or non-array values read as unmanaged, never throw', () => {
		expect(parseStoredProfiles(undefined)).toBeNull();
		expect(parseStoredProfiles('')).toBeNull();
		expect(parseStoredProfiles('not json')).toBeNull();
		expect(parseStoredProfiles('{"a":1}')).toBeNull();
	});

	test('non-string members are dropped', () => {
		expect(parseStoredProfiles('["cron",1,null,"mcp"]')).toEqual(['cron', 'mcp']);
	});
});

describe('nextStoredProfiles', () => {
	test('an empty selection does not opt an unmanaged stack in', () => {
		expect(nextStoredProfiles(null, [])).toBeNull();
	});

	test('the first real selection makes the stack managed', () => {
		expect(nextStoredProfiles(null, ['cron'])).toEqual(['cron']);
	});

	test('clearing a managed stack keeps it managed, so the deploy can clean up', () => {
		expect(nextStoredProfiles(['cron'], [])).toEqual([]);
		expect(nextStoredProfiles([], [])).toEqual([]);
	});
});

describe('parseComposeProfilesEnv / effectiveProfiles', () => {
	test('splits on commas and drops blanks', () => {
		expect(parseComposeProfilesEnv('cron, mcp,,')).toEqual(['cron', 'mcp']);
		expect(parseComposeProfilesEnv('')).toEqual([]);
		expect(parseComposeProfilesEnv(undefined)).toEqual([]);
	});

	test('an explicit selection beats COMPOSE_PROFILES, like --profile on the CLI', () => {
		expect(effectiveProfiles(['mcp'], 'cron')).toEqual(['mcp']);
	});

	test('an empty or missing selection falls back to COMPOSE_PROFILES', () => {
		expect(effectiveProfiles([], 'cron,mcp')).toEqual(['cron', 'mcp']);
		expect(effectiveProfiles(null, 'cron')).toEqual(['cron']);
		expect(effectiveProfiles([], undefined)).toEqual([]);
	});
});

describe('readComposeProfilesFromEnvFile', () => {
	test('reads a plain, exported or quoted assignment', () => {
		expect(readComposeProfilesFromEnvFile('A=1\nCOMPOSE_PROFILES=cron,mcp\nB=2')).toBe('cron,mcp');
		expect(readComposeProfilesFromEnvFile('export COMPOSE_PROFILES="cron"')).toBe('cron');
		expect(readComposeProfilesFromEnvFile("COMPOSE_PROFILES='a,b' # note")).toBe('a,b');
		expect(readComposeProfilesFromEnvFile('COMPOSE_PROFILES=cron # note\r\n')).toBe('cron');
	});

	test('the last assignment wins, and an empty one counts', () => {
		expect(readComposeProfilesFromEnvFile('COMPOSE_PROFILES=a\nCOMPOSE_PROFILES=b')).toBe('b');
		expect(readComposeProfilesFromEnvFile('COMPOSE_PROFILES=a\nCOMPOSE_PROFILES=')).toBe('');
	});

	test('undefined when unset, commented out, or only a look-alike key is present', () => {
		expect(readComposeProfilesFromEnvFile('')).toBeUndefined();
		expect(readComposeProfilesFromEnvFile(undefined)).toBeUndefined();
		expect(readComposeProfilesFromEnvFile('# COMPOSE_PROFILES=cron')).toBeUndefined();
		expect(readComposeProfilesFromEnvFile('MY_COMPOSE_PROFILES=cron\nCOMPOSE_PROFILES_X=1')).toBeUndefined();
	});
});

describe('parseServiceProfiles / parseDeclaredProfiles', () => {
	test('maps every service to its profiles, [] for ungated ones', () => {
		expect(Object.fromEntries(parseServiceProfiles(COMPOSE))).toEqual({
			app: [],
			db: [],
			cron: ['cron'],
			mcp: ['mcp', 'tools']
		});
	});

	test('declared profiles are unique and sorted', () => {
		expect(parseDeclaredProfiles(COMPOSE)).toEqual(['cron', 'mcp', 'tools']);
	});

	test('blank, unparseable or service-less documents yield nothing', () => {
		expect(parseServiceProfiles('').size).toBe(0);
		expect(parseServiceProfiles('services: [unclosed').size).toBe(0);
		expect(parseServiceProfiles('just a string').size).toBe(0);
		expect(parseServiceProfiles('volumes:\n  data: {}').size).toBe(0);
		expect(parseDeclaredProfiles('services:\n  - not-a-map')).toEqual([]);
	});

	test('ignores non-list profiles and non-string members', () => {
		const doc = 'services:\n  a:\n    profiles: cron\n  b:\n    profiles: [1, "x", "", "x"]\n  c: null\n';
		expect(Object.fromEntries(parseServiceProfiles(doc))).toEqual({ a: [], b: ['x'], c: [] });
	});

	test('resolves YAML anchors, so a shared profiles list is seen on each service', () => {
		const doc = 'x-gated: &gated\n  profiles: [debug]\nservices:\n  a:\n    <<: *gated\n    image: x\n';
		expect(parseServiceProfiles(doc).get('a')).toEqual(['debug']);
	});
});

describe('isServiceActive', () => {
	test('a service with no profiles is always active', () => {
		expect(isServiceActive([], [])).toBe(true);
		expect(isServiceActive([], ['cron'])).toBe(true);
	});

	test('a gated service needs one of its profiles active', () => {
		expect(isServiceActive(['mcp', 'tools'], ['tools'])).toBe(true);
		expect(isServiceActive(['mcp', 'tools'], ['cron'])).toBe(false);
		expect(isServiceActive(['cron'], [])).toBe(false);
	});

	test('the * wildcard activates everything', () => {
		expect(isServiceActive(['cron'], ['*'])).toBe(true);
	});
});

describe('inactiveProfileServices', () => {
	test('names only gated services with no active profile', () => {
		expect(inactiveProfileServices([COMPOSE], [])).toEqual(['cron', 'mcp']);
		expect(inactiveProfileServices([COMPOSE], ['cron'])).toEqual(['mcp']);
		expect(inactiveProfileServices([COMPOSE], ['cron', 'tools'])).toEqual([]);
		expect(inactiveProfileServices([COMPOSE], ['*'])).toEqual([]);
	});

	test('a profile added by an override file keeps the service active', () => {
		const override = 'services:\n  mcp:\n    profiles: [cron]\n';
		expect(inactiveProfileServices([COMPOSE, override], ['cron'])).toEqual([]);
	});

	test('an override that gates a previously ungated service is honored', () => {
		const override = 'services:\n  app:\n    profiles: [web]\n';
		expect(inactiveProfileServices([COMPOSE, override], ['cron', 'mcp'])).toEqual(['app']);
	});

	test('a service gated by an interpolated profile is never named', () => {
		const doc = 'services:\n  a:\n    profiles: ["${TIER}"]\n  b:\n    profiles: ["${TIER:-x}", debug]\n';
		expect(inactiveProfileServices([doc], [])).toEqual([]);
		expect(inactiveProfileServices([doc], ['cron'])).toEqual([]);
		// ...and the placeholder is not offered as a selectable profile.
		expect(parseDeclaredProfiles(doc)).toEqual(['debug']);
	});

	test('an unparseable document contributes nothing instead of throwing', () => {
		expect(inactiveProfileServices(['services: [unclosed', COMPOSE], ['cron'])).toEqual(['mcp']);
		expect(inactiveProfileServices(['', ''], [])).toEqual([]);
	});
});

describe('containersOfInactiveServices', () => {
	const container = (name: string, labels: Record<string, string> | null) => ({ name, labels });
	const all = [
		container('app', { 'com.docker.compose.service': 'app' }),
		container('cron', { 'com.docker.compose.service': 'cron', 'com.docker.compose.oneoff': 'False' }),
		container('cron-run', { 'com.docker.compose.service': 'cron', 'com.docker.compose.oneoff': 'True' }),
		container('spawned', { 'com.docker.compose.project': 'stack' }),
		container('bare', null)
	];

	test('picks the containers of the named services only', () => {
		expect(containersOfInactiveServices(all, ['cron']).map((c) => c.name)).toEqual(['cron']);
		expect(containersOfInactiveServices(all, ['app', 'cron']).map((c) => c.name)).toEqual(['app', 'cron']);
	});

	test('a one-off `compose run` container is left alone', () => {
		expect(containersOfInactiveServices(all, ['cron']).map((c) => c.name)).not.toContain('cron-run');
	});

	test('containers without a service label are never picked', () => {
		// "undefined" must not match a missing label either.
		expect(containersOfInactiveServices(all, ['undefined', '']).length).toBe(0);
	});

	test('nothing inactive means nothing picked', () => {
		expect(containersOfInactiveServices(all, [])).toEqual([]);
	});
});

describe('deploy scenarios (selection -> containers to remove)', () => {
	// The full decision the deploy makes, composed from the helpers above the same way
	// removeInactiveProfileContainers does it in stacks.ts.
	const running = ['app', 'cron', 'mcp'].map((service) => ({
		name: service,
		labels: { 'com.docker.compose.service': service }
	}));
	const toRemove = (selection: string[], env?: string, override = '') =>
		containersOfInactiveServices(
			running,
			inactiveProfileServices([COMPOSE, override], effectiveProfiles(selection, env))
		).map((c) => c.name);

	test('unchecking one of two profiles removes only that profile\'s container', () => {
		expect(toRemove(['cron'])).toEqual(['mcp']);
	});

	test('unchecking the last profile removes every gated container, never an ungated one', () => {
		expect(toRemove([])).toEqual(['cron', 'mcp']);
	});

	test('with nothing selected, COMPOSE_PROFILES from the env file keeps its services', () => {
		expect(toRemove([], 'cron')).toEqual(['mcp']);
		expect(toRemove([], '*')).toEqual([]);
	});

	test('a selection overrides COMPOSE_PROFILES, so the env file\'s profile is removed', () => {
		expect(toRemove(['mcp'], 'cron')).toEqual(['cron']);
	});

	test('a service that shares any active profile stays (mcp is in both mcp and tools)', () => {
		expect(toRemove(['tools'])).toEqual(['cron']);
	});
});
