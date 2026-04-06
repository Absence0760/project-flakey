<script lang="ts">
	import '../app.css';
</script>

<nav class="topbar">
	<a href="/" class="logo">Flakey</a>
</nav>

<main>
	<slot />
</main>

<style>
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1.5rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-secondary);
	}

	.logo {
		font-weight: 700;
		font-size: 1.1rem;
		color: var(--text);
		text-decoration: none;
	}

	main {
		min-height: calc(100vh - 3rem);
	}
</style>
