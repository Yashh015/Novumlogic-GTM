export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Novum2026';
  const authHeader = req.headers['x-dashboard-auth'];
  if (authHeader !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized. Incorrect password." });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase environment variables' });
  }

  const { source, data } = req.body;
  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'Invalid data format from frontend' });
  }

  function getDomain(email) {
    try {
      const parts = email.split('@');
      return parts.length > 1 ? parts[1].trim().toLowerCase() : null;
    } catch (e) {
      return null;
    }
  }

  function clean(str) {
    return str ? String(str).trim().toLowerCase() : '';
  }

  try {
    // 1. Process Data & Group by Domain
    const domainBuckets = {};
    const noEmailRows = [];
    
    // Arrays for Supabase recording
    const dbCompanies = new Map(); // using map to dedup
    const dbLeads = [];
    const dbLeadsNoEmail = [];

    const now = new Date().toISOString();

    for (const row of data) {
      const email = clean(row['Work Email'] || row['Email'] || row.email || row.Email || '');
      const companyName = row['Company Name'] || row.company || row.Company || '';
      const website = clean(row['Company Website'] || row.website || row.Website || '');
      
      let domain = getDomain(email) || website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (!domain && companyName) {
        domain = 'unknown_' + companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
      }

      // Record Company for DB
      if (domain && !dbCompanies.has(domain)) {
        dbCompanies.set(domain, {
          domain: domain,
          company_name: companyName,
          source: source,
          created_at: now
        });
      }

      const firstName = row['First Name'] || row.first_name || '';
      const lastName = row['Last Name'] || row.last_name || '';
      const title = row['Job Title'] || row.title || '';
      const linkedin = row['LinkedIn Profile'] || row.linkedin || '';

      if (email) {
        // Enforce max 2 per company for the Smartlead output
        if (!domainBuckets[domain]) domainBuckets[domain] = [];
        if (domainBuckets[domain].length < 2) {
          domainBuckets[domain].push({
            'First Name': firstName,
            'Last Name': lastName,
            'Email': email,
            'Company': companyName,
            'Title': title,
            'Website': domain,
            'LinkedIn': linkedin,
            _email: email,
            _domain: domain
          });
        }
        
        // Record all emails for DB
        dbLeads.push({
          email: email,
          domain: domain,
          first_name: firstName,
          last_name: lastName,
          job_title: title,
          linkedin_url: linkedin,
          source: source,
          created_at: now
        });

      } else {
        // Record no-emails for DB
        dbLeadsNoEmail.push({
          domain: domain,
          full_name: `${firstName} ${lastName}`.trim(),
          job_title: title,
          linkedin_url: linkedin,
          source: source,
          created_at: now
        });
      }
    }

    const selectedWithEmails = Object.values(domainBuckets).flat();
    const allDomains = Array.from(new Set(selectedWithEmails.map(r => r._domain)));
    const allEmails = Array.from(new Set(selectedWithEmails.map(r => r._email)));

    // 2. Fetch Blacklist and Sent History from Supabase in batches (avoid URL length limits)
    const blacklistedEmails = new Set();
    const blacklistedDomains = new Set();
    const sentEmails = new Set();

    async function fetchInBatches(table, column, values, select) {
      const results = [];
      const batchSize = 50; 
      for (let i = 0; i < values.length; i += batchSize) {
        const batch = values.slice(i, i + batchSize);
        const filter = batch.map(v => encodeURIComponent(v)).join(',');
        const url = `${SUPABASE_URL}/rest/v1/${table}?${column}=in.(${filter})&select=${select}`;
        const r = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        if (r.ok) {
          const j = await r.json();
          results.push(...j);
        }
      }
      return results;
    }

    // Check global_blacklist (Real-time bounces/unsubscribes)
    if (allEmails.length > 0) {
      const blByEmail = await fetchInBatches('global_blacklist', 'email', allEmails, 'email');
      blByEmail.forEach(r => { if(r.email) blacklistedEmails.add(r.email.toLowerCase()); });
    }
    if (allDomains.length > 0) {
      const blByDomain = await fetchInBatches('global_blacklist', 'domain', allDomains, 'domain');
      blByDomain.forEach(r => { if(r.domain) blacklistedDomains.add(r.domain.toLowerCase()); });
    }

    // Check campaign_activity (Updated Daily at 4pm)
    if (allEmails.length > 0) {
      const sentActivity = await fetchInBatches('campaign_activity', 'email', allEmails, 'email');
      sentActivity.forEach(r => { if(r.email) sentEmails.add(r.email.toLowerCase()); });
    }

    // Check smartlead_contacts (Updated in REAL-TIME by webhooks!)
    if (allEmails.length > 0) {
      const slContacts = await fetchInBatches('smartlead_contacts', 'email', allEmails, 'email');
      slContacts.forEach(r => { if(r.email) sentEmails.add(r.email.toLowerCase()); });
    }

    // 3. Final Filtered List
    const finalSmartleadReady = [];
    let blockedCount = 0;
    
    for (const row of selectedWithEmails) {
      if (blacklistedEmails.has(row._email) || blacklistedDomains.has(row._domain) || sentEmails.has(row._email)) {
        blockedCount++;
        continue; // Blocked or already sent
      }
      // Clean up internal properties
      delete row._email;
      delete row._domain;
      finalSmartleadReady.push(row);
    }

    // 4. Background bulk DB Inserts (Fire and Forget)
    async function bulkInsert(table, arr) {
      if (!arr || arr.length === 0) return;
      const batchSize = 1000;
      for (let i = 0; i < arr.length; i += batchSize) {
        const batch = arr.slice(i, i + batchSize);
        await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=ignore-duplicates' 
          },
          body: JSON.stringify(batch)
        }).catch(err => console.error(`Failed bulk insert to ${table}`, err));
      }
    }

    await Promise.all([
      bulkInsert('companies', Array.from(dbCompanies.values())),
      bulkInsert('leads', dbLeads),
      bulkInsert('leads_no_email', dbLeadsNoEmail)
    ]);

    // 5. Generate CSV Response
    let csvString = "First Name,Last Name,Email,Company,Title,Website,LinkedIn\n";
    if (finalSmartleadReady.length > 0) {
      const headers = Object.keys(finalSmartleadReady[0]);
      const csvRows = [headers.join(',')];
      for (const row of finalSmartleadReady) {
        const values = headers.map(h => {
          let val = (row[h] || '').toString();
          if (val.includes(',') || val.includes('"')) {
            val = `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        });
        csvRows.push(values.join(','));
      }
      csvString = csvRows.join('\n');
    }
    
    const stats = {
      totalUploaded: data.length,
      withEmails: selectedWithEmails.length + blockedCount,
      withoutEmails: dbLeadsNoEmail.length,
      blocked: blockedCount,
      finalExported: finalSmartleadReady.length
    };

    return res.status(200).json({ csv: csvString, stats: stats, finalLeads: finalSmartleadReady });

  } catch (err) {
    console.error('Process Leads Error:', err);
    return res.status(500).json({ error: 'Internal server error while processing leads' });
  }
}
