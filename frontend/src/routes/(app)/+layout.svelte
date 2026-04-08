<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { restoreAuth, getAuth, subscribe, logout, fetchOrgs, switchOrg, type User, type Org } from '$lib/auth';
	import Toasts from '$lib/components/Toasts.svelte';

	const nav = [
		{ href: '/dashboard', label: 'Dashboard', icon: '◇' },
		{ href: '/', label: 'Runs', icon: '▶' },
		{ href: '/flaky', label: 'Flaky', icon: '⚡' },
		{ href: '/slowest', label: 'Slowest', icon: '◷' },
		{ href: '/errors', label: 'Errors', icon: '✗' },
		{ href: '/settings', label: 'Settings', icon: '⚙' },
	];

	let user = $state<User | null>(null);
	let ready = $state(false);
	let orgs = $state<Org[]>([]);
	let orgDropdownOpen = $state(false);
	let profileOpen = $state(false);

	const currentOrg = $derived(orgs.find(o => o.id === user?.orgId));

	onMount(() => {
		restoreAuth();
		const auth = getAuth();
		user = auth.user;
		ready = true;

		if (!auth.token) {
			goto('/login');
		} else {
			loadOrgs();
		}

		return subscribe(() => {
			const auth = getAuth();
			user = auth.user;
			if (!auth.token) {
				goto('/login');
			}
		});
	});

	async function loadOrgs() {
		orgs = await fetchOrgs();
	}

	async function handleSwitchOrg(orgId: number) {
		orgDropdownOpen = false;
		await switchOrg(orgId);
		goto('/dashboard');
	}

	function handleLogout() {
		logout();
	}

	function isActive(href: string, pathname: string): boolean {
		if (href === '/') return pathname === '/' || pathname.startsWith('/runs');
		if (href === '/dashboard') return pathname === '/dashboard';
		return pathname.startsWith(href);
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			orgDropdownOpen = false;
			profileOpen = false;
		}
	}

	function handleGlobalClick() {
		orgDropdownOpen = false;
		profileOpen = false;
	}
</script>

<svelte:window onclick={handleGlobalClick} onkeydown={handleGlobalKeydown} />

{#if !ready || !user}
	<div class="loading-screen"></div>
{:else}
	<div class="shell">
		<aside class="sidebar">
			<a href="/" class="logo">Flakey</a>
			{#if orgs.length > 0}
				<div class="org-switcher">
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="org-current"
						onclick={(e) => { e.stopPropagation(); orgDropdownOpen = !orgDropdownOpen; }}
					>
						<span class="org-name">{currentOrg?.name ?? 'Organization'}</span>
						<svg class="org-chevron" class:open={orgDropdownOpen} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>
					</div>
					{#if orgDropdownOpen}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="org-dropdown" onclick={(e) => e.stopPropagation()}>
							{#each orgs as org}
								<button
									class="org-option"
									class:active={org.id === user?.orgId}
									onclick={() => handleSwitchOrg(org.id)}
									disabled={org.id === user?.orgId}
								>
									<span class="org-option-name">{org.name}</span>
									<span class="org-option-role">{org.role}</span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
			<nav>
				{#each nav as item}
					<a
						href={item.href}
						class="nav-item"
						class:active={isActive(item.href, $page.url.pathname)}
					>
						<span class="nav-icon">{item.icon}</span>
						{item.label}
					</a>
				{/each}
			</nav>
			<div class="sidebar-bottom">
				<div class="profile-wrapper">
					{#if profileOpen}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="profile-popover" onclick={(e) => e.stopPropagation()}>
							<div class="profile-header">
								<span class="profile-avatar">{user?.name?.charAt(0)?.toUpperCase() ?? 'U'}</span>
								<div class="profile-identity">
									<span class="profile-name">{user?.name || 'User'}</span>
									<span class="profile-email">{user?.email}</span>
								</div>
							</div>
							<div class="profile-details">
								<div class="profile-field">
									<span class="profile-field-label">Role</span>
									<span class="profile-role-badge">{user?.orgRole ?? user?.role ?? '—'}</span>
								</div>
								{#if currentOrg}
									<div class="profile-field">
										<span class="profile-field-label">Org</span>
										<span class="profile-field-value">{currentOrg.name}</span>
									</div>
								{/if}
							</div>
							<div class="profile-actions">
								<button class="profile-action-btn danger" onclick={handleLogout}>
									<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3.5A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14H6M10.5 11.5L14 8l-3.5-3.5M5.5 8H14"/></svg>
									Sign out
								</button>
							</div>
						</div>
					{/if}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="user-row"
						class:active={profileOpen}
						onclick={(e) => { e.stopPropagation(); profileOpen = !profileOpen; }}
					>
						<span class="avatar">{user?.name?.charAt(0)?.toUpperCase() ?? 'U'}</span>
						<div class="user-info">
							<span class="user-name">{user?.name || 'User'}</span>
							<span class="user-email">{user?.email}</span>
						</div>
						<svg class="user-chevron" class:open={profileOpen} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10l4-4 4 4"/></svg>
					</div>
				</div>
			</div>
		</aside>
		<main>
			<slot />
		</main>
	</div>
	<Toasts />
{/if}

<style>
	.loading-screen {
		min-height: 100vh;
		background: var(--bg);
	}

	.shell {
		display: flex;
		min-height: 100vh;
	}

	.sidebar {
		width: 200px;
		flex-shrink: 0;
		background: var(--bg-secondary);
		border-right: 1px solid var(--border);
		padding: 1.25rem 0;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		position: sticky;
		top: 0;
		height: 100vh;
		overflow-y: auto;
	}

	.logo {
		font-weight: 700;
		font-size: 1.25rem;
		color: var(--text);
		text-decoration: none;
		padding: 0 1.25rem;
	}

	.org-switcher {
		position: relative;
		padding: 0 0.75rem;
	}

	.org-current {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.4rem 0.5rem;
		border-radius: 6px;
		cursor: pointer;
		transition: background 0.1s;
	}

	.org-current:hover {
		background: var(--bg-hover);
	}

	.org-name {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.org-chevron {
		color: var(--text-muted);
		flex-shrink: 0;
		transition: transform 0.15s;
	}

	.org-chevron.open {
		transform: rotate(180deg);
	}

	.org-dropdown {
		position: absolute;
		top: 100%;
		left: 0.75rem;
		right: 0.75rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.25rem;
		z-index: 100;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		max-height: 240px;
		overflow-y: auto;
	}

	.org-option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 0.4rem 0.5rem;
		border: none;
		border-radius: 4px;
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background 0.1s;
		color: var(--text);
	}

	.org-option:hover:not(:disabled) {
		background: var(--bg-hover);
	}

	.org-option.active {
		background: var(--bg-hover);
		cursor: default;
	}

	.org-option-name {
		font-size: 0.8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.org-option-role {
		font-size: 0.65rem;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
		flex-shrink: 0;
		margin-left: 0.5rem;
	}

	nav {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.sidebar-bottom {
		margin-top: auto;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 1.25rem;
		color: var(--text-secondary);
		text-decoration: none;
		font-size: 0.9rem;
		transition: background 0.1s, color 0.1s;
	}

	.nav-item:hover {
		background: var(--bg-hover);
		color: var(--text);
	}

	.nav-item.active {
		color: var(--text);
		background: var(--bg-hover);
		font-weight: 600;
	}

	.nav-icon {
		font-size: 0.85rem;
		width: 1.25rem;
		text-align: center;
	}

	/* Profile area */
	.profile-wrapper {
		position: relative;
	}

	.user-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 1.25rem;
		cursor: pointer;
		transition: background 0.1s;
	}

	.user-row:hover, .user-row.active {
		background: var(--bg-hover);
	}

	.avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		background: var(--link);
		color: #fff;
		font-size: 0.72rem;
		font-weight: 700;
		flex-shrink: 0;
		letter-spacing: 0.02em;
	}

	.user-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.user-name {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.2;
	}

	.user-email {
		font-size: 0.68rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.3;
	}

	.user-chevron {
		color: var(--text-muted);
		flex-shrink: 0;
		transition: transform 0.15s;
	}

	.user-chevron.open {
		transform: rotate(180deg);
	}

	/* Profile popover */
	.profile-popover {
		position: absolute;
		bottom: calc(100% + 6px);
		left: 0.5rem;
		right: 0.5rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.15);
		z-index: 200;
		overflow: hidden;
	}

	.profile-header {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 1rem 0.85rem 0.75rem;
	}

	.profile-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		background: var(--link);
		color: #fff;
		font-size: 0.9rem;
		font-weight: 700;
		flex-shrink: 0;
	}

	.profile-identity {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.profile-name {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.profile-email {
		font-size: 0.72rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.profile-details {
		padding: 0 0.85rem 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		border-bottom: 1px solid var(--border);
	}

	.profile-field {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 0.78rem;
	}

	.profile-field-label {
		color: var(--text-muted);
	}

	.profile-field-value {
		color: var(--text-secondary);
	}

	.profile-role-badge {
		padding: 0.1rem 0.45rem;
		border-radius: 10px;
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: capitalize;
		background: color-mix(in srgb, var(--link) 12%, transparent);
		color: var(--link);
	}

	.profile-actions {
		padding: 0.4rem 0.5rem;
	}

	.profile-action-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.4rem 0.5rem;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.8rem;
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
	}

	.profile-action-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}

	.profile-action-btn.danger:hover {
		background: var(--error-bg);
		color: var(--color-fail);
	}

	main {
		flex: 1;
		min-width: 0;
		overflow-x: hidden;
	}
</style>
