// OIDC Authorization-Code + PKCE client primitives for enterprise SSO login.
//
// Scope of this module: the protocol mechanics only — discovery, the authorize
// URL, the token exchange, and (the security-critical part) ID-token
// verification against the IdP's JWKS. It deliberately knows nothing about
// Flakey users, orgs, or sessions; routes/sso.ts wires it to the app model.
//
// Token validation is non-negotiable (proposal trust boundary #3): the ID
// token signature is verified against the IdP JWKS and iss / aud / exp / nonce
// are all checked. jose rejects alg:"none" and unsigned tokens by default; we
// pin nothing weaker than the IdP advertises. We never trust a claim we did
// not cryptographically verify.

import crypto from "crypto";
import dns from "dns";
import net from "net";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

// ── SSRF guard (security review finding #3, fetch-time) ──────────────────────
// The OIDC issuer is admin-configured but the backend fetches it server-side
// (discovery, JWKS, token exchange). Beyond the save-time literal check in
// config.ts, we resolve each target host and refuse to connect to a private /
// loopback / link-local / metadata address right before fetching. Loopback is
// allowed only outside production (local Keycloak dev). This closes the
// hostname-that-resolves-to-an-internal-IP vector; a DNS rebind *between* this
// check and the socket connect is the documented residual risk.
export function isBlockedIp(ip: string, isProd: boolean): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return isProd; // loopback: blocked only in prod
    if (a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return isProd; // loopback
    if (/^f[cd]/.test(lower) || /^fe80/.test(lower)) return true; // ULA / link-local
    // IPv4-mapped — re-check the embedded v4. Node normalises
    // `::ffff:169.254.169.254` to the hex form `::ffff:a9fe:a9fe`, so handle both.
    const mapped = /^::ffff:(.+)$/.exec(lower);
    if (mapped) {
      const tail = mapped[1];
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return isBlockedIp(tail, isProd);
      const hex = tail.replace(/:/g, "");
      if (/^[0-9a-f]{8}$/.test(hex)) {
        const v4 = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(".");
        return isBlockedIp(v4, isProd);
      }
    }
    return false;
  }
  return false;
}

export async function assertPublicHost(urlStr: string): Promise<void> {
  const host = new URL(urlStr).hostname;
  const isProd = process.env.NODE_ENV === "production";
  const addrs: string[] = net.isIP(host)
    ? [host]
    : (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
  for (const ip of addrs) {
    if (isBlockedIp(ip, isProd)) {
      throw new Error(`Refusing to reach a non-public address for SSO (${host} -> ${ip})`);
    }
  }
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

// Discovery documents + their JWKS are cached per-issuer. Discovery rarely
// changes; jose's remote JWKS set does its own keyed-by-`kid` caching and
// cooldown-limited refetch for rotation, so we hold the set object per issuer.
interface CachedIssuer {
  discovery: OidcDiscovery;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  fetchedAt: number;
}
const issuerCache = new Map<string, CachedIssuer>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h — re-fetch the discovery doc hourly.

// Network calls (discovery, token exchange) are bounded so a hung or hostile
// IdP can't pin a request open. Fail closed on timeout.
const NETWORK_TIMEOUT_MS = 10_000;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  await assertPublicHost(url); // SSRF guard — block private/metadata targets
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      // Body may carry an OAuth error code (e.g. invalid_grant); include a
      // short, non-secret excerpt so config mistakes are diagnosable without
      // leaking tokens.
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`HTTP ${res.status} from ${url}: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve (and cache) the issuer's discovery document + JWKS. `issuer` is the
 * org-configured base; the well-known path is appended per OIDC Discovery.
 * Validates that the document's `issuer` matches the configured value — a
 * mismatch means a misconfigured or substituted IdP and is rejected.
 */
export async function getIssuer(issuer: string): Promise<CachedIssuer> {
  const cached = issuerCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached;

  const wellKnown = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const doc = (await fetchJson(wellKnown)) as Partial<OidcDiscovery>;
  if (
    !doc.issuer ||
    !doc.authorization_endpoint ||
    !doc.token_endpoint ||
    !doc.jwks_uri
  ) {
    throw new Error("IdP discovery document is missing required endpoints");
  }
  // The discovery doc's own `issuer` must match what the admin configured;
  // otherwise the JWKS we fetch isn't provably the configured IdP's.
  if (doc.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw new Error(
      `IdP issuer mismatch: configured ${issuer}, discovery reports ${doc.issuer}`,
    );
  }
  // jose fetches the JWKS itself, so guard its host here before handing it off.
  await assertPublicHost(doc.jwks_uri);
  const entry: CachedIssuer = {
    discovery: doc as OidcDiscovery,
    jwks: createRemoteJWKSet(new URL(doc.jwks_uri)),
    fetchedAt: Date.now(),
  };
  issuerCache.set(issuer, entry);
  return entry;
}

/** Reset the discovery/JWKS cache. For tests that point at different IdPs. */
export function _resetIssuerCache(): void {
  issuerCache.clear();
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Generate a PKCE verifier + S256 challenge (RFC 7636). */
export function generatePkce(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Opaque, URL-safe random value for `state` / `nonce`. */
export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export interface AuthorizeUrlParams {
  issuer: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope?: string;
}

/** Build the IdP authorize URL for an Authorization-Code + PKCE flow. */
export async function buildAuthorizeUrl(p: AuthorizeUrlParams): Promise<string> {
  const { discovery } = await getIssuer(p.issuer);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("scope", p.scope ?? "openid email profile");
  url.searchParams.set("state", p.state);
  url.searchParams.set("nonce", p.nonce);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TokenExchangeParams {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
}

/**
 * Exchange an authorization code for tokens at the IdP token endpoint.
 * Confidential clients authenticate with HTTP Basic (client_secret_basic);
 * public clients (no secret) rely on PKCE alone.
 */
export async function exchangeCode(p: TokenExchangeParams): Promise<TokenResponse> {
  const { discovery } = await getIssuer(p.issuer);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (p.clientSecret) {
    const basic = Buffer.from(`${p.clientId}:${p.clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  } else {
    body.set("client_id", p.clientId);
  }
  const json = (await fetchJson(discovery.token_endpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  })) as TokenResponse;
  if (!json.id_token) throw new Error("Token response did not include an id_token");
  return json;
}

export interface VerifyIdTokenParams {
  issuer: string;
  clientId: string;
  idToken: string;
  expectedNonce: string;
}

/**
 * Verify an ID token end-to-end: signature against the IdP JWKS, `iss` and
 * `aud`, expiry, and the `nonce` we issued for this transaction. Returns the
 * verified claims. Throws on any failure — the caller treats a throw as
 * "reject this login", never as a soft fallback.
 */
export async function verifyIdToken(p: VerifyIdTokenParams): Promise<JWTPayload> {
  const { jwks } = await getIssuer(p.issuer);
  const { payload } = await jwtVerify(p.idToken, jwks, {
    issuer: p.issuer.replace(/\/+$/, ""),
    audience: p.clientId,
  });
  // Replay/CSRF defence: the nonce binds this ID token to the authorize
  // request we initiated. A token minted for a different transaction (or
  // replayed) carries a different nonce and is rejected.
  if (payload.nonce !== p.expectedNonce) {
    throw new Error("ID token nonce does not match the login transaction");
  }
  return payload;
}
