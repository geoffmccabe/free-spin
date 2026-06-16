// /lib/auth.js
// Shared verification for one-time spin tokens and admin-only API endpoints.
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify the HMAC signature on a signed spin token (`<uuid>.<hex-sig>`).
 * Returns true/false when SPIN_KEY is configured, or null when it isn't
 * (so callers can decide whether to fail open or closed).
 */
export function verifySignedToken(signedToken) {
  const key = process.env.SPIN_KEY;
  if (!key) return null; // not configured — caller decides
  const [raw, sig] = String(signedToken || '').split('.');
  if (!raw || !sig) return false;
  const expected = createHmac('sha256', key).update(raw).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Gate an API request to server admins.
 *  - verifies the token signature (when SPIN_KEY is set),
 *  - confirms the token exists in spin_tokens (bearer credential),
 *  - confirms that token's owner is an admin/superadmin of this server.
 * Returns { ok, role, discord_id } or { ok:false, status, error }.
 */
export async function requireAdmin(supabase, signedToken, server_id, { superadmin = false } = {}) {
  if (!signedToken) return { ok: false, status: 400, error: 'Token required' };
  if (!server_id) return { ok: false, status: 400, error: 'server_id required' };

  if (verifySignedToken(signedToken) === false) {
    return { ok: false, status: 403, error: 'Invalid or forged token' };
  }

  const { data: tok, error: tErr } = await supabase
    .from('spin_tokens')
    .select('discord_id')
    .eq('token', signedToken)
    .maybeSingle();
  if (tErr || !tok) return { ok: false, status: 400, error: 'Invalid token' };

  const { data: admin } = await supabase
    .from('server_admins')
    .select('role')
    .eq('discord_id', tok.discord_id)
    .eq('server_id', server_id)
    .maybeSingle();

  const role = admin?.role || null;
  const isAdmin = role === 'admin' || role === 'superadmin';
  if (!isAdmin) return { ok: false, status: 403, error: 'Admins only' };
  if (superadmin && role !== 'superadmin') return { ok: false, status: 403, error: 'Superadmin required' };

  return { ok: true, role, discord_id: tok.discord_id };
}
