import os, json
import pandas as pd
from supabase import create_client

env_file = r'C:\Yashraj\Novumlogic\Cold Outbound\Novumlogic-GTM\.env.local'
if not os.path.exists(env_file):
    env_file = r'C:\Yashraj\Novumlogic\Cold Outbound\Novumlogic-GTM\.env'

env_vars = {}
try:
    with open(env_file, 'r') as f:
        for line in f:
            if '=' in line:
                k, v = line.strip().split('=', 1)
                env_vars[k] = v
except:
    pass

url = env_vars.get('SUPABASE_URL')
key = env_vars.get('SUPABASE_KEY')
supabase = create_client(url, key)

companies = supabase.table('master_companies').select('mapped_domain, industry').execute().data
comp_dict = {c['mapped_domain'].lower(): c.get('industry') for c in companies if c.get('mapped_domain')}

leads = []
page = 0
while True:
    res = supabase.table('master_leads').select('mapped_domain, sent_status').range(page*1000, (page+1)*1000-1).execute().data
    if not res: break
    leads.extend(res)
    page += 1

sent_leads = [l for l in leads if l.get('sent_status') and l.get('mapped_domain')]
engaged_leads = [l for l in sent_leads if any(s in l['sent_status'].lower() for s in ['opened', 'clicked', 'replied'])]

unknown_domains = set()
missing_in_companies = set()
null_industry = set()

for l in engaged_leads:
    dom = l['mapped_domain'].lower()
    if dom not in comp_dict:
        unknown_domains.add(dom)
        missing_in_companies.add(dom)
    elif not comp_dict[dom] or comp_dict[dom].strip().lower() == 'unknown':
        unknown_domains.add(dom)
        null_industry.add(dom)

print(f'Total engaged leads: {len(engaged_leads)}')
unknown_leads_count = sum(1 for l in engaged_leads if l.get('mapped_domain', '').lower() in unknown_domains)
print(f'Engaged leads with Unknown industry: {unknown_leads_count}')
print(f'Unique unknown domains: {len(unknown_domains)}')
print(f'Domains missing entirely from master_companies: {len(missing_in_companies)}')
print(f'Domains present but industry is NULL: {len(null_industry)}')

if missing_in_companies:
    print('Sample missing domains:', list(missing_in_companies)[:5])
if null_industry:
    print('Sample NULL industry domains:', list(null_industry)[:5])
