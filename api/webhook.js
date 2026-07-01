export default async function handler(req, res) {
  // Smartlead sends POST requests for email events
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  try {
    const body = req.body;

    // Log for debugging in Vercel logs
    console.log('Smartlead webhook event received:', JSON.stringify(body));

    // === PARSE SMARTLEAD PAYLOAD ===
    // Smartlead can send event_type at top level OR nested in event
    const eventType = (body.event_type || body.event || body.type || '').toUpperCase().trim();

    // Lead email: Smartlead uses to_email at top level, or nested lead.email
    const leadEmail = (
      body.to_email ||
      body.lead?.email ||
      body.lead_email ||
      body.email ||
      ''
    ).toLowerCase().trim();

    // Lead name fields
    const firstName = body.to_name?.split(' ')[0] || body.lead?.first_name || body.first_name || '';
    const lastName = body.to_name?.split(' ').slice(1).join(' ') || body.lead?.last_name || body.last_name || '';

    // Campaign info
    const campaignName = body.campaign_name || body.campaign?.name || '';
    const campaignId = body.campaign_id || body.campaign?.id || null;

    // Reply content (for LEAD_CATEGORY_UPDATED)
    const categoryName = body.lead_category || body.category?.name || '';

    // Idempotency: check X-Request-Id header to avoid double-processing
    const requestId = req.headers['x-request-id'] || '';

    // Always respond 200 immediately so Smartlead doesn't retry
    // We do the DB update asynchronously below
    res.status(200).json({ received: true, event: eventType, email: leadEmail });

    if (!leadEmail) {
      console.log('No email found in payload — skipping DB update');
      return;
    }

    // === MAP EVENT TO SUPABASE UPDATES ===
    const updates = {};

    switch (eventType) {
      // ── Sent ──────────────────────────────────────────────
      case 'EMAIL_SENT':
      case 'FIRST_EMAIL_SENT':
        updates.already_sent = true;
        updates.sent_status = 'Sent';
        if (campaignName) updates.sent_campaign = campaignName;
        break;

      // ── Opened ────────────────────────────────────────────
      case 'EMAIL_OPEN':
      case 'EMAIL_OPENED':
        updates.sent_status = 'Opened';
        break;

      // ── Clicked ───────────────────────────────────────────
      case 'EMAIL_LINK_CLICK':
      case 'EMAIL_CLICKED':
        updates.sent_status = 'Clicked';
        break;

      // ── Replied ───────────────────────────────────────────
      case 'EMAIL_REPLY':
      case 'EMAIL_REPLIED':
      case 'UNTRACKED_REPLIES':
      case 'MANUAL_REPLY_SENT':  // Manual replies via Smartlead inbox
        updates.already_sent = true;
        updates.sent_status = 'Replied';
        if (campaignName) updates.sent_campaign = campaignName;
        break;

      // ── Bounced ───────────────────────────────────────────
      case 'EMAIL_BOUNCE':
      case 'EMAIL_BOUNCED':
        updates.sent_status = 'Bounced';
        updates.is_blacklisted = true;
        break;

      // ── Unsubscribed ──────────────────────────────────────
      case 'LEAD_UNSUBSCRIBED':
      case 'UNSUBSCRIBE':
        updates.sent_status = 'Unsubscribed';
        updates.is_blacklisted = true;
        break;

      // ── Category Updated (Interested / Not Interested etc) ─
      case 'LEAD_CATEGORY_UPDATED':
        if (categoryName) updates.sent_status = categoryName;
        break;

      // ── Ignore non-lead events ────────────────────────────
      case 'CAMPAIGN_STATUS_CHANGED':
      case 'MANUAL_STEP_REACHED':
      case 'EMAIL_ACCOUNT_DISCONNECTED':
      case 'LINKEDIN_DISCONNECTED':
        console.log('Non-lead event, skipping DB update:', eventType);
        return;

      default:
        console.log('Unknown event type:', eventType, '— storing raw status');
        updates.sent_status = eventType || 'Unknown';
        break;
    }

    if (Object.keys(updates).length === 0) return;

    // === UPDATE SUPABASE ===
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
      console.error('Supabase PATCH error:', patchRes.status, errText);
    } else {
      console.log(`✅ [${eventType}] Updated ${leadEmail} →`, JSON.stringify(updates));
    }

  } catch (err) {
    console.error('Webhook handler error:', err);
    // Don't return 500 — Smartlead would retry and spam us
    // We already sent 200 above
  }
}
