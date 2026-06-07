import { API_URL } from "../utils/config.js";

export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  orgId: number;
  orgRole: string;
  // Set when the active org enforces SSO and this session was NOT established
  // via SSO — the session is restricted server-side until SSO is completed.
  ssoRequired?: boolean;
}

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
}

let state: AuthState = {
  user: null,
  token: null,
  refreshToken: null,
};

let listeners: Array<() => void> = [];

function notify() {
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export function getAuth(): AuthState {
  return state;
}

export function getToken(): string | null {
  return state.token;
}

export function isLoggedIn(): boolean {
  return state.token !== null;
}

// localStorage key names — kept as "bt_*" from the earlier "Better Testing"
// rebrand even though the product brand is now Flakey again. They're not
// user-visible; renaming would silently sign out every existing user with
// no upside. restoreAuth() still migrates the original "flakey_*" keys
// it may find from pre-bt_ installs (one-shot, idempotent).
const KEY_TOKEN = "bt_token";
const KEY_USER = "bt_user";
const KEY_REFRESH = "bt_refresh";

export function setAuth(user: User, token: string, refreshToken?: string) {
  state = { user, token, refreshToken: refreshToken ?? state.refreshToken };
  localStorage.setItem(KEY_TOKEN, token);
  localStorage.setItem(KEY_USER, JSON.stringify(user));
  if (refreshToken) localStorage.setItem(KEY_REFRESH, refreshToken);
  notify();
}

export function clearAuth() {
  state = { user: null, token: null, refreshToken: null };
  localStorage.removeItem(KEY_TOKEN);
  localStorage.removeItem(KEY_USER);
  localStorage.removeItem(KEY_REFRESH);
  // Also clear server-side httpOnly cookies
  fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
  notify();
}

export function restoreAuth(): boolean {
  // Try new keys first; fall back to legacy "flakey_*" keys for a one-time
  // migration so existing sessions survive the rename.
  let token = localStorage.getItem(KEY_TOKEN);
  let userJson = localStorage.getItem(KEY_USER);
  let refreshToken: string | null = localStorage.getItem(KEY_REFRESH);

  const migratedFromLegacy = !token && !!localStorage.getItem("flakey_token");
  if (migratedFromLegacy) {
    token = localStorage.getItem("flakey_token");
    userJson = localStorage.getItem("flakey_user");
    refreshToken = localStorage.getItem("flakey_refresh");
  }

  if (token && userJson) {
    try {
      state = { token, user: JSON.parse(userJson), refreshToken };
      if (migratedFromLegacy) {
        // Write under new keys and remove old ones (one-shot migration).
        localStorage.setItem(KEY_TOKEN, token);
        localStorage.setItem(KEY_USER, userJson);
        if (refreshToken) localStorage.setItem(KEY_REFRESH, refreshToken);
        localStorage.removeItem("flakey_token");
        localStorage.removeItem("flakey_user");
        localStorage.removeItem("flakey_refresh");
      }
      return true;
    } catch {
      clearAuth();
    }
  }
  return false;
}

// Deduplicates concurrent refresh calls so only one /auth/refresh request
// flies at a time. All concurrent callers await the same promise; the
// promise is cleared in `finally` so the next 401 starts a fresh attempt.
let refreshPromise: Promise<boolean> | null = null;

function getOrStartRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshAccessToken().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = state.refreshToken;
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) return false;

    const data = await res.json() as { token: string; refreshToken: string; user: User };
    setAuth(data.user, data.token, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export interface LoginResult {
  user: User;
  // When the org enforces SSO and this password session is restricted, the
  // caller should send the user to the IdP via /auth/sso/<orgSlug>/start.
  ssoRequired?: boolean;
  orgSlug?: string | null;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Login failed");
  }

  const data = await res.json() as { token: string; refreshToken: string; user: User; ssoRequired?: boolean; orgSlug?: string | null };
  setAuth(data.user, data.token, data.refreshToken);
  return { user: data.user, ssoRequired: data.ssoRequired, orgSlug: data.orgSlug };
}

export async function register(email: string, password: string, name: string, inviteToken?: string): Promise<User> {
  const res = await fetch(`${API_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password, name, invite_token: inviteToken }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Registration failed");
  }

  const data = await res.json() as { token: string; refreshToken: string; user: User };
  setAuth(data.user, data.token, data.refreshToken);
  return data.user;
}

export async function acceptInvite(token: string): Promise<{ user: User; org_name: string }> {
  const res = await authFetch(`${API_URL}/orgs/invites/${token}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to accept invite");
  }

  const data = await res.json() as { token: string; user: User; org_name: string };
  setAuth(data.user, data.token);
  return { user: data.user, org_name: data.org_name };
}

export interface Org {
  id: number;
  name: string;
  slug: string;
  role: string;
}

export async function fetchOrgs(): Promise<Org[]> {
  const res = await authFetch(`${API_URL}/auth/me`);
  if (!res.ok) return [];
  const data = await res.json() as { orgs: Org[] };
  return data.orgs;
}

export async function switchOrg(orgId: number): Promise<void> {
  const res = await authFetch(`${API_URL}/auth/switch-org`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to switch organization");
  }

  const data = await res.json() as { token: string; user: User };
  setAuth(data.user, data.token);
}

export function logout() {
  clearAuth();
}

/**
 * Wrapper for fetch that adds the auth token.
 * Automatically refreshes expired tokens using the refresh token.
 */
export async function authFetch(url: string, opts?: RequestInit): Promise<Response> {
  const headers = new Headers(opts?.headers);
  if (state.token) {
    headers.set("Authorization", `Bearer ${state.token}`);
  }

  let res = await fetch(url, { ...opts, headers, credentials: "include" });

  // If 401, try refreshing the token once.
  // getOrStartRefresh() deduplicates concurrent callers so only one
  // /auth/refresh request flies even when multiple authFetch calls race.
  if (res.status === 401 && state.refreshToken) {
    const refreshed = await getOrStartRefresh();
    if (refreshed) {
      headers.set("Authorization", `Bearer ${state.token}`);
      res = await fetch(url, { ...opts, headers, credentials: "include" });
    } else {
      clearAuth();
    }
  } else if (res.status === 401) {
    clearAuth();
  }

  return res;
}
