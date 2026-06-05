<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { restoreAuth, getAuth } from '$lib/stores/auth';

	// The root URL is an auth-aware redirect, NOT a page of its own.
	// Signed-in visitors drop straight into the product; signed-out
	// visitors land on the /welcome marketing page (which carries its
	// own "Sign in" / "Create an account" CTAs), rather than being
	// dumped directly at the bare sign-in form.
	onMount(() => {
		restoreAuth();
		const auth = getAuth();
		goto(auth.token && auth.user ? '/dashboard' : '/welcome');
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
