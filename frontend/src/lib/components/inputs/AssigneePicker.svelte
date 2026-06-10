<script lang="ts">
	import type { OrgMember } from '$lib/api';

	// A compact assignee control: shows the current assignee as a chip (or
	// "Unassigned") with an invisible <select> overlaid for picking. Used for
	// error-group triage ownership and release manual-test / failure assignment.
	let {
		assignedTo,
		assignedToEmail,
		members,
		onFocus,
		onChange,
		label = 'Assign',
		disabled = false,
	}: {
		assignedTo: number | null;
		assignedToEmail: string | null;
		members: OrgMember[];
		/** Called when the select gains focus — the caller lazily loads members. */
		onFocus: () => void;
		/** Called with the chosen user id, or null to un-assign. */
		onChange: (userId: number | null) => void;
		label?: string;
		disabled?: boolean;
	} = $props();

	function shortName(email: string | null | undefined): string {
		if (!email) return '';
		const local = email.split('@')[0];
		return local
			.split(/[._+-]/)
			.filter(Boolean)
			.map((p) => p[0].toUpperCase() + p.slice(1))
			.join(' ');
	}
</script>

<div class="assignee-wrap">
	{#if assignedToEmail}
		<div class="assignee-chip" title={assignedToEmail}>
			<span class="avatar">{assignedToEmail[0].toUpperCase()}</span>
			<span class="assignee-name">{shortName(assignedToEmail)}</span>
		</div>
	{:else}
		<span class="dim">Unassigned</span>
	{/if}
	{#if !disabled}
		<select
			class="assignee-select"
			value={assignedTo ?? ''}
			onfocus={onFocus}
			onchange={(e) => {
				const val = (e.target as HTMLSelectElement).value;
				onChange(val ? Number(val) : null);
			}}
			aria-label={label}
		>
			<option value="">Unassigned</option>
			{#if assignedToEmail && !members.find((m) => m.id === assignedTo)}
				<!-- Keep the current assignee selectable even if they're not in the
				     freshly-loaded member list (deleted/stale record). -->
				<option value={assignedTo}>{assignedToEmail}</option>
			{/if}
			{#each members as m (m.id)}
				<option value={m.id}>{m.email}</option>
			{/each}
		</select>
	{/if}
</div>

<style>
	.assignee-wrap {
		position: relative;
		display: flex;
		align-items: center;
		min-height: 24px;
	}
	.assignee-select {
		position: absolute;
		inset: 0;
		width: 100%;
		opacity: 0;
		cursor: pointer;
		border: none;
		background: transparent;
	}
	.assignee-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.15rem 0.55rem 0.15rem 0.15rem;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.78rem;
		max-width: 100%;
	}
	.assignee-chip .avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: #2563eb;
		color: #fff;
		font-size: 0.7rem;
		font-weight: 600;
		flex-shrink: 0;
	}
	.assignee-chip .assignee-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dim {
		color: var(--text-muted);
	}
</style>
