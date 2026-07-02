export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Novum2026';
  const authHeader = req.headers['x-dashboard-auth'];
  if (authHeader !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized. Incorrect password." });
  }

  const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
  if (!SMARTLEAD_API_KEY) {
    return res.status(500).json({ error: 'Missing Smartlead API Key in Vercel environment' });
  }

  const { campaignId, leads } = req.body;
  if (!campaignId || !leads || !Array.isArray(leads)) {
    return res.status(400).json({ error: 'Invalid payload. campaignId and leads array are required.' });
  }

  if (leads.length === 0) {
    return res.status(200).json({ success: true, message: 'No leads to push.' });
  }

  try {
    // Map leads to Smartlead API format
    const formattedLeads = leads.map(row => {
      const custom_fields = {};
      for (const [key, value] of Object.entries(row)) {
        if (!['First Name', 'Last Name', 'Email', 'Company', 'LinkedIn'].includes(key)) {
            custom_fields[key] = value;
        }
      }
      
      return {
        first_name: row['First Name'] || '',
        last_name: row['Last Name'] || '',
        email: row['Email'],
        company_name: row['Company'] || '',
        linkedin_profile: row['LinkedIn'] || '',
        custom_fields: custom_fields
      };
    });

    const payload = {
      lead_list: formattedLeads,
      settings: {
        ignore_global_block_list: false, // Treat blocklist correctly
        ignore_unsubscribe_list: false,
        ignore_duplicate_leads_in_campaign: true, // Skip duplicates
        ignore_duplicate_leads_in_other_campaign: true, // Match 'Existing Campaign Leads' ON
        verify_email: false // The critical user requirement: Skip verification
      }
    };

    console.log(`[START] Smartlead Push: Attempting to add ${formattedLeads.length} leads to campaign ${campaignId}.`);

    const response = await fetch(`https://server.smartlead.ai/api/v1/campaigns/${campaignId}/leads?api_key=${SMARTLEAD_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(`[ERROR] Smartlead API push failed for campaign ${campaignId}. Status: ${response.status}`, result);
      return res.status(response.status).json({ error: result.message || 'Failed to push to Smartlead' });
    }

    console.log(`[SUCCESS] Successfully pushed ${formattedLeads.length} leads to campaign ${campaignId}.`);
    
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error('Push to Smartlead Error:', err);
    return res.status(500).json({ error: 'Internal server error while pushing to Smartlead' });
  }
}
