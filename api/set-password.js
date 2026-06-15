// Vercel serverless function — admin-only password reset for CBT students.
// Environment variables required (set in Vercel project settings):
//   SUPABASE_URL            — e.g. https://zrkkurxfadlilwezqnxf.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — service role key (never expose in frontend)

const https = require('https');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SERVICE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL      = 'nuele4409@gmail.com';

function supaFetch(path, method, extraHeaders, body) {
    return new Promise(function (resolve, reject) {
        var url   = new URL(SUPABASE_URL + path);
        var bodyStr = body ? JSON.stringify(body) : null;
        var headers = Object.assign({
            'apikey': SERVICE_KEY,
            'Authorization': 'Bearer ' + SERVICE_KEY,
        }, extraHeaders);
        if (bodyStr) {
            headers['Content-Type']   = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }
        var req = https.request({
            hostname: url.hostname,
            path:     url.pathname + (url.search || ''),
            method:   method,
            headers:  headers,
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end',  function () {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return; }

    if (!SUPABASE_URL || !SERVICE_KEY) {
        res.status(500).json({ error: 'Server not configured — add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to Vercel env vars.' });
        return;
    }

    // ── 1. Verify caller JWT ───────────────────────────────────────────────
    var token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) { res.status(401).json({ error: 'Not authenticated.' }); return; }

    var callerRes = await supaFetch('/auth/v1/user', 'GET', { 'Authorization': 'Bearer ' + token }, null);
    if (callerRes.status !== 200 || !callerRes.body.id) {
        res.status(401).json({ error: 'Invalid or expired session.' }); return;
    }
    var callerId    = callerRes.body.id;
    var callerEmail = (callerRes.body.email || '').toLowerCase();

    // ── 2. Check caller is admin ───────────────────────────────────────────
    var profRes = await supaFetch(
        '/rest/v1/profiles?id=eq.' + callerId + '&select=is_admin',
        'GET', {}, null
    );
    var profs   = Array.isArray(profRes.body) ? profRes.body : [];
    var isAdmin = (profs[0] && profs[0].is_admin) ||
                  callerEmail === ADMIN_EMAIL.toLowerCase();
    if (!isAdmin) { res.status(403).json({ error: 'Admin only.' }); return; }

    // ── 3. Validate request body ───────────────────────────────────────────
    var body     = req.body || {};
    var email    = (body.email    || '').trim().toLowerCase();
    var password = (body.password || '');
    if (!email || !password) {
        res.status(400).json({ error: 'email and password are required.' }); return;
    }
    if (password.length < 6) {
        res.status(400).json({ error: 'Password must be at least 6 characters.' }); return;
    }

    // ── 4. Look up target user ID via profiles ─────────────────────────────
    var targetRes = await supaFetch(
        '/rest/v1/profiles?email=eq.' + encodeURIComponent(email) + '&select=id',
        'GET', {}, null
    );
    var targets = Array.isArray(targetRes.body) ? targetRes.body : [];
    if (targets.length === 0) {
        res.status(404).json({ error: 'No account found for ' + email + '.' }); return;
    }
    var targetId = targets[0].id;

    // ── 5. Update password via Supabase Auth Admin API ─────────────────────
    var updateRes = await supaFetch(
        '/auth/v1/admin/users/' + targetId,
        'PUT', {}, { password: password }
    );
    if (updateRes.status !== 200) {
        var msg = (updateRes.body && updateRes.body.message) ? updateRes.body.message : 'Failed to update password.';
        res.status(500).json({ error: msg }); return;
    }

    res.status(200).json({ ok: true });
};
