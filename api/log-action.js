export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY; // Service role key
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Novum2026';

  // Check authentication
  const authHeader = req.headers['x-dashboard-auth'];
  if (authHeader !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized. Incorrect password." });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing required environment variables" });
  }

  const { action_type, status, summary, details } = req.body;

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_logs`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        action_type,
        status,
        summary,
        details
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Log API Error]", errorText);
      // Fails gracefully if table doesn't exist yet
      return res.status(200).json({ success: false, note: "Table might not exist yet." });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("[Log API Exception]", error.message);
    return res.status(200).json({ success: false, error: error.message });
  }
}
