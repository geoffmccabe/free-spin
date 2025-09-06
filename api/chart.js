import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Zero-fill helper
function datesBetween(start, end) {
  const s = new Date(start), e = new Date(end), out = [];
  s.setUTCHours(0,0,0,0); e.setUTCHours(0,0,0,0);
  while (s <= e) { out.push(s.toISOString().slice(0,10)); s.setUTCDate(s.getUTCDate()+1); }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { server_id, contract_address, view='token', range='30d' } = req.body || {};
    if (!server_id) return res.status(400).json({ error: 'server_id required' });
    if (view === 'token' && !contract_address) return res.status(400).json({ error: 'contract_address required' });

    // date window
    const end = new Date();
    const start = range === 'all' ? new Date('2024-01-01T00:00:00Z') : new Date(Date.now() - 29 * 24 * 3600 * 1000);
    const labels = datesBetween(start, end);

    // Pull rows once; aggregate in memory (fast enough for our scale)
    let sel = supabase.from('daily_spins')
      .select('created_at_utc, amount_base, contract_address')
      .eq('server_id', server_id)
      .gte('created_at_utc', start.toISOString())
      .lte('created_at_utc', end.toISOString());

    if (view === 'token') sel = sel.eq('contract_address', contract_address);
    const { data: rows, error } = await sel;
    if (error) return res.status(500).json({ error: error.message });

    // Decimals (default 5)
    let decimals = 5;
    if (view === 'token') {
      const { data: cfg } = await supabase.from('wheel_configurations')
        .select('decimals')
        .eq('contract_address', contract_address)
        .maybeSingle();
      if (cfg && typeof cfg.decimals === 'number') decimals = cfg.decimals;
    }

    const byDay = new Map(labels.map(d => [d, { spins:0, payoutBase:0n }]));
    for (const r of rows || []) {
      const d = new Date(r.created_at_utc);
      const key = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0,10);
      const bucket = byDay.get(key);
      if (!bucket) continue; // outside window safety
      bucket.spins += 1;
      if (typeof r.amount_base === 'number') bucket.payoutBase += BigInt(r.amount_base);
    }

    const spins = [], totalPayout = [];
    let maxL = 0, maxR = 0;
    for (const d of labels) {
      const b = byDay.get(d) || { spins:0, payoutBase:0n };
      const payout = Number(b.payoutBase) / 10 ** decimals;
      spins.push(b.spins);
      totalPayout.push(payout);
      if (b.spins > maxL) maxL = b.spins;
      if (payout > maxR) maxR = payout;
    }

    return res.status(200).json({
      labels, spins, totalPayout,
      yMaxLeft: Math.ceil(maxL * 1.15),
      yMaxRight: Math.ceil(maxR * 1.15)
    });
  } catch (e) {
    console.error('chart error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
