// Vercel serverless function — admin-only bulk email campaign via Brevo.
// Env vars required (Vercel project settings):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY

const https = require('https');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BREVO_KEY     = process.env.BREVO_API_KEY;
const ADMIN_EMAIL   = 'nuele4409@gmail.com';

function supaFetch(path, method, body) {
    return new Promise(function (resolve, reject) {
        var url      = new URL(SUPABASE_URL + path);
        var bodyStr  = body ? JSON.stringify(body) : null;
        var headers  = { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY };
        if (bodyStr) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(bodyStr); }
        var req = https.request({ hostname: url.hostname, path: url.pathname + (url.search || ''), method: method, headers: headers }, function (res) {
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

function brevoFetch(path, method, body) {
    return new Promise(function (resolve, reject) {
        var bodyStr = body ? JSON.stringify(body) : null;
        var headers = { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' };
        if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
        var req = https.request({ hostname: 'api.brevo.com', path: path, method: method, headers: headers }, function (res) {
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
    if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed.' }); return; }

    if (!SUPABASE_URL || !SERVICE_KEY || !BREVO_KEY) {
        res.status(500).json({ error: 'Server misconfigured — ensure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and BREVO_API_KEY are set in Vercel env vars.' });
        return;
    }

    // ── 1. Verify admin ────────────────────────────────────────────────────
    var token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) { res.status(401).json({ error: 'Not authenticated.' }); return; }

    var callerRes = await supaFetch('/auth/v1/user', 'GET', null);
    // Supabase requires the user's own token for /auth/v1/user — we must override the header
    callerRes = await (function () {
        return new Promise(function (resolve, reject) {
            var url = new URL(SUPABASE_URL + '/auth/v1/user');
            var headers = { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + token };
            var req2 = https.request({ hostname: url.hostname, path: url.pathname, method: 'GET', headers: headers }, function (r) {
                var d = '';
                r.on('data', function (c) { d += c; });
                r.on('end',  function () {
                    try { resolve({ status: r.statusCode, body: JSON.parse(d) }); }
                    catch (e) { resolve({ status: r.statusCode, body: d }); }
                });
            });
            req2.on('error', reject);
            req2.end();
        });
    })();

    if (callerRes.status !== 200 || !callerRes.body.id) {
        res.status(401).json({ error: 'Invalid or expired session.' }); return;
    }
    var callerId    = callerRes.body.id;
    var callerEmail = (callerRes.body.email || '').toLowerCase();

    var profRes = await supaFetch('/rest/v1/profiles?id=eq.' + callerId + '&select=is_admin', 'GET', null);
    var profs   = Array.isArray(profRes.body) ? profRes.body : [];
    var isAdmin = (profs[0] && profs[0].is_admin) || callerEmail === ADMIN_EMAIL.toLowerCase();
    if (!isAdmin) { res.status(403).json({ error: 'Admin only.' }); return; }

    // ── 2. Validate request body ───────────────────────────────────────────
    var body        = req.body || {};
    var subject     = String(body.subject     || '').trim();
    var htmlContent = String(body.htmlContent || '').trim();
    if (!subject || !htmlContent) {
        res.status(400).json({ error: 'subject and htmlContent are required.' }); return;
    }

    // ── 3. Load free-tier students from Supabase ───────────────────────────
    var freeRes = await supaFetch(
        '/rest/v1/profiles?has_post_utme_access=eq.false&select=email,full_name',
        'GET', null
    );
    if (!Array.isArray(freeRes.body)) {
        res.status(500).json({ error: 'Failed to query student list.' }); return;
    }
    var students = freeRes.body.filter(function (s) { return s.email; });
    if (!students.length) {
        res.status(200).json({ sent: 0, message: 'No free-tier students with email addresses found.' });
        return;
    }

    // ── 4. Build Brevo messageVersions (one per student = private delivery) ─
    var messageVersions = students.map(function (s) {
        var firstName = (s.full_name || 'Student').split(' ')[0];
        return {
            to:     [{ email: s.email, name: s.full_name || 'Student' }],
            params: { name: firstName },
        };
    });

    // ── 5. Send via Brevo transactional batch API ──────────────────────────
    var brevoRes = await brevoFetch('/v3/smtp/email', 'POST', {
        sender:          { name: 'Inside OAU!', email: ADMIN_EMAIL },
        subject:         subject,
        htmlContent:     htmlContent,
        messageVersions: messageVersions,
    });

    if (brevoRes.status !== 201 && brevoRes.status !== 200) {
        var msg = (brevoRes.body && brevoRes.body.message) ? brevoRes.body.message : JSON.stringify(brevoRes.body);
        res.status(500).json({ error: 'Brevo error: ' + msg }); return;
    }

    res.status(200).json({ sent: students.length, messageId: (brevoRes.body && brevoRes.body.messageId) || null });
};
