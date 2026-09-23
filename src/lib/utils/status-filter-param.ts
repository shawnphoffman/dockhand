/**
 * Query-string round trip for the list pages' status filter (containers, stacks), so
 * a filtered view survives a reload and can be shared or bookmarked the same way
 * `?search=` already can. Values are comma-separated: `?status=running,update-available`.
 *
 * The URL takes precedence over the per-browser localStorage copy: when the param is
 * present it is the filter, even if empty, and when it is absent the page falls back
 * to whatever it last saved.
 */
export const STATUS_FILTER_PARAM = 'status';

/**
 * Reads the status filter from `params`. Returns `null` when the param is absent, so
 * the caller can tell "no opinion" apart from "explicitly nothing". Unknown values are
 * dropped (a stale or hand-edited link must not silently filter every row out), as are
 * blanks and duplicates.
 */
export function readStatusFilterParam(
	params: URLSearchParams,
	allowed: readonly string[]
): string[] | null {
	const raw = params.get(STATUS_FILTER_PARAM);
	if (raw === null) return null;
	const known = new Set(allowed);
	const values = raw.split(',').map((v) => v.trim()).filter((v) => known.has(v));
	return [...new Set(values)];
}

/** Writes `values` into `params`, removing the param entirely when the filter is empty. */
export function writeStatusFilterParam(params: URLSearchParams, values: readonly string[]): void {
	if (values.length > 0) params.set(STATUS_FILTER_PARAM, values.join(','));
	else params.delete(STATUS_FILTER_PARAM);
}
