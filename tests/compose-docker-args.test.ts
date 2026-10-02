/**
 * #1393: the compose daemon must be passed on the `docker -H` flag, never as
 * DOCKER_HOST in the shell env (which leaks into services that pass through or
 * interpolate DOCKER_HOST). These are the pure resolver + argv builder.
 */
import { describe, test, expect } from 'bun:test';
import {
	resolveComposeDockerHost,
	buildComposeBaseArgs,
	buildComposeProfileArgs,
	withComposeProfilesEnv
} from '../src/lib/server/compose-docker-args';

describe('resolveComposeDockerHost', () => {
	test('per-env dockerHost wins', () => {
		expect(resolveComposeDockerHost('tcp://remote:2375', 'unix:///own.sock')).toBe('tcp://remote:2375');
	});
	test("falls back to Dockhand's own DOCKER_HOST (socket-proxy setup)", () => {
		expect(resolveComposeDockerHost(undefined, 'tcp://dockhand-socket-proxy:2375')).toBe(
			'tcp://dockhand-socket-proxy:2375'
		);
	});
	test('undefined for a plain local socket (no host anywhere)', () => {
		expect(resolveComposeDockerHost(undefined, undefined)).toBeUndefined();
		expect(resolveComposeDockerHost(null, null)).toBeUndefined();
		expect(resolveComposeDockerHost('', '')).toBeUndefined();
	});
});

describe('buildComposeBaseArgs', () => {
	test('puts the daemon on -H BEFORE compose (global docker flag)', () => {
		expect(buildComposeBaseArgs('mystack', 'tcp://remote:2375')).toEqual([
			'docker',
			'-H',
			'tcp://remote:2375',
			'compose',
			'-p',
			'mystack'
		]);
	});
	test('omits -H entirely when there is no host (default local socket)', () => {
		const args = buildComposeBaseArgs('mystack', undefined);
		expect(args).toEqual(['docker', 'compose', '-p', 'mystack']);
		// crucially, DOCKER_HOST / -H never appears
		expect(args).not.toContain('-H');
	});
	test('the daemon is NEVER placed after `compose` (would be an invalid subcommand flag)', () => {
		const args = buildComposeBaseArgs('s', 'unix:///own.sock');
		expect(args.indexOf('-H')).toBeLessThan(args.indexOf('compose'));
	});
});

describe('buildComposeProfileArgs', () => {
	test('one --profile flag per selected profile, in order', () => {
		expect(buildComposeProfileArgs(['cron', 'mcp'])).toEqual(['--profile', 'cron', '--profile', 'mcp']);
	});
	test('nothing for an empty or missing selection (compose keeps its own default)', () => {
		expect(buildComposeProfileArgs([])).toEqual([]);
		expect(buildComposeProfileArgs(null)).toEqual([]);
		expect(buildComposeProfileArgs(undefined)).toEqual([]);
	});
	test('lands between the project flag and the subcommand', () => {
		const args = [...buildComposeBaseArgs('mystack', undefined), ...buildComposeProfileArgs(['cron']), 'up', '-d'];
		expect(args).toEqual(['docker', 'compose', '-p', 'mystack', '--profile', 'cron', 'up', '-d']);
	});
});

describe('withComposeProfilesEnv (Hawser)', () => {
	test('adds COMPOSE_PROFILES as a comma-separated list without mutating the input', () => {
		const envVars = { FOO: 'bar' };
		expect(withComposeProfilesEnv(envVars, ['cron', 'mcp'])).toEqual({ FOO: 'bar', COMPOSE_PROFILES: 'cron,mcp' });
		expect(envVars).toEqual({ FOO: 'bar' });
	});
	test('a selection overrides a COMPOSE_PROFILES the stack set itself', () => {
		expect(withComposeProfilesEnv({ COMPOSE_PROFILES: 'debug' }, ['cron'])).toEqual({ COMPOSE_PROFILES: 'cron' });
	});
	test('an empty or missing selection leaves the env untouched', () => {
		const envVars = { COMPOSE_PROFILES: 'debug' };
		expect(withComposeProfilesEnv(envVars, [])).toBe(envVars);
		expect(withComposeProfilesEnv(envVars, null)).toBe(envVars);
	});
});
