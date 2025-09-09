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

  const { data: leaderboardData, error } = await retryQuery(() =>
    supabase.rpc('fetch_leaderboard_text', { p_server_id: server_id, p_selected_token_name: token_name })
  );

  if (error || !leaderboardData) {
    return interaction.editReply({ content: '❌ Failed to fetch leaderboard data.' });
  }

  if (leaderboardData.error) {
    return interaction.editReply({ content: leaderboardData.error });
  }

  const token = leaderboardData.token_name;
  const leaderboard = leaderboardData.leaderboard || [];

  if (leaderboard.length === 0) {
    return interaction.editReply({ content: 'No spins recorded for this token in the last 30 days.' });
  }

  const user_ids = leaderboard.map(entry => entry.discord_id);

  const userPromises = user_ids.map(id => client.users.fetch(id).then(user => ({id, user})).catch(() => ({id, user: null})));

  const fetchedUsers = await Promise.all(userPromises);

  const users = new Map(fetchedUsers.filter(f => f.user).map(f => [f.id, f.user]));

  const leaderboard_text = `**${token} Leaderboard**\n` + leaderboard.map(entry => {
    const rank = entry.rank;
    const discord_id = entry.discord_id;
    const total_reward = entry.total_reward;
    const user = users.get(discord_id);
    const username = user ? user.tag : `<@${discord_id}>`;
    return `#${rank}: ${username} — ${total_reward} ${token}`;
  }).join('\n');

  return interaction.editReply({ content: leaderboard_text });
}

async function scheduleLeaderboardUpdates() {
  setInterval(async () => {
    const leaderboardChannel = client.channels.cache.find(channel =>
      channel.name.toLowerCase() === LEADERBOARD_CHANNEL_NAME.toLowerCase() && channel.isTextBased()
    );
    if (leaderboardChannel) {
      try {
        const { data: leaderboardData, error } = await retryQuery(() =>
          supabase.rpc('fetch_leaderboard_text', { p_server_id: '970415158058950716', p_selected_token_name: null })
        );
        if (error || !leaderboardData) {
          console.error(`Leaderboard interval error: ${error?.message || 'No data returned'}`);
          return;
        }
        if (leaderboardData.error) {
          await leaderboardChannel.send(leaderboardData.error);
          return;
        }
        const token = leaderboardData.token_name;
        const leaderboard = leaderboardData.leaderboard || [];
        if (leaderboard.length === 0) {
          await leaderboardChannel.send('No spins recorded for this token in the last 30 days.');
          return;
        }
        const user_ids = leaderboard.map(entry => entry.discord_id);
        const userPromises = user_ids.map(id => client.users.fetch(id).then(user => ({id, user})).catch(() => ({id, user: null})));
        const fetchedUsers = await Promise.all(userPromises);
        const users = new Map(fetchedUsers.filter(f => f.user).map(f => [f.id, f.user]));
        const leaderboard_text = `**${token} Leaderboard**\n` + leaderboard.map(entry => {
          const rank = entry.rank;
          const discord_id = entry.discord_id;
          const total_reward = entry.total_reward;
          const user = users.get(discord_id);
          const username = user ? user.tag : `<@${discord_id}>`;
          return `#${rank}: ${username} — ${total_reward} ${token}`;
        }).join('\n');
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
