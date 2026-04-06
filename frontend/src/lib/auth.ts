const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  orgId: number;
  orgRole: string;
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

export function setAuth(user: User, token: string, refreshToken?: string) {
  state = { user, token, refreshToken: refreshToken ?? state.refreshToken };
  localStorage.setItem("flakey_token", token);
  localStorage.setItem("flakey_user", JSON.stringify(user));
  if (refreshToken) localStorage.setItem("flakey_refresh", refreshToken);
  notify();
}

export function clearAuth() {
  state = { user: null, token: null, refreshToken: null };
  localStorage.removeItem("flakey_token");
  localStorage.removeItem("flakey_user");
  localStorage.removeItem("flakey_refresh");
  // Also clear server-side httpOnly cookies
  fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
  notify();
}

export function restoreAuth(): boolean {
  const token = localStorage.getItem("flakey_token");
  const userJson = localStorage.getItem("flakey_user");
  const refreshToken = localStorage.getItem("flakey_refresh");
  if (token && userJson) {
    try {
      state = { token, user: JSON.parse(userJson), refreshToken };
      return true;
    } catch {
      clearAuth();
    }
  }
  return false;
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

export async function login(email: string, password: string): Promise<User> {
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

  const data = await res.json() as { token: string; refreshToken: string; user: User };
  setAuth(data.user, data.token, data.refreshToken);
  return data.user;
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

  // If 401, try refreshing the token once
  if (res.status === 401 && state.refreshToken) {
    const refreshed = await refreshAccessToken();
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
