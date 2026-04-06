<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';

	const nav = [
		{ href: '/dashboard', label: 'Dashboard', icon: '◇' },
		{ href: '/', label: 'Runs', icon: '▶' },
		{ href: '/flaky', label: 'Flaky', icon: '⚡' },
		{ href: '/errors', label: 'Errors', icon: '✗' },
		{ href: '/settings', label: 'Settings', icon: '⚙' },
	];

	function isActive(href: string, pathname: string): boolean {
		if (href === '/') return pathname === '/' || pathname.startsWith('/runs');
		if (href === '/dashboard') return pathname === '/dashboard';
		return pathname.startsWith(href);
	}
</script>

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
			<a
				href="/profile"
				class="nav-item"
				class:active={$page.url.pathname === '/profile'}
			>
				<span class="avatar">U</span>
				Profile
			</a>
		</div>
	</aside>
	<main>
		<slot />
	</main>
</div>

<style>
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

	main {
		flex: 1;
		min-width: 0;
		overflow-x: hidden;
	}
</style>
