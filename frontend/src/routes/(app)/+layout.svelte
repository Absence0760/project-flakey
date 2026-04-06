<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { restoreAuth, getAuth, subscribe, logout, type User } from '$lib/auth';

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

	onMount(() => {
		restoreAuth();
		const auth = getAuth();
		user = auth.user;
		ready = true;

		if (!auth.token) {
			goto('/login');
		}

		return subscribe(() => {
			const auth = getAuth();
			user = auth.user;
			if (!auth.token) {
				goto('/login');
			}
		});
	});

	function handleLogout() {
		logout();
	}

	function isActive(href: string, pathname: string): boolean {
		if (href === '/') return pathname === '/' || pathname.startsWith('/runs');
		if (href === '/dashboard') return pathname === '/dashboard';
		return pathname.startsWith(href);
	}
</script>

{#if !ready || !user}
	<div class="loading-screen"></div>
{:else}
	<div class="shell">
		<aside class="sidebar">
			<a href="/" class="logo">Flakey</a>
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
				<div class="user-row">
					<a
						href="/profile"
						class="nav-item user-link"
						class:active={$page.url.pathname === '/profile'}
					>
						<span class="avatar">{user?.name?.charAt(0)?.toUpperCase() ?? 'U'}</span>
						<span class="user-name">{user?.name || user?.email || 'Profile'}</span>
					</a>
					<button class="sign-out-btn" onclick={handleLogout} title="Sign out">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3.5A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14H6M10.5 11.5L14 8l-3.5-3.5M5.5 8H14"/></svg>
					</button>
				</div>
			</div>
		</aside>
		<main>
			<slot />
		</main>
	</div>
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

	.avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		background: var(--border);
		color: var(--text-secondary);
		font-size: 0.7rem;
		font-weight: 700;
	}

	.user-row {
		display: flex;
		align-items: center;
	}

	.user-link {
		flex: 1;
		min-width: 0;
	}

	.user-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sign-out-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		margin-right: 0.75rem;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.15s, color 0.1s, background 0.1s;
	}

	.user-row:hover .sign-out-btn {
		opacity: 1;
	}

	.sign-out-btn:hover {
		background: var(--bg-hover);
		color: var(--color-fail);
	}

	main {
		flex: 1;
		min-width: 0;
		overflow-x: hidden;
	}
</style>
