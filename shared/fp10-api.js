// ============================================================================
// SHARED SUPABASE CLIENT + EDGE FUNCTION CALLER
// Include this after the Supabase JS CDN script on every page:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
//   <script src="shared/fp10-api.js"></script>
// ============================================================================

// TODO: fill in from Supabase dashboard → Project Settings → API
const SUPABASE_URL = 'https://mzrotyukjrnwehjszpmh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16cm90eXVranJud2VoanN6cG1oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwODkyOTIsImV4cCI6MjEwMTY2NTI5Mn0.iFckHF2upKJvhsc10mtbwb6tbaPZyBgCu00UzzkqKNs';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Signs in with the app's own User ID + Passcode fields rather than a real
 * email/password. Looks up the real (synthetic) email behind that user_id
 * via the email_for_user_id RPC, then does a normal Supabase password
 * sign-in with it. Throws a generic error on any failure — deliberately
 * doesn't distinguish "no such user ID" from "wrong passcode" from
 * "account inactive", so a login screen can't be used to enumerate valid IDs.
 */
async function signInWithUserId(userId, passcode) {
  const { data: email, error: lookupError } = await supabaseClient
    .rpc('email_for_user_id', { lookup_user_id: userId.trim() });

  if (lookupError || !email) {
    throw new Error('Incorrect User ID or Passcode.');
  }

  const { error: signInError } = await supabaseClient.auth.signInWithPassword({
    email,
    password: passcode,
  });

  if (signInError) {
    throw new Error('Incorrect User ID or Passcode.');
  }

  // Reject inactive accounts even though the Supabase password check passed —
  // active is enforced again server-side (RLS + Edge Function), this just
  // gives an immediate, honest message instead of a silently empty app.
  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('active')
    .single();

  if (!profile?.active) {
    await supabaseClient.auth.signOut();
    throw new Error('This account has been deactivated. Contact your administrator.');
  }
}

/**
 * Redirects to the login page if there is no active session, or if the
 * account has since been set inactive. Call this at the top of every
 * protected page (splash page, FP10SS/FP10HNC managers).
 * Returns the session if one exists and is active.
 */
async function requireSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }

  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('active')
    .eq('id', session.user.id)
    .single();

  if (!profile?.active) {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
    return null;
  }

  return session;
}

/**
 * Fetches the logged-in user's trust — name + a signed URL for their logo.
 * Returns null if no trust is assigned yet.
 */
async function getMyTrust() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabaseClient
    .from('profiles')
    .select('trust_id')
    .eq('id', user.id)
    .single();

  if (!profile?.trust_id) return null;

  const { data: trust } = await supabaseClient
    .from('trusts')
    .select('id, name, logo_path')
    .eq('id', profile.trust_id)
    .single();

  if (!trust) return null;

  let logoUrl = null;
  if (trust.logo_path) {
    const { data: signed } = await supabaseClient
      .storage
      .from('trust-logos')
      .createSignedUrl(trust.logo_path, 60 * 60); // 1 hour, plenty for one PDF generation
    logoUrl = signed?.signedUrl ?? null;
  }

  return { id: trust.id, name: trust.name, logoUrl };
}

/**
 * Calls the fp10-logic Edge Function with the given action + payload.
 * Throws an Error with a user-facing message on failure.
 */
async function callFp10Logic(action, payload) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error('Your session has expired — please log in again.');

  const res = await fetch(`${SUPABASE_URL}/functions/v1/fp10-logic`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });

  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Something went wrong processing that request.');
  return body;
}

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.href = 'login.html';
}
