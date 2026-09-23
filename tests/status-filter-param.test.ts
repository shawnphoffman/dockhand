import { describe, expect, test } from 'bun:test';
import { readStatusFilterParam, writeStatusFilterParam } from '../src/lib/utils/status-filter-param';

const ALLOWED = ['running', 'exited', 'not deployed', 'update-available'];

describe('readStatusFilterParam', () => {
	test('an absent param returns null so the caller can fall back to localStorage', () => {
		expect(readStatusFilterParam(new URLSearchParams(''), ALLOWED)).toBeNull();
	});

	test('an empty param is an explicit empty filter, not a fallback', () => {
		expect(readStatusFilterParam(new URLSearchParams('status='), ALLOWED)).toEqual([]);
	});

	test('comma-separated values are split in order', () => {
		expect(readStatusFilterParam(new URLSearchParams('status=running,update-available'), ALLOWED))
			.toEqual(['running', 'update-available']);
	});

	test('unknown, blank and duplicate values are dropped', () => {
		expect(readStatusFilterParam(new URLSearchParams('status=running,,bogus,running'), ALLOWED))
			.toEqual(['running']);
	});

	test('a value containing a space survives the round trip', () => {
		const params = new URLSearchParams();
		writeStatusFilterParam(params, ['not deployed']);
		expect(readStatusFilterParam(new URLSearchParams(params.toString()), ALLOWED))
			.toEqual(['not deployed']);
	});
});

describe('writeStatusFilterParam', () => {
	test('a non-empty filter is written comma-separated', () => {
		const params = new URLSearchParams();
		writeStatusFilterParam(params, ['running', 'exited']);
		expect(params.get('status')).toBe('running,exited');
	});

	test('an empty filter removes the param and leaves others alone', () => {
		const params = new URLSearchParams('search=web&status=running');
		writeStatusFilterParam(params, []);
		expect(params.toString()).toBe('search=web');
	});
});
