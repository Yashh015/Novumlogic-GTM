export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
  const BASE_URL = "https://server.smartlead.ai/api/v1";

  if (!SUPABASE_URL || !SUPABASE_KEY || !SMARTLEAD_API_KEY) {
    return res.status(500).json({ error: "Missing required environment variables" });
  }

  try {
    // 1. Parallel Fetch Setup for Supabase
    // To beat Vercel's 10s timeout, we fetch multiple pages in parallel.
    // Assuming max ~30,000 leads (30 pages of 1000)
    const MAX_PAGES = 30;
    const LIMIT = 1000;
    const fetchSupabasePage = async (table, select, offset) => {
      const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=${LIMIT}&offset=${offset}`;
      const r = await fetch(url, {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`
        }
      });
      if (!r.ok) return [];
      return await r.json();
    };

    // Parallel fetch companies (Max 5 pages = 5,000)
    const compPromises = [];
    for (let i = 0; i < 5; i++) {
      compPromises.push(fetchSupabasePage('master_companies', 'mapped_company_name,mapped_domain,industry,employee_count,annual_revenue,total_leads_available,leads_with_emails,leads_without_emails,already_sent,is_blacklisted', i * LIMIT));
    }

    // Parallel fetch leads (Max 30 pages = 30,000)
    const leadPromises = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      leadPromises.push(fetchSupabasePage('master_leads', 'id,mapped_email,first_name,last_name,job_title,mapped_domain,mapped_linkedin,source,has_email,already_sent,sent_campaign,sent_status,is_blacklisted,scheduled_date', i * LIMIT));
    }

    // 2. Fetch Smartlead Data
    const smartleadPromise = async () => {
      const campaignsRes = await fetch(`${BASE_URL}/campaigns?api_key=${SMARTLEAD_API_KEY}`);
      if (!campaignsRes.ok) return [];
      const campaigns = await campaignsRes.json();
      
      const campaign_stats = [];
      await Promise.all(campaigns.map(async (c) => {
        const r = await fetch(`${BASE_URL}/campaigns/${c.id}/analytics?api_key=${SMARTLEAD_API_KEY}`);
        if (r.ok) {
          const a = await r.json();
          const leadStats = a.campaign_lead_stats || {};
          campaign_stats.push({
            id: c.id,
            name: c.name,
            status: c.status,
            sent_count: parseInt(a.sent_count || 0, 10),
            open_count: parseInt(a.open_count || 0, 10),
            click_count: parseInt(a.click_count || 0, 10),
            reply_count: parseInt(a.reply_count || 0, 10),
            total_leads: parseInt(leadStats.total || 0, 10)
          });
        }
      }));
      return campaign_stats;
    };

    // Execute ALL network requests simultaneously
    const [compResults, leadResults, campaign_stats] = await Promise.all([
      Promise.all(compPromises),
      Promise.all(leadPromises),
      smartleadPromise()
    ]);

    // Flatten results and remove empty pages
    const companies = compResults.flat();
    let leads = leadResults.flat();

    // 3. Process Data for Frontend
    // Clean up fields
    leads.forEach(l => {
      if (!l.mapped_linkedin || String(l.mapped_linkedin).toLowerCase() === 'nan') l.mapped_linkedin = null;
      if (!l.sent_campaign || String(l.sent_campaign).toLowerCase() === 'nan') l.sent_campaign = 'Unknown Campaign';
      if (!l.sent_status || String(l.sent_status).toLowerCase() === 'nan') l.sent_status = 'Unknown Status';
      // We don't have exact individual tracking because we skipped the 45-second CSV downloads,
      // so default to false.
      l.has_opened = false;
      l.has_clicked = false;
      l.has_replied = false;
    });

    const source_counts = {};
    const title_counts = {};
    const sent_statuses = {};
    const sent_campaigns = {};
    let with_email = 0;
    let without_email = 0;
    let already_sent = 0;

    leads.forEach(l => {
      let src = (l.source || 'unknown').replace(/raw_/g, '').replace(/_leads/g, '').replace(/_/g, ' ');
      src = src.replace(/\b\w/g, c => c.toUpperCase());
      source_counts[src] = (source_counts[src] || 0) + 1;

      if (l.job_title && l.job_title.trim()) {
        const t = l.job_title.trim().replace(/\b\w/g, c => c.toUpperCase());
        title_counts[t] = (title_counts[t] || 0) + 1;
      }

      if (l.already_sent) {
        already_sent++;
        sent_statuses[l.sent_status] = (sent_statuses[l.sent_status] || 0) + 1;
        sent_campaigns[l.sent_campaign] = (sent_campaigns[l.sent_campaign] || 0) + 1;
      }
      
      if (l.has_email) with_email++;
      else without_email++;
    });

    const industry_counts = {};
    companies.forEach(c => {
      let ind = (c.industry || '').trim();
      ind = ind ? ind.replace(/\b\w/g, ch => ch.toUpperCase()) : 'Unknown';
      industry_counts[ind] = (industry_counts[ind] || 0) + 1;
    });

    const dashboard_data = {
      stats: {
        total_companies: companies.length,
        total_leads: leads.length,
        with_email,
        without_email,
        already_sent
      },
      companies,
      leads,
      campaign_stats: campaign_stats.sort((a, b) => b.id - a.id),
      industries: Object.entries(industry_counts).sort((a, b) => b[1] - a[1]).slice(0, 15),
      top_titles: Object.entries(title_counts).sort((a, b) => b[1] - a[1]).slice(0, 20),
      sent_statuses,
      sent_campaigns: Object.entries(sent_campaigns).sort((a, b) => b[1] - a[1])
    };

    return res.status(200).json(dashboard_data);

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
