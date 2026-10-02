<script lang="ts">
	/**
	 * Compose profile selector for the stack editors: one toggle chip per profile the
	 * compose file declares. Without `allowCustom` it renders nothing for a stack that
	 * neither declares nor has any profiles selected, so most stacks never see it.
	 *
	 * A selected profile the file no longer declares stays visible (amber) until it is
	 * removed - compose ignores it, but silently dropping it would hide why a service
	 * the user expects is not running.
	 *
	 * The git stack dialog cannot always read the compose file (nothing is cloned before
	 * the first sync), so there `allowCustom` adds a field to type a profile name, and
	 * `declaredKnown={false}` stops typed names being flagged as undeclared.
	 */
	import { Layers, Plus, TriangleAlert, X } from 'lucide-svelte';
	import { PROFILE_NAME_PATTERN } from '$lib/utils/compose-profiles';

	interface Props {
		/** Profile names declared by services in the compose file. */
		declared: string[];
		/** The selection. Order is preserved; toggling appends. */
		selected: string[];
		/** COMPOSE_PROFILES from the stack's env vars, which applies while nothing is selected. */
		envProfiles?: string[];
		disabled?: boolean;
		/** Offer a text field for adding a profile by name. */
		allowCustom?: boolean;
		/** False when the compose file could not be read, so `declared` says nothing about what exists. */
		declaredKnown?: boolean;
		onchange?: (selected: string[]) => void;
	}

	let {
		declared,
		selected = $bindable([]),
		envProfiles = [],
		disabled = false,
		allowCustom = false,
		declaredKnown = true,
		onchange
	}: Props = $props();

	// Selected names that are not among the declared chips.
	const extra = $derived(selected.filter((p) => !declared.includes(p)));

	let customName = $state('');
	let customError = $state('');

	function addCustom() {
		const name = customName.trim();
		if (!name) return;
		if (!PROFILE_NAME_PATTERN.test(name)) {
			customError = 'Letters, digits, dot, dash and underscore only, starting with a letter or digit';
			return;
		}
		customError = '';
		customName = '';
		if (!selected.includes(name)) {
			selected = [...selected, name];
			onchange?.(selected);
		}
	}

	function toggle(profile: string) {
		if (disabled) return;
		selected = selected.includes(profile)
			? selected.filter((p) => p !== profile)
			: [...selected, profile];
		onchange?.(selected);
	}
</script>

{#if allowCustom || declared.length > 0 || selected.length > 0}
	<div class="px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-100/60 dark:bg-zinc-800/60 flex flex-col gap-1.5 text-xs">
		<div class="flex items-start gap-2">
			<span class="text-xs text-muted-foreground shrink-0 flex items-center gap-1 h-6">
				<Layers class="w-3.5 h-3.5" />
				Profiles
			</span>
			<div class="flex flex-wrap items-center gap-1.5 min-w-0" role="group" aria-label="Compose profiles">
				{#each declared as profile (profile)}
					{@const active = selected.includes(profile)}
					<button
						type="button"
						aria-pressed={active}
						{disabled}
						onclick={() => toggle(profile)}
						class="h-6 px-2 rounded-md border font-mono transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed {active
							? 'bg-primary text-primary-foreground border-primary'
							: 'bg-background text-muted-foreground border-zinc-300 dark:border-zinc-600 hover:text-foreground hover:border-zinc-400 dark:hover:border-zinc-500'}"
					>
						{profile}
					</button>
				{/each}
				{#each extra as profile (profile)}
					<span
						title={declaredKnown ? 'Selected, but no service in this compose file declares it' : undefined}
						class="h-6 pl-2 pr-1 rounded-md border font-mono inline-flex items-center gap-1 {declaredKnown
							? 'border-amber-400/70 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
							: 'bg-primary text-primary-foreground border-primary'}"
					>
						{#if declaredKnown}<TriangleAlert class="w-3 h-3 shrink-0" />{/if}
						{profile}
						<button
							type="button"
							{disabled}
							onclick={() => toggle(profile)}
							aria-label="Remove profile {profile}"
							class="rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/15 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							<X class="w-3 h-3" />
						</button>
					</span>
				{/each}
				{#if allowCustom}
					<span class="inline-flex items-center gap-1">
						<input
							type="text"
							bind:value={customName}
							{disabled}
							placeholder="Add profile"
							aria-label="Add profile by name"
							aria-invalid={customError ? 'true' : undefined}
							oninput={() => (customError = '')}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ',') {
									e.preventDefault();
									addCustom();
								}
							}}
							onblur={addCustom}
							class="h-6 w-28 px-2 rounded-md border bg-background font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 {customError
								? 'border-red-500'
								: 'border-zinc-300 dark:border-zinc-600'}"
						/>
						<button
							type="button"
							disabled={disabled || !customName.trim()}
							onclick={addCustom}
							aria-label="Add profile"
							class="h-6 w-6 inline-flex items-center justify-center rounded-md border border-zinc-300 dark:border-zinc-600 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
						>
							<Plus class="w-3 h-3" />
						</button>
					</span>
				{/if}
			</div>
		</div>
		{#if customError}
			<p class="text-2xs text-red-600 dark:text-red-400 pl-0.5" role="alert">{customError}</p>
		{/if}
		<p class="text-2xs text-muted-foreground/70 pl-0.5">
			{#if selected.length > 0}
				Services in a selected profile start with the stack. On the next deploy, containers of deselected profiles are removed.
			{:else if envProfiles.length > 0}
				Nothing selected here, so COMPOSE_PROFILES from the environment variables applies ({envProfiles.join(', ')}).
			{:else}
				Nothing selected: services that belong to a profile are not started.
			{/if}
		</p>
	</div>
{/if}
