const SMARTLEAD_BASE = 'https://server.smartlead.ai/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY || !SMARTLEAD_API_KEY) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  // Always respond 200 immediately — Smartlead won't retry
  res.status(200).json({ received: true });

  try {
    const body = req.body;
    console.log('📩 Webhook received:', JSON.stringify(body));

    // ── Parse core fields from webhook payload ──────────────
    const eventType    = (body.event_type || body.event || body.type || '').toUpperCase().trim();
    const leadEmail    = (body.to_email || body.lead?.email || body.lead_email || body.email || '').toLowerCase().trim();
    const campaignId   = body.campaign_id   || body.campaign?.id   || null;
    const campaignName = body.campaign_name || body.campaign?.name || null;
    const fromEmail    = body.from_email    || null;
    const seqNum       = body.sequence_number ? parseInt(body.sequence_number, 10) : null;
    const messageId    = body.message_id    || null;
    const categoryName = body.lead_category || body.category?.name || null;
    const now          = new Date().toISOString();

    if (!leadEmail) {
      console.log('No email in payload — skipping');
      return;
    }

    // ── Skip non-lead events ─────────────────────────────────
    const skipEvents = ['CAMPAIGN_STATUS_CHANGED', 'EMAIL_ACCOUNT_DISCONNECTED', 'LINKEDIN_DISCONNECTED'];
    if (skipEvents.includes(eventType)) {
      console.log('Non-lead event, skipping:', eventType);
      return;
    }

    // ── Map event to status + timestamps ─────────────────────
    let newStatus = null;
    let isBlacklisted = false;
    const timestampUpdates = {};

    switch (eventType) {
      case 'EMAIL_SENT':
      case 'FIRST_EMAIL_SENT':
        newStatus = 'Sent';
        timestampUpdates.sent_at = now;
        break;
      case 'EMAIL_OPEN':
      case 'EMAIL_OPENED':
        newStatus = 'Opened';
        timestampUpdates.opened_at = now;
        break;
      case 'EMAIL_LINK_CLICK':
      case 'EMAIL_CLICKED':
        newStatus = 'Clicked';
        timestampUpdates.clicked_at = now;
        break;
      case 'EMAIL_REPLY':
      case 'EMAIL_REPLIED':
      case 'UNTRACKED_REPLIES':
      case 'MANUAL_REPLY_SENT':
        newStatus = 'Replied';
        timestampUpdates.replied_at = now;
        break;
      case 'EMAIL_BOUNCE':
      case 'EMAIL_BOUNCED':
        newStatus = 'Bounced';
        isBlacklisted = true;
        timestampUpdates.bounced_at = now;
        break;
      case 'LEAD_UNSUBSCRIBED':
      case 'UNSUBSCRIBE':
        newStatus = 'Unsubscribed';
        isBlacklisted = true;
        timestampUpdates.unsubscribed_at = now;
        break;
      case 'LEAD_CATEGORY_UPDATED':
        newStatus = categoryName || 'Categorised';
        break;
      case 'MANUAL_STEP_REACHED':
        newStatus = 'Manual Step';
        break;
      default:
        newStatus = eventType;
        break;
    }

    // ── 1. Fetch full lead profile from Smartlead API ────────
    let slLead = {};
    try {
      // Search lead by email in Smartlead
      const slRes = await fetch(
        `${SMARTLEAD_BASE}/leads?api_key=${SMARTLEAD_API_KEY}&email=${encodeURIComponent(leadEmail)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (slRes.ok) {
        const slData = await slRes.json();
        // API returns array or single object
        const lead = Array.isArray(slData) ? slData[0] : slData;
        if (lead) {
          slLead = {
            smartlead_lead_id: lead.id || null,
            first_name:  lead.first_name  || lead.firstName  || null,
            last_name:   lead.last_name   || lead.lastName   || null,
            job_title:   lead.job_title   || lead.title      || null,
            phone:       lead.phone_number|| lead.phone      || null,
            location:    lead.location    || null,
            city:        lead.city        || null,
            country:     lead.country     || null,
            linkedin_url: lead.linkedin_profile || lead.linkedin_url || null,
            company_name: lead.company_name || lead.company  || null,
            company_domain: lead.website  || null,
            seniority:   lead.seniority   || null,
            department:  lead.department  || null,
          };
          console.log('✅ Smartlead lead profile fetched');
        }
      }
    } catch (e) {
      console.warn('Smartlead API lookup failed (non-fatal):', e.message);
    }

    // ── 2. Fetch from master_leads (our internal DB) ─────────
    let mlLead = {};
    try {
      const mlRes = await fetch(
        `${SUPABASE_URL}/rest/v1/master_leads?mapped_email=eq.${encodeURIComponent(leadEmail)}&select=first_name,last_name,job_title,mapped_linkedin,source,mapped_domain`,
        {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          signal: AbortSignal.timeout(5000)
        }
      );
      if (mlRes.ok) {
        const ml = await mlRes.json();
        if (ml?.[0]) {
          mlLead = {
            first_name:   ml[0].first_name   || null,
            last_name:    ml[0].last_name    || null,
            job_title:    ml[0].job_title    || null,
            linkedin_url: ml[0].mapped_linkedin || null,
            lead_source:  ml[0].source       || null,
            company_domain: ml[0].mapped_domain || null,
          };
          console.log('✅ master_leads profile fetched');
        }
      }
    } catch (e) {
      console.warn('master_leads lookup failed (non-fatal):', e.message);
    }

    // ── 3. Fetch from master_companies (company details) ─────
    let companyData = {};
    const domainToLookup = slLead.company_domain || mlLead.company_domain || null;
    if (domainToLookup) {
      try {
        const mcRes = await fetch(
          `${SUPABASE_URL}/rest/v1/master_companies?mapped_domain=eq.${encodeURIComponent(domainToLookup)}&select=mapped_company_name,industry,employee_count,annual_revenue`,
          {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
            signal: AbortSignal.timeout(5000)
          }
        );
        if (mcRes.ok) {
          const mc = await mcRes.json();
          if (mc?.[0]) {
            companyData = {
              company_name:     mc[0].mapped_company_name || slLead.company_name || null,
              company_industry: mc[0].industry            || null,
              company_headcount:mc[0].employee_count      || null,
              company_revenue:  mc[0].annual_revenue      || null,
            };
            console.log('✅ master_companies data fetched');
          }
        }
      } catch (e) {
        console.warn('master_companies lookup failed (non-fatal):', e.message);
      }
    }

    // ── Merge all sources (Smartlead API takes priority) ─────
    const firstName = slLead.first_name || mlLead.first_name || body.to_name?.split(' ')[0] || null;
    const lastName  = slLead.last_name  || mlLead.last_name  || body.to_name?.split(' ').slice(1).join(' ') || null;

    const merged = {
      email:        leadEmail,
      campaign_id:  campaignId,
      campaign_name:campaignName,
      from_email:   fromEmail,
      sequence_number: seqNum,
      message_id:   messageId,
      status:       newStatus,
      is_blacklisted: isBlacklisted,
      last_event_at: now,
      ...timestampUpdates,
      first_name:   firstName,
      last_name:    lastName,
      full_name:    [firstName, lastName].filter(Boolean).join(' ') || null,
      job_title:    slLead.job_title    || mlLead.job_title    || null,
      phone:        slLead.phone        || null,
      location:     slLead.location     || null,
      city:         slLead.city         || null,
      country:      slLead.country      || null,
      linkedin_url: slLead.linkedin_url || mlLead.linkedin_url || null,
      seniority:    slLead.seniority    || null,
      department:   slLead.department   || null,
      lead_source:  mlLead.lead_source  || null,
      smartlead_lead_id: slLead.smartlead_lead_id || null,
      company_name:     companyData.company_name     || slLead.company_name     || null,
      company_domain:   domainToLookup               || null,
      company_industry: companyData.company_industry || null,
      company_headcount:companyData.company_headcount|| null,
      company_revenue:  companyData.company_revenue  || null,
    };

    // ── 4. Upsert into smartlead_contacts ───────────────────
    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/smartlead_contacts`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(merged)
      }
    );

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      console.error('smartlead_contacts upsert error:', upsertRes.status, err);
    } else {
      console.log(`✅ [${eventType}] Full profile upserted for ${leadEmail}`);
    }

    // ── 5. Also keep master_leads in sync ───────────────────
    const masterUpdates = { last_event_at: now, sent_status: newStatus };
    if (isBlacklisted)  masterUpdates.is_blacklisted = true;
    if (newStatus === 'Sent')    { masterUpdates.already_sent = true; if (campaignName) masterUpdates.sent_campaign = campaignName; }
    if (newStatus === 'Replied') { masterUpdates.already_sent = true; if (campaignName) masterUpdates.sent_campaign = campaignName; }

    await fetch(
      `${SUPABASE_URL}/rest/v1/master_leads?mapped_email=eq.${encodeURIComponent(leadEmail)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(masterUpdates)
      }
    );

    console.log(`✅ master_leads synced for ${leadEmail}`);

    // ── 6. Update smartlead_campaign_leads (export table) ─────
    if (campaignId) {
      const exportTableUpdates = { status: newStatus, updated_at: now };
      if (newStatus === 'Opened') exportTableUpdates.is_opened = true;
      if (newStatus === 'Clicked') exportTableUpdates.is_clicked = true;
      if (newStatus === 'Replied') exportTableUpdates.is_replied = true;
      if (newStatus === 'Bounced') exportTableUpdates.is_bounced = true;
      if (newStatus === 'Unsubscribed') exportTableUpdates.is_unsubscribed = true;
      
      await fetch(
        `${SUPABASE_URL}/rest/v1/smartlead_campaign_leads?email=eq.${encodeURIComponent(leadEmail)}&campaign_id=eq.${campaignId}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(exportTableUpdates)
        }
      );
      console.log(`✅ smartlead_campaign_leads synced for ${leadEmail}`);
    }

    // ── 7. Autofill global_blacklist if bounced/unsubscribed ─────
    if (isBlacklisted) {
      const blacklistPayload = {
        email: leadEmail,
        company_name: slLead.company_name || companyData.company_name || null,
        domain: domainToLookup || null,
        reason: newStatus === 'Bounced' ? 'Email Bounced' : 'Unsubscribed via Smartlead',
        source: 'Smartlead Webhook'
      };
      
      await fetch(
        `${SUPABASE_URL}/rest/v1/global_blacklist`,
        {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=ignore-duplicates,return=minimal'
          },
          body: JSON.stringify(blacklistPayload)
        }
      );
      console.log(`✅ Added ${leadEmail} to global_blacklist`);
    }

  } catch (err) {
    console.error('Webhook fatal error:', err);
  }
}
