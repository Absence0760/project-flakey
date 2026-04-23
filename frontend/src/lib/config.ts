/**
 * Centralised runtime config for the frontend.
 *
 * Import API_URL from here instead of re-declaring
 * `import.meta.env.VITE_API_URL ?? "http://localhost:3000"` in every file.
 */
export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
