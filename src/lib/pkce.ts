// PKCE (RFC 7636) helpers built on Web Crypto — works in browsers and Node 20+.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** High-entropy random code verifier (43–128 chars per RFC 7636). */
export function generateCodeVerifier(): string {
  const random = crypto.getRandomValues(new Uint8Array(64));
  return base64UrlEncode(random); // 86 chars — within the allowed range.
}

/** S256 code challenge for a verifier. */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** Random OAuth state value for CSRF protection. */
export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
