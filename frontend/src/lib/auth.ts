const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
}

let state: AuthState = {
  user: null,
  token: null,
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

export function setAuth(user: User, token: string) {
  state = { user, token };
  localStorage.setItem("flakey_token", token);
  localStorage.setItem("flakey_user", JSON.stringify(user));
  notify();
}

export function clearAuth() {
  state = { user: null, token: null };
  localStorage.removeItem("flakey_token");
  localStorage.removeItem("flakey_user");
  notify();
}

export function restoreAuth(): boolean {
  const token = localStorage.getItem("flakey_token");
  const userJson = localStorage.getItem("flakey_user");
  if (token && userJson) {
    try {
      state = { token, user: JSON.parse(userJson) };
      return true;
    } catch {
      clearAuth();
    }
  }
  return false;
}

export async function login(email: string, password: string): Promise<User> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Login failed");
  }

  const data = await res.json() as { token: string; user: User };
  setAuth(data.user, data.token);
  return data.user;
}

export async function register(email: string, password: string, name: string): Promise<User> {
  const res = await fetch(`${API_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Registration failed");
  }

  const data = await res.json() as { token: string; user: User };
  setAuth(data.user, data.token);
  return data.user;
}

export function logout() {
  clearAuth();
}

/**
 * Wrapper for fetch that adds the auth token to requests.
 */
export async function authFetch(url: string, opts?: RequestInit): Promise<Response> {
  const headers = new Headers(opts?.headers);
  if (state.token) {
    headers.set("Authorization", `Bearer ${state.token}`);
  }
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    clearAuth();
  }
  return res;
}
