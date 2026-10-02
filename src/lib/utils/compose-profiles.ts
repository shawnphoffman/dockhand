/**
 * Pure helpers for Docker Compose profiles (https://docs.docker.com/compose/how-tos/profiles/).
 * Shared by the stack editor (which services are greyed out), the API (validating a
 * selection) and the deploy path (which containers a deselected profile leaves behind).
 * Dependency-light (js-yaml only) so it unit-tests without a daemon or the database.
 *
 * A stack's selection is stored on `stack_sources.profiles` and is deliberately
 * tri-state:
 *   - null     Dockhand does not manage this stack's profiles. Nothing is passed to
 *              compose and nothing is cleaned up - exactly the pre-profiles behavior.
 *   - []       Managed, nothing selected. Compose falls back to its own default
 *              (COMPOSE_PROFILES from the env file, if any).
 *   - [a, b]   Managed, these profiles are active (`--profile a --profile b`). An
 *              explicit selection overrides COMPOSE_PROFILES, same as on the CLI.
 * The null/[] split is what lets a deploy tell "the user unchecked the last profile,
 * so its containers must go" apart from "this stack never used the selector".
 */
import yaml from 'js-yaml';

/**
 * Profile name format from the Compose specification, relaxed to allow a single
 * character: the spec asks for two or more, but the compose CLI accepts `profiles: [x]`.
 */
export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Upper bound on a stored selection - far above any real compose file, just a sanity cap. */
export const MAX_SELECTED_PROFILES = 64;

/** The env var compose reads its active profiles from when no `--profile` flag is given. */
export const COMPOSE_PROFILES_VAR = 'COMPOSE_PROFILES';

export type ProfileSelectionResult =
	| { ok: true; profiles: string[] }
	| { ok: false; error: string };

/**
 * Validates and normalizes a profile selection from an untrusted source (a request
 * body). Trims, drops duplicates and keeps first-seen order. Names need not be declared
 * in the current compose file (the file may be edited later; compose ignores unknown
 * profiles), but they must be well-formed, which also rules out the `*` wildcard.
 */
export function normalizeProfileSelection(input: unknown): ProfileSelectionResult {
	if (!Array.isArray(input)) {
		return { ok: false, error: 'profiles must be an array of profile names' };
	}
	const profiles: string[] = [];
	for (const item of input) {
		if (typeof item !== 'string') {
			return { ok: false, error: 'profiles must be an array of profile names' };
		}
		const name = item.trim();
		if (!PROFILE_NAME_PATTERN.test(name)) {
			return { ok: false, error: `Invalid profile name: "${item}"` };
		}
		if (!profiles.includes(name)) profiles.push(name);
	}
	if (profiles.length > MAX_SELECTED_PROFILES) {
		return { ok: false, error: `Too many profiles (max ${MAX_SELECTED_PROFILES})` };
	}
	return { ok: true, profiles };
}

/**
 * Parses the stored `stack_sources.profiles` value. null/empty/malformed all read as
 * null (unmanaged) rather than throwing, so a bad row degrades to the pre-profiles
 * behavior instead of breaking every operation on the stack.
 */
export function parseStoredProfiles(raw: string | null | undefined): string[] | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((p): p is string => typeof p === 'string');
	} catch {
		return null;
	}
}

/** Serializes a selection for storage. `[]` is kept as `'[]'` - it is not the same as null. */
export function serializeStoredProfiles(profiles: string[] | null): string | null {
	return profiles === null ? null : JSON.stringify(profiles);
}

/**
 * The value to store when the selection changes from `current` to `next`. Clearing a
 * selection on a stack that never had one stays null: every save from the editor sends
 * the (empty) selection, and that alone must not opt a stack into profile management.
 */
export function nextStoredProfiles(current: string[] | null, next: string[]): string[] | null {
	return current === null && next.length === 0 ? null : next;
}

/** Splits a COMPOSE_PROFILES value (`a,b`) into names, dropping blanks. */
export function parseComposeProfilesEnv(value: string | null | undefined): string[] {
	if (!value) return [];
	return value.split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * Reads COMPOSE_PROFILES out of raw .env file content (last assignment wins, optional
 * `export`, surrounding quotes and a trailing comment on an unquoted value stripped).
 * Returns undefined when the file does not set it.
 */
export function readComposeProfilesFromEnvFile(content: string | null | undefined): string | undefined {
	if (!content) return undefined;
	let value: string | undefined;
	for (const line of content.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?COMPOSE_PROFILES\s*=(.*)$/.exec(line);
		if (!match) continue;
		const raw = match[1].trim();
		const quoted = /^(["'])(.*)\1/.exec(raw);
		value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '');
	}
	return value;
}

/**
 * The profiles compose will actually activate: the explicit selection when there is
 * one, else whatever COMPOSE_PROFILES resolves to. Mirrors compose's own precedence
 * (`--profile` beats the env var).
 */
export function effectiveProfiles(
	selection: readonly string[] | null | undefined,
	composeProfilesEnv?: string | null
): string[] {
	return selection && selection.length > 0 ? [...selection] : parseComposeProfilesEnv(composeProfilesEnv);
}

function profilesOf(service: unknown): string[] {
	if (!service || typeof service !== 'object') return [];
	const raw = (service as Record<string, unknown>).profiles;
	if (!Array.isArray(raw)) return [];
	const names: string[] = [];
	for (const item of raw) {
		if (typeof item !== 'string') continue;
		const name = item.trim();
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * Maps each service in a compose document to the profiles it declares (`[]` for a
 * service that is always on). Returns an empty map for blank or unparseable YAML, so
 * callers never have to guard: no services known means nothing is gated.
 *
 * Only sees what is written in this one file. Profiles that reach a service through
 * `include:` or `extends:` are invisible here, which every caller treats as "not
 * gated" - the safe direction for both greying out and container cleanup.
 */
export function parseServiceProfiles(composeContent: string): Map<string, string[]> {
	const result = new Map<string, string[]>();
	if (!composeContent || !composeContent.trim()) return result;
	let doc: unknown;
	try {
		doc = yaml.load(composeContent);
	} catch {
		return result;
	}
	if (!doc || typeof doc !== 'object') return result;
	const services = (doc as Record<string, unknown>).services;
	if (!services || typeof services !== 'object' || Array.isArray(services)) return result;
	for (const [name, service] of Object.entries(services as Record<string, unknown>)) {
		result.set(name, profilesOf(service));
	}
	return result;
}

/**
 * Every selectable profile name declared by any service in the compose document,
 * sorted. Interpolated names (`${TIER}`) are left out: they are not names yet.
 */
export function parseDeclaredProfiles(composeContent: string): string[] {
	const names = new Set<string>();
	for (const profiles of parseServiceProfiles(composeContent).values()) {
		for (const name of profiles) {
			if (PROFILE_NAME_PATTERN.test(name)) names.add(name);
		}
	}
	return [...names].sort();
}

/**
 * Whether compose starts a service under the given active profiles: always when it
 * declares none, otherwise when at least one of its profiles is active (or the `*`
 * wildcard is, which COMPOSE_PROFILES may carry). A service whose profiles cannot be
 * read literally counts as active.
 */
export function isServiceActive(declared: readonly string[], active: readonly string[]): boolean {
	if (declared.length === 0) return true;
	if (active.includes('*')) return true;
	// An interpolated name (`profiles: ["${TIER}"]`) only resolves inside compose, so
	// there is no telling here whether it is active. Assume it is.
	if (declared.some((p) => !PROFILE_NAME_PATTERN.test(p))) return true;
	return declared.some((p) => active.includes(p));
}

/**
 * Names of the services that are gated by a profile and NOT active - the ones whose
 * containers `docker compose up` leaves running after their profile is deselected
 * (compose neither stops them nor treats them as orphans).
 *
 * Takes several compose documents (the main file plus an override file) and unions
 * each service's profiles across them, so a profile added by an override keeps the
 * service active. Erring towards "active" is deliberate: a missed cleanup leaves a
 * container running, a wrong one removes a container the user wanted.
 */
export function inactiveProfileServices(
	composeContents: readonly string[],
	active: readonly string[]
): string[] {
	const merged = new Map<string, string[]>();
	for (const content of composeContents) {
		for (const [name, profiles] of parseServiceProfiles(content)) {
			const existing = merged.get(name) ?? [];
			merged.set(name, [...new Set([...existing, ...profiles])]);
		}
	}
	const inactive: string[] = [];
	for (const [name, profiles] of merged) {
		if (!isServiceActive(profiles, active)) inactive.push(name);
	}
	return inactive.sort();
}

/** The container fields the cleanup needs: Docker's label map and nothing else. */
export interface LabelledContainer {
	labels?: Record<string, string> | null;
}

/**
 * Picks, from a project's containers, the ones that belong to the given inactive
 * services. One-off containers (`docker compose run`) are skipped: they were started
 * by hand for a single task and are not part of the stack's desired state. Containers
 * without a compose service label (spawned by another container under the same
 * project name) are never picked either.
 */
export function containersOfInactiveServices<T extends LabelledContainer>(
	containers: readonly T[],
	inactiveServices: readonly string[]
): T[] {
	return containers.filter((c) => {
		const service = c.labels?.['com.docker.compose.service'];
		return (
			!!service &&
			inactiveServices.includes(service) &&
			c.labels?.['com.docker.compose.oneoff'] !== 'True'
		);
	});
}
