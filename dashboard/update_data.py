from supabase import create_client, Client
import json
import pandas as pd
import os
from dotenv import load_dotenv
import requests

load_dotenv()

URL = os.getenv('SUPABASE_URL')
KEY = os.getenv('SUPABASE_KEY')
supabase = create_client(URL, KEY)

SMARTLEAD_API_KEY = os.getenv('SMARTLEAD_API_KEY')
BASE_URL = "https://server.smartlead.ai/api/v1"

def fetch_all(table, select='*'):
    all_data = []
    limit = 1000
    offset = 0
    while True:
        res = supabase.table(table).select(select).range(offset, offset + limit - 1).execute()
        if not res.data:
            break
        all_data.extend(res.data)
        offset += limit
        if len(res.data) < limit:
            break
    return all_data

print("Fetching companies...")
companies = fetch_all('master_companies', 'mapped_company_name,mapped_domain,industry,employee_count,annual_revenue,total_leads_available,leads_with_emails,leads_without_emails,already_sent,is_blacklisted')

print("Fetching all leads (full details)...")
leads = fetch_all('master_leads', 'id,mapped_email,first_name,last_name,job_title,mapped_domain,mapped_linkedin,source,has_email,already_sent,sent_campaign,sent_status,is_blacklisted,scheduled_date')

print("Fetching Smartlead campaign analytics & export CSVs...")
opened_emails = set()
clicked_emails = set()
replied_emails = set()
sent_emails = set()
campaign_stats = []
import csv
from io import StringIO

try:
    res = requests.get(f"{BASE_URL}/campaigns?api_key={SMARTLEAD_API_KEY}")
    if res.status_code == 200:
        campaigns = res.json()
        for c in campaigns:
            cid = c['id']
            cname = c['name']
            
            # 1. Fetch Analytics
            r = requests.get(f"{BASE_URL}/campaigns/{cid}/analytics?api_key={SMARTLEAD_API_KEY}")
            if r.status_code == 200:
                a = r.json()
                campaign_stats.append({
                    'id': cid,
                    'name': cname,
                    'status': c.get('status'),
                    'sent_count': int(a.get('sent_count') or 0),
                    'open_count': int(a.get('open_count') or 0),
                    'click_count': int(a.get('click_count') or 0),
                    'reply_count': int(a.get('reply_count') or 0),
                    'total_leads': int((a.get('campaign_lead_stats') or {}).get('total') or 0)
                })
            
            # 2. Fetch Export CSV to find exactly who opened emails
            export_url = f"{BASE_URL}/campaigns/{cid}/leads-export?api_key={SMARTLEAD_API_KEY}"
            export_res = requests.get(export_url)
            if export_res.status_code == 200:
                csv_reader = csv.DictReader(StringIO(export_res.text))
                for row in csv_reader:
                    em = row.get('email')
                    if em:
                        em_clean = em.lower().strip()
                        sent_emails.add(em_clean)
                        try:
                            # In CSV, open_count is a string, check if it exists and is > 0
                            oc = int(row.get('open_count') or 0)
                            if oc > 0:
                                opened_emails.add(em_clean)
                            cc = int(row.get('click_count') or 0)
                            if cc > 0:
                                clicked_emails.add(em_clean)
                            rc = int(row.get('reply_count') or 0)
                            if rc > 0:
                                replied_emails.add(em_clean)
                        except:
                            pass
except Exception as e:
    print(f"Error fetching Smartlead analytics or CSV exports: {e}")

# Apply has_opened flag to all leads
for l in leads:
    em = l.get('mapped_email')
    if em:
        em_clean = em.lower().strip()
        l['has_opened'] = em_clean in opened_emails
        l['has_clicked'] = em_clean in clicked_emails
        l['has_replied'] = em_clean in replied_emails
        if em_clean in sent_emails:
            l['already_sent'] = True
    else:
        l['has_opened'] = False
        l['has_clicked'] = False
        l['has_replied'] = False
        
    # Clean up fields for frontend rendering
    if str(l.get('mapped_linkedin')).lower() in ('nan', 'none', 'null', ''):
        l['mapped_linkedin'] = None
    if not l.get('sent_campaign') or str(l.get('sent_campaign')).lower() in ('nan', 'none', 'null', ''):
        l['sent_campaign'] = 'Unknown Campaign'
    if not l.get('sent_status') or str(l.get('sent_status')).lower() in ('nan', 'none', 'null', ''):
        l['sent_status'] = 'Unknown Status'

# Pre-calculate some stats
source_counts = {}
industry_counts = {}
title_counts = {}
sent_statuses = {}
sent_campaigns = {}

for l in leads:
    src = l.get('source', 'unknown').replace('raw_', '').replace('_leads', '').replace('_', ' ').title()
    source_counts[src] = source_counts.get(src, 0) + 1
    
    t = l.get('job_title')
    if t and t.strip():
        t_clean = t.strip().title()
        title_counts[t_clean] = title_counts.get(t_clean, 0) + 1
        
    if l.get('already_sent'):
        s = l.get('sent_status', 'Unknown')
        sent_statuses[s] = sent_statuses.get(s, 0) + 1
        c = l.get('sent_campaign', 'Unknown')
        sent_campaigns[c] = sent_campaigns.get(c, 0) + 1

for c in companies:
    ind = c.get('industry') or ''
    ind = ind.strip().title() if ind.strip() else 'Unknown'
    industry_counts[ind] = industry_counts.get(ind, 0) + 1

dashboard_data = {
    'stats': {
        'total_companies': len(companies),
        'total_leads': len(leads),
        'with_email': sum(1 for l in leads if l.get('has_email')),
        'without_email': sum(1 for l in leads if not l.get('has_email')),
        'already_sent': sum(1 for l in leads if l.get('already_sent'))
    },
    'companies': companies,
    'leads': leads,
    'campaign_stats': campaign_stats,
    'industries': sorted(industry_counts.items(), key=lambda x: x[1], reverse=True)[:15],
    'top_titles': sorted(title_counts.items(), key=lambda x: x[1], reverse=True)[:20],
    'sent_statuses': sent_statuses,
    'sent_campaigns': sorted(sent_campaigns.items(), key=lambda x: x[1], reverse=True)
}

out_dir = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(out_dir, 'dashboard_data.json'), 'w', encoding='utf-8') as f:
    json.dump(dashboard_data, f, ensure_ascii=False)

print(f"Exported {len(companies)} companies, {len(leads)} leads, and {len(campaign_stats)} campaign stats.")
