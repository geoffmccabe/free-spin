import { client, supabase, retryQuery, LEADERBOARD_CHANNEL_NAME } from './index.js';

async function handleLeaderboardCommand(interaction) {
  console.log(`Processing leaderboard command in channel: ${interaction.channel.name}`);
  try {
    await interaction.deferReply();
  } catch (error) {
    console.error(`Defer reply failed: ${error.message}`);
    return;
  }

  const server_id = interaction.guildId;
  const token_name = interaction.options.getString('token_name');

  const { data: raw_leaderboard, error } = await retryQuery(() =>
    supabase.rpc('fetch_leaderboard_text', { p_server_id: server_id, p_selected_token_name: token_name })
  );

  console.log(`Raw leaderboard: ${raw_leaderboard}`);

  if (error || !raw_leaderboard) {
    return interaction.editReply({ content: '❌ Failed to fetch leaderboard data.' });
  }

  const rows = raw_leaderboard.split('\n').filter(row => row.trim() && row.match(/^#\d+:/));
  if (rows.length === 0) {
    return interaction.editReply({ content: 'No spins recorded for this token in the last 30 days.' });
  }

  const user_ids = rows.map(row => {
    const match = row.match(/^#\d+: (\d+) —/);
    return match ? match[1] : null;
  }).filter(id => id);

  const userPromises = user_ids.map(id => client.users.fetch(id).then(user => ({id, user})).catch(() => ({id, user: null})));

  const fetchedUsers = await Promise.all(userPromises);

  const users = new Map(fetchedUsers.filter(f => f.user).map(f => [f.id, f.user]));

  const token = token_name || raw_leaderboard.match(/\*\*(.+?) Leaderboard\*\*/)?.[1] || 'Unknown';
  const leaderboard_text = `**${token} Leaderboard**\n${rows.map(row => {
    const match = row.match(/^#(\d+): (\d+) — ([\d.]+)/);
    if (!match) return '';
    const [, rank, discord_id, total_reward] = match;
    const adjusted_rank = parseInt(rank, 10);
    const user = users.get(discord_id);
    const username = user ? user.tag : `<@${discord_id}>`;
    return `#${adjusted_rank}: ${username} — ${total_reward} ${token}`;
  }).filter(row => row).join('\n')}`;

  return interaction.editReply({ content: leaderboard_text });
}

async function scheduleLeaderboardUpdates() {
  setInterval(async () => {
    const leaderboardChannel = client.channels.cache.find(channel =>
      channel.name.toLowerCase() === LEADERBOARD_CHANNEL_NAME.toLowerCase() && channel.isTextBased()
    );
    if (leaderboardChannel) {
      try {
        const { data: raw_leaderboard, error } = await retryQuery(() =>
          supabase.rpc('fetch_leaderboard_text')
        );
        if (error || !raw_leaderboard) {
          console.error(`Leaderboard interval error: ${error?.message || 'No data returned'}`);
          return;
        }
        console.log(`Leaderboard data: ${raw_leaderboard}`);
        const rows = raw_leaderboard.split('\n').filter(row => row.trim() && row.match(/^#\d+:/));
        if (rows.length === 0) {
          await leaderboardChannel.send('No spins recorded for this token in the last 30 days.');
          return;
        }
        const user_ids = rows.map(row => {
          const match = row.match(/^#\d+: (\d+) —/);
          return match ? match[1] : null;
        }).filter(id => id);
        const userPromises = user_ids.map(id => client.users.fetch(id).then(user => ({id, user})).catch(() => ({id, user: null})));
        const fetchedUsers = await Promise.all(userPromises);
        const users = new Map(fetchedUsers.filter(f => f.user).map(f => [f.id, f.user]));
        const token = raw_leaderboard.match(/\*\*(.+?) Leaderboard\*\*/)?.[1] || 'Unknown';
        const leaderboard_text = `**${token} Leaderboard**\n${rows.map(row => {
          const match = row.match(/^#(\d+): (\d+) — ([\d.]+)/);
          if (!match) return '';
          const [, rank, discord_id, total_reward] = match;
          const adjusted_rank = parseInt(rank, 10);
          const user = users.get(discord_id);
          const username = user ? user.tag : `<@${discord_id}>`;
          return `#${adjusted_rank}: ${username} — ${total_reward} ${token}`;
        }).filter(row => row).join('\n')}`;
        await leaderboardChannel.send(leaderboard_text);
      } catch (error) {
        console.error(`Error posting leaderboard: ${error.message}`);
      }
    } else {
      console.log(`Leaderboard channel not found: ${LEADERBOARD_CHANNEL_NAME}`);
    }
  }, 60 * 60 * 1000);
}

export { handleLeaderboardCommand, scheduleLeaderboardUpdates };
