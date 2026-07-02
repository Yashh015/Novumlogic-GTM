export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;

  if (!SMARTLEAD_API_KEY) {
    return res.status(500).json({ error: 'Missing Smartlead API Key in Vercel environment' });
  }

  try {
    const response = await fetch(`https://server.smartlead.ai/api/v1/campaigns?api_key=${SMARTLEAD_API_KEY}`);
    const data = await response.json();
    
    let campaigns = [];
    if (Array.isArray(data)) {
      campaigns = data;
    } else if (data && Array.isArray(data.campaigns)) {
      campaigns = data.campaigns;
    } else {
      console.error("Unexpected Smartlead Response:", data);
      return res.status(400).json({ error: data.message || 'Invalid response from Smartlead API' });
    }

    // Map to a lightweight format for the frontend dropdown
    const filtered = campaigns.map(c => ({
      id: c.id,
      name: c.name,
      status: c.status || 'UNKNOWN'
    })).filter(c => c.status !== 'COMPLETED' && c.status !== 'STOPPED'); // optionally hide totally dead campaigns

    // Sort alphabetically
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json(filtered);
  } catch (err) {
    console.error('Fetch Campaigns Error:', err);
    return res.status(500).json({ error: 'Internal server error while fetching campaigns' });
  }
}
