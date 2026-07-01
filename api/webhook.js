export default async function handler(req, res) {
  // Smartlead sends POST requests for email events
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

  // Optional: Verify webhook secret if you set one in Smartlead
  const incomingSecret = req.headers['x-webhook-secret'] || req.query.secret || '';
  if (WEBHOOK_SECRET && incomingSecret !== WEBHOOK_SECRET) {
    console.error('Webhook secret mismatch');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  try {
    const body = req.body;
    console.log('Smartlead webhook received:', JSON.stringify(body));

    // Smartlead sends different event types:
    // event_type: EMAIL_SENT, EMAIL_OPEN, EMAIL_CLICK, EMAIL_REPLY, EMAIL_BOUNCE, UNSUBSCRIBE
    const eventType = body.event_type || body.type || '';
    const leadEmail = (body.to_email || body.lead_email || body.email || '').toLowerCase().trim();
    const campaignName = body.campaign_name || body.campaign?.name || '';
    const campaignId = body.campaign_id || body.campaign?.id || null;

    if (!leadEmail) {
      console.log('No email in payload, skipping. Payload:', JSON.stringify(body));
      return res.status(200).json({ message: 'No email found, skipped' });
    }

    // Map Smartlead event types to our column updates
    const updates = {};

    switch (eventType.toUpperCase()) {
      case 'EMAIL_SENT':
        updates.already_sent = true;
        updates.sent_status = 'Sent';
        if (campaignName) updates.sent_campaign = campaignName;
        break;

      case 'EMAIL_OPEN':
        updates.sent_status = 'Opened';
        break;

      case 'EMAIL_CLICK':
        updates.sent_status = 'Clicked';
        break;

      case 'EMAIL_REPLY':
        updates.already_sent = true;
        updates.sent_status = 'Replied';
        if (campaignName) updates.sent_campaign = campaignName;
        break;

      case 'EMAIL_BOUNCE':
        updates.sent_status = 'Bounced';
        break;

      case 'UNSUBSCRIBE':
        updates.sent_status = 'Unsubscribed';
        updates.is_blacklisted = true;
        break;

      default:
        console.log('Unknown event type:', eventType, '- recording as-is');
        updates.sent_status = eventType || 'Unknown';
        break;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(200).json({ message: 'No update needed for this event' });
    }

    // Update the lead in Supabase by email
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/master_leads?mapped_email=eq.${encodeURIComponent(leadEmail)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(updates)
      }
    );

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('Supabase PATCH error:', errText);
      return res.status(500).json({ error: 'Failed to update Supabase', detail: errText });
    }

    console.log(`✅ Updated lead ${leadEmail} → ${JSON.stringify(updates)}`);
    return res.status(200).json({ message: 'OK', email: leadEmail, updates });

  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
