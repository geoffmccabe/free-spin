import { client, supabase, retryQuery } from './index.js';

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

function daysAgoISO(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

async function resolveTokenForServer(server_id, token_name) {
  // Load configs for this server
  const { data: cfgs, error: cfgErr } = await retryQuery(() =>
    supabase
      .from('wheel_configurations')
      .select('contract_address, token_name, decimals')
      .eq('server_id', server_id)
  );
  if (cfgErr) return { error: cfgErr.message };

  if (!cfgs || !cfgs.length) return { error: 'No wheel configuration found for this server.' };

  // If token_name provided, match it
  if (token_name) {
    const wanted = normalize(token_name);
    const match = cfgs.find(c => normalize(c.token_name) === wanted);
    if (!match) return { error: 'Unknown token name for this server.' };
    return { contract_address: match.contract_address, token_name: match.token_name, decimals: match.decimals || 0 };
  }

  // Otherwise use server default token if configured
  const { data: st, error: stErr } = await retryQuery(() =>
    supabase
      .from('server_tokens')
      .select('contract_address, is_default, enabled')
      .eq('server_id', server_id)
  );
  if (!stErr && st && st.length) {
    const def = st.find(x => x.is_default === true && x.enabled !== false);
    if (def) {
      const match = cfgs.find(c => c.contract_address === def.contract_address);
      if (match) return { contract_address: match.contract_address, token_name: match.token_name, decimals: match.decimals || 0 };
    }
  }

  // Fallback first config
  const first = cfgs[0];
  return { contract_address: first.contract_address, token_name: first.token_name, decimals: first.decimals || 0 };
}

async function handleLeaderboardCommand(interaction) {
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (error) {
    console.error(`Defer reply failed: ${error.message}`);
    return;
  }

  const server_id = interaction.guildId;
  const token_name = interaction.options.getString('token_name');

  const tok = await resolveTokenForServer(server_id, token_name);
  if (tok.error) return interaction.editReply({ content: `❌ ${tok.error}`, flags: 64 });

  const startISO = daysAgoISO(30);

  const { data: rows, error } = await retryQuery(() =>
    supabase
      .from('daily_spins')
      .select('discord_id, payout_amount_raw, created_at')
      .eq('server_id', server_id)
      .eq('contract_address', tok.contract_address)
      .gte('created_at', startISO)
  );

  if (error) return interaction.editReply({ content: '❌ Failed to fetch leaderboard data.', flags: 64 });

  // Aggregate
  const map = new Map();
  for (const r of rows || []) {
    const id = r.discord_id;
    const obj = map.get(id) || { discord_id: id, spins: 0, payoutBase: 0n };
    obj.spins += 1;
    const base = r.payout_amount_raw != null ? BigInt(String(r.payout_amount_raw).split('.')[0]) : 0n;
    obj.payoutBase += base;
    map.set(id, obj);
  }

  let list = Array.from(map.values()).map(v => ({
    discord_id: v.discord_id,
    spins: v.spins,
    payout: Number(v.payoutBase) / (10 ** (tok.decimals || 0))
  }));

  list.sort((a, b) => b.payout - a.payout);
  list = list.slice(0, 10);

  if (!list.length) {
    return interaction.editReply({ content: `No spins recorded for ${tok.token_name} in the last 30 days.`, flags: 64 });
  }

  // Fetch Discord usernames
  const fetched = await Promise.all(
    list.map(x => client.users.fetch(x.discord_id).then(u => ({ id: x.discord_id, tag: u.tag })).catch(() => ({ id: x.discord_id, tag: `<@${x.discord_id}>` })))
  );
  const nameMap = new Map(fetched.map(x => [x.id, x.tag]));

  const text =
    `**${tok.token_name} Leaderboard (30d)**\n` +
    list.map((e, i) => `#${i + 1}: ${nameMap.get(e.discord_id)} — ${e.payout} ${tok.token_name} (${e.spins} spins)`).join('\n');

  return interaction.editReply({ content: text, flags: 64 });
}

export { handleLeaderboardCommand };
