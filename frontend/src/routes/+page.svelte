<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { restoreAuth, getAuth } from '$lib/stores/auth';

	// The root URL is an auth-aware redirect, NOT a marketing page.
	// Self-hosters deploy this app for their internal use — landing
	// on the URL should drop them straight into the product (signed
	// in) or the sign-in form (signed out), not a sales pitch.
	//
	// Marketing copy for visitors who don't yet have an account lives
	// at /welcome — a separate, optional route. Hosted-SaaS operators
	// (flakey.io) can redirect their public root to /welcome at the
	// CDN layer; self-hosters serve their root as the app entry.
	onMount(() => {
		restoreAuth();
		const auth = getAuth();
		goto(auth.token && auth.user ? '/dashboard' : '/login');
	});
</script>

<!--
  A minimal visible frame is rendered while the redirect fires (this
  is client-side; SSR is off for the whole app). Without ANY markup,
  Svelte hydration sometimes skips running the script tag on a route
  that's been adapter-static-prerendered.
-->
<div class="redirect-stub" aria-hidden="true"></div>

<style>
	.redirect-stub {
		min-height: 100vh;
		background: var(--bg, #ffffff);
	}
</style>
