export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

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

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_logs?select=*&order=created_at.desc&limit=200`, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Get Logs API Error]", errorText);
      // Return empty array gracefully if table doesn't exist
      return res.status(200).json({ logs: [] });
    }

    const logs = await response.json();
    return res.status(200).json({ logs });
  } catch (error) {
    console.error("[Get Logs API Exception]", error.message);
    return res.status(200).json({ logs: [], error: error.message });
  }
}
