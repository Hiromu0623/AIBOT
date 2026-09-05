import http from 'http';
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ActivityType,
  ChannelType,
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

// -------------------------------------------------------------
// 1. Render の Port 検出・スリープ回避用 HTTP サーバー (最優先起動)
// -------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive!');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP Server running on port ${PORT}`);
});

// -------------------------------------------------------------
// 2. 初期設定 & クライアント初期化
// -------------------------------------------------------------
const AUTHOR_ID = '1488322044335755294'; // 作者のDiscordユーザーID

// ★カスタム絵文字の定義
const EMOJI_LOADING = '<a:loading:1545302736684322926>';
const EMOJI_ERROR = '<a:error:1545303132358311997>';
const EMOJI_INFO = '<:info:1545303757796024330>';

// ★お知らせ配信の制御設定
const EXCLUDED_GUILD_ID = '1470380389561405554'; // 絶対に除外するサーバーID
const ENABLE_EXCLUDED_GUILD_ANNOUNCEMENT = false; // trueにすると除外サーバーにも送る / falseだと送らない

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildPresences, // 作者のオンライン状態取得用
  ],
});

// 会話記憶・ステータス管理用変数（RAM節約のため削減）
const serverHistories = new Map();
const MAX_HISTORY = 5; // RAM圧迫回避のため履歴保持数を5往復に最適化

const requestTimestamps = [];
const GEMINI_RPM_LIMIT = 15; // 1分間あたりの制限回数

let isProcessing = false;

// ★エラーカウント用変数
let apiErrorCount = 0;       // 429等のAPIエラー
let congestionErrorCount = 0; // 503混雑エラー

// ★/bot-info の各サーバー最新メッセージ管理 Map
const activeInfoMessages = new Map();

// ステータス更新関数
function updateBotStatus() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - 60000) {
    requestTimestamps.shift();
  }

  const serverCount = client.guilds.cache.size;
  const remainingRequests = Math.max(0, GEMINI_RPM_LIMIT - requestTimestamps.length);

  const statusText = `導入サーバー数 : ${serverCount} | 残り回答制限数 : ${remainingRequests}`;
  client.user.setActivity(statusText, { type: ActivityType.Custom });
}

// 共通ヘルプEmbed
function createHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('📖 AI Bot ヘルプ & 使い方ガイド')
    .setDescription('Gemini AIを搭載した高機能Botです！メンションや返信で話しかけてね。')
    .addFields(
      { name: '💬 会話する', value: 'Bot宛てにメンション（@Bot）するか、メッセージに返信（リプライ）して話しかけてください。' },
      { name: '📁 画像・ファイル解析', value: '画像、動画、ソースコード(.js等)などの添付ファイルも読み取れます！' },
      { name: '📊 ステータス確認', value: '「`/bot-info`」で現在のBotのリアルタイム情報を表示します。' },
      { name: '📢 一斉お知らせ機能', value: '管理者専用のコマンドです（`!AI <文章>`）。' },
      { name: '🧠 記憶リセット', value: '「`リセット`」または「`forget`」と送信すると、このサーバーでの会話履歴を初期化します。' },
      { name: '❓ 質問・提案を送る', value: '「`/bot-question`」コマンドを実行すると、開発者へ質問や提案を送信できます。' }
    )
    .setColor('#5865F2')
    .setFooter({ text: 'サーバーごとに独立した会話記憶を保持しています' });
}

// ★作者のステータス文字列を取得する関数
async function getAuthorStatus(guild) {
  try {
    let authorMember = null;
    if (guild) {
      authorMember = await guild.members.fetch(AUTHOR_ID).catch(() => null);
    }

    if (!authorMember) {
      for (const g of client.guilds.cache.values()) {
        authorMember = await g.members.fetch(AUTHOR_ID).catch(() => null);
        if (authorMember) break;
      }
    }

    if (!authorMember || !authorMember.presence) {
      return '⚪ オフライン（または取得不可）';
    }

    const status = authorMember.presence.status;
    switch (status) {
      case 'online': return '🟢 オンライン';
      case 'idle': return '🟡 退席中';
      case 'dnd': return '🔴 取り込み中';
      case 'offline': default: return '⚪ オフライン';
    }
  } catch (e) {
    return '⚪ オフライン';
  }
}

// ★/bot-info 用 Embed 生成関数（絵文字 <:info:...> をタイトルの最初に追加）
async function createInfoEmbed(guild) {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - 60000) {
    requestTimestamps.shift();
  }
  const remainingRequests = Math.max(0, GEMINI_RPM_LIMIT - requestTimestamps.length);
  const ping = client.ws.ping >= 0 ? `${client.ws.ping}ms` : '計測中...';

  // 各サーバー名に「メンバー数」を追加表示
  const guildNames = client.guilds.cache
    .map(g => `・ ${g.name} (👥 ${g.memberCount}人)`)
    .join('\n') || 'なし';

  const authorStatus = await getAuthorStatus(guild);

  return new EmbedBuilder()
    .setTitle(`${EMOJI_INFO} Bot リアルタイムステータス`)
    .setColor('#00ffcc')
    .addFields(
      { name: '👑 開発者ステータス', value: `\`${authorStatus}\``, inline: true },
      { name: '⚡ 残り回答制限数 (1分あたり)', value: `\`${remainingRequests} / ${GEMINI_RPM_LIMIT}\``, inline: true },
      { name: '📡 応答速度 (Ping)', value: `\`${ping}\``, inline: true },
      { name: '🏠 導入サーバー数', value: `\`${client.guilds.cache.size}\` サーバー`, inline: true },
      { name: '🚨 混雑エラー (503)', value: `\`${congestionErrorCount}\` 回`, inline: true },
      { name: '⚠️ APIエラー (429等)', value: `\`${apiErrorCount}\` 回`, inline: true },
      { name: '📋 導入サーバー一覧', value: guildNames.length > 1024 ? guildNames.slice(0, 1000) + '...' : guildNames }
    )
    .setFooter({ text: '🔄 10秒ごとにリアルタイム更新中' })
    .setTimestamp();
}

// ★503混雑エラー発生時の自動リトライ付き API 実行関数
async function generateContentWithRetry(ai, params, retries = 2, delay = 2000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      const errStr = String(err.message || err);
      if ((errStr.includes('503') || errStr.includes('UNAVAILABLE')) && i < retries) {
        console.log(`⚠️ 503混雑エラー発生。${delay / 1000}秒後に自動リトライします... (${i + 1}/${retries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

// -------------------------------------------------------------
// 3. Ready イベント
// -------------------------------------------------------------
client.once('clientReady', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}!`);
  updateBotStatus();

  // スラッシュコマンド登録
  try {
    const commands = [
      new SlashCommandBuilder().setName('help').setDescription('Botの使い方やヘルプを表示します'),
      new SlashCommandBuilder().setName('bot-info').setDescription('Botのリアルタイム情報（Ping、残り回答数等）を表示します'),
      new SlashCommandBuilder().setName('bot-question').setDescription('開発者へ質問や提案を送信します'),
      new SlashCommandBuilder().setName('bot-questionnaire').setDescription('Botのアンケートに回答します'),
    ];

    await client.application.commands.set(commands);
    console.log('✅ スラッシュコマンドを正常にグローバル登録しました！');
  } catch (cmdErr) {
    console.error('コマンド登録エラー:', cmdErr);
  }

  console.log('--------------------------------------------------');
  console.log(`🏠 導入中のサーバー一覧 (全 ${client.guilds.cache.size} サーバー):`);
  client.guilds.cache.forEach((guild) => {
    console.log(` - サーバー名: ${guild.name} (ID: ${guild.id}) | メンバー数: ${guild.memberCount}`);
  });
  console.log('--------------------------------------------------');

  setInterval(updateBotStatus, 30000);
  console.log('✅ Botが正常に起動しました！');
});

// -------------------------------------------------------------
// 4. インタラクション処理（ボタン、モーダル、コマンド）
// -------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  // --- スラッシュコマンド処理 ---
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'help') {
      await interaction.reply({ embeds: [createHelpEmbed()] }).catch(console.error);
      return;
    }

    // ★ /bot-info コマンド処理
    if (interaction.commandName === 'bot-info') {
      const guildId = interaction.guildId || `dm_${interaction.user.id}`;

      if (activeInfoMessages.has(guildId)) {
        const oldData = activeInfoMessages.get(guildId);
        clearInterval(oldData.intervalId);

        try {
          const oldChannel = await client.channels.fetch(oldData.channelId);
          if (oldChannel) {
            const oldMsg = await oldChannel.messages.fetch(oldData.messageId);
            if (oldMsg) await oldMsg.delete();
          }
        } catch (e) {}
      }

      const initialEmbed = await createInfoEmbed(interaction.guild);
      const response = await interaction.reply({ embeds: [initialEmbed], withResponse: true }).catch(console.error);
      const replyMsg = response?.resource?.message;

      if (replyMsg) {
        const intervalId = setInterval(async () => {
          try {
            const updatedEmbed = await createInfoEmbed(interaction.guild);
            await interaction.editReply({ embeds: [updatedEmbed] });
          } catch (err) {
            clearInterval(intervalId);
            activeInfoMessages.delete(guildId);
          }
        }, 10000);

        activeInfoMessages.set(guildId, {
          channelId: interaction.channelId,
          messageId: replyMsg.id,
          intervalId: intervalId,
        });
      }
      return;
    }

    if (interaction.commandName === 'bot-question') {
      const modal = new ModalBuilder().setCustomId('modal_bot_question').setTitle('Botへの質問・提案');
      const questionInput = new TextInputBuilder()
        .setCustomId('question_content')
        .setLabel('質問や提案の内容を入力してください')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(questionInput));
      await interaction.showModal(modal).catch(console.error);
    } 
    else if (interaction.commandName === 'bot-questionnaire') {
      const modal = new ModalBuilder().setCustomId('modal_bot_questionnaire').setTitle('Botアンケート');
      const q1Input = new TextInputBuilder().setCustomId('q1_content').setLabel('Q1. Botを使ってどう思いますか？').setStyle(TextInputStyle.Paragraph).setRequired(true);
      const q2Input = new TextInputBuilder().setCustomId('q2_content').setLabel('Q2. Botで提案したいことはありますか？').setStyle(TextInputStyle.Paragraph).setRequired(true);
      const q3Input = new TextInputBuilder().setCustomId('q3_content').setLabel('Q3. どのぐらいおすすめできるか教えてください。').setStyle(TextInputStyle.Short).setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(q1Input),
        new ActionRowBuilder().addComponents(q2Input),
        new ActionRowBuilder().addComponents(q3Input)
      );
      await interaction.showModal(modal).catch(console.error);
    }
  }

  // --- ボタン処理（作者が返信ボタンを押した時） ---
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('reply_to_user_')) {
      const targetUserId = interaction.customId.replace('reply_to_user_', '');

      const modal = new ModalBuilder()
        .setCustomId(`modal_reply_send_${targetUserId}`)
        .setTitle('ユーザーへの返信メッセージ作成');

      const replyInput = new TextInputBuilder()
        .setCustomId('reply_message_text')
        .setLabel('ユーザーに送る返信内容を入力してください')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(replyInput));
      await interaction.showModal(modal).catch(console.error);
    }
  }

  // --- モーダル送信処理 ---
  if (interaction.isModalSubmit()) {
    // 質問モーダル送信
    if (interaction.customId === 'modal_bot_question') {
      const content = interaction.fields.getTextInputValue('question_content');
      await interaction.reply({ content: '質問・提案を送信しました！ありがとうございます。', ephemeral: true }).catch(console.error);

      try {
        const author = await client.users.fetch(AUTHOR_ID);
        const embed = new EmbedBuilder()
          .setTitle('📩 新しい質問・提案が届きました')
          .addFields({ name: '送信者', value: `${interaction.user.tag} (${interaction.user.id})` }, { name: '内容', value: content })
          .setColor('#0099ff')
          .setTimestamp();

        const replyBtn = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`reply_to_user_${interaction.user.id}`)
            .setLabel('💬 送信者に返信')
            .setStyle(ButtonStyle.Primary)
        );

        await author.send({ embeds: [embed], components: [replyBtn] });
      } catch (e) {
        console.error('作者へのDM送信失敗:', e);
      }
    }

    // アンケートモーダル送信
    if (interaction.customId === 'modal_bot_questionnaire') {
      const q1 = interaction.fields.getTextInputValue('q1_content');
      const q2 = interaction.fields.getTextInputValue('q2_content');
      const q3 = interaction.fields.getTextInputValue('q3_content');

      await interaction.reply({ content: 'アンケートへのご協力ありがとうございました！', ephemeral: true }).catch(console.error);

      try {
        const author = await client.users.fetch(AUTHOR_ID);
        const embed = new EmbedBuilder()
          .setTitle('📊 新しいアンケート回答が届きました')
          .addFields(
            { name: '回答者', value: `${interaction.user.tag} (${interaction.user.id})` },
            { name: 'Q1', value: q1 }, { name: 'Q2', value: q2 }, { name: 'Q3', value: q3 }
          )
          .setColor('#00ff99')
          .setTimestamp();

        const replyBtn = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`reply_to_user_${interaction.user.id}`)
            .setLabel('💬 送信者に返信')
            .setStyle(ButtonStyle.Primary)
        );

        await author.send({ embeds: [embed], components: [replyBtn] });
      } catch (e) {
        console.error('作者へのDM送信失敗:', e);
      }
    }

    // 作者からユーザーへのDM返信処理
    if (interaction.customId.startsWith('modal_reply_send_')) {
      const targetUserId = interaction.customId.replace('modal_reply_send_', '');
      const replyMessage = interaction.fields.getTextInputValue('reply_message_text');

      await interaction.deferReply({ ephemeral: true });

      try {
        const targetUser = await client.users.fetch(targetUserId);
        const dmEmbed = new EmbedBuilder()
          .setTitle('📩 開発者（作者）からの返信が届きました')
          .setDescription(replyMessage)
          .setColor('#ff9900')
          .setFooter({ text: '※このメッセージはBotからの自動転送です' })
          .setTimestamp();

        await targetUser.send({ embeds: [dmEmbed] });
        await interaction.editReply({ content: `✅ <@${targetUserId}> への返信DMを正常に送信しました！` });
      } catch (err) {
        console.error('ユーザーへのDM返信失敗:', err);
        await interaction.editReply({ content: `❌ <@${targetUserId}> へのDM送信に失敗しました。（DMを受け取らない設定にしている可能性があります）` });
      }
    }
  }
});

// -------------------------------------------------------------
// 5. 通常メッセージ処理（会話、!AIコマンド等）
// -------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // 一斉お知らせ (!AI <文章>) - 特定サーバー除外つき
  if (message.content.startsWith('!AI ')) {
    if (message.author.id !== AUTHOR_ID) {
      await message.reply('⚠️ このコマンドはBot開発者（管理者）のみ実行できます。').catch(console.error);
      return;
    }

    const announcementText = message.content.slice(4).trim();
    if (!announcementText) {
      await message.reply('お知らせの文章を入力してください！').catch(console.error);
      return;
    }

    const guilds = client.guilds.cache;
    let successCount = 0;
    let skippedCount = 0;

    for (const [guildId, guild] of guilds) {
      if (guildId === EXCLUDED_GUILD_ID && !ENABLE_EXCLUDED_GUILD_ANNOUNCEMENT) {
        console.log(`🚫 除外指定サーバーのためスキップ: ${guild.name} (${guildId})`);
        skippedCount++;
        continue;
      }

      try {
        const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
        let targetChannel = guild.systemChannel;

        if (!targetChannel || !targetChannel.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages'])) {
          targetChannel = channels.find(
            (ch) =>
              ch &&
              ch.type === ChannelType.GuildText &&
              ch.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages'])
          );
        }

        if (targetChannel) {
          await targetChannel.send(`# AIBOTからのお知らせ\n${announcementText}`);
          console.log(`✅ 送信成功: ${guild.name} (#${targetChannel.name})`);
          successCount++;
        } else {
          console.log(`⚠️ 書き込み権限のあるチャンネルがありません: ${guild.name}`);
        }
      } catch (err) {
        console.error(`❌ お知らせ配信エラー (${guild.name}):`, err);
      }
    }

    let resultMsg = `📢 ${successCount}個のサーバーへお知らせを配信しました！`;
    if (skippedCount > 0) {
      resultMsg += `\n(※除外設定により ${skippedCount} 個のサーバーをスキップしました)`;
    }

    await message.reply(resultMsg).catch(console.error);
    return;
  }

  const prompt = message.content.replace(/<@[!&]?\d+>/g, '').replace(/<#\d+>/g, '').trim();

  if (prompt.toLowerCase() === 'help' || prompt === 'ヘルプ') {
    await message.reply({ embeds: [createHelpEmbed()] }).catch(console.error);
    return;
  }

  const isMentioned = message.mentions.has(client.user);
  let isReplyToBot = false;
  if (message.reference && message.reference.messageId) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMessage.author.id === client.user.id) {
        isReplyToBot = true;
      }
    } catch (e) {}
  }

  if (!isMentioned && !isReplyToBot) return;

  if (isProcessing) {
    await message.reply(`${EMOJI_LOADING} 現在、他の質問を処理中だよ！順番に話しかけてね。`).catch(console.error);
    return;
  }

  const contextKey = message.guild ? `guild_${message.guild.id}` : `dm_${message.author.id}`;
  let loadingMsg = null;

  try {
    isProcessing = true;

    if (prompt === 'リセット' || prompt === 'forget') {
      serverHistories.delete(contextKey);
      await message.reply('🧠 このサーバーでの会話の記憶をリセットしました！').catch(console.error);
      return;
    }

    if (!prompt && message.attachments.size === 0) {
      await message.reply('何か質問、メッセージ、またはファイルを送信してください！').catch(console.error);
      return;
    }

    // ★回答待機中メッセージを送信
    loadingMsg = await message.reply(`${EMOJI_LOADING} 回答を待機中...`).catch(console.error);

    if (!serverHistories.has(contextKey)) {
      serverHistories.set(contextKey, []);
    }
    const history = serverHistories.get(contextKey);

    const jstNow = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    let textContent = `[現在の日本時間: ${jstNow}]\n${prompt}`;

    const userParts = [];

    if (message.attachments.size > 0) {
      for (const [_, attachment] of message.attachments) {
        try {
          const response = await fetch(attachment.url);
          const mimeType = attachment.contentType || '';

          if (
            mimeType.includes('text') ||
            mimeType.includes('javascript') ||
            mimeType.includes('json') ||
            attachment.name.endsWith('.js') ||
            attachment.name.endsWith('.txt') ||
            attachment.name.endsWith('.json')
          ) {
            const fileText = await response.text();
            textContent += `\n\n--- 添付ファイル (${attachment.name}) ---\n${fileText}`;
          } else {
            const arrayBuffer = await response.arrayBuffer();
            const base64Data = Buffer.from(arrayBuffer).toString('base64');

            userParts.push({
              inlineData: {
                mimeType: mimeType.startsWith('image/') ? mimeType : 'image/jpeg',
                data: base64Data,
              },
            });
          }
        } catch (fileErr) {
          console.error('ファイル読み込みエラー:', fileErr);
        }
      }
    }

    userParts.push({ text: textContent });

    history.push({
      role: 'user',
      parts: userParts,
    });

    requestTimestamps.push(Date.now());
    updateBotStatus();

    // ★自動リトライ付き API 呼び出し
    const response = await generateContentWithRetry(ai, {
      model: 'gemini-2.5-flash',
      contents: history,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const replyText = response.text || '（返答を取得できませんでした）';

    history.push({
      role: 'model',
      parts: [{ text: replyText }],
    });

    // RAM容量保護のため、履歴がMAX_HISTORYを超えたら即削除
    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, history.length - (MAX_HISTORY * 2));
    }

    // ★待機中メッセージを実際の回答に編集
    if (replyText.length > 1900) {
      const chunks = replyText.match(/[\s\S]{1,1900}/g) || [replyText];
      if (loadingMsg) {
        await loadingMsg.edit(chunks[0]).catch(console.error);
      } else {
        await message.reply(chunks[0]).catch(console.error);
      }
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]).catch(console.error);
      }
    } else {
      if (loadingMsg) {
        await loadingMsg.edit(replyText).catch(console.error);
      } else {
        await message.reply(replyText).catch(console.error);
      }
    }

  } catch (error) {
    console.error('API Exec Error:', error);

    const history = serverHistories.get(contextKey);
    if (history && history.length > 0) {
      history.pop();
    }

    const errorStr = String(error.message || error);
    const guildName = message.guild ? message.guild.name : 'ダイレクトメッセージ';
    const channelName = message.channel ? (message.channel.name || 'DM') : '不明';

    // エラー時の返信関数（待機中メッセージがあれば編集、なければ新規返信）
    const sendErrorReply = async (content) => {
      if (loadingMsg) {
        await loadingMsg.edit(content).catch(console.error);
      } else {
        await message.reply(content).catch(console.error);
      }
    };

    // 503 混雑エラー
    if (errorStr.includes('503') || errorStr.includes('UNAVAILABLE')) {
      congestionErrorCount++;
      await sendErrorReply(
        `${EMOJI_ERROR} **Gemini サーバー混雑エラー (503)**\n` +
        `現在、Gemini のサーバーが混み合っています。\n` +
        `📍 **発生場所**: サーバー「**${guildName}**」 / チャンネル「**#${channelName}**」\n` +
        `少し時間をおいてから再度お試しください。`
      );
      return;
    }

    // 429 レート制限エラー
    if (errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED')) {
      apiErrorCount++;
      let retryTime = '不明（少し待ってからお試しください）';
      const retryMatch = errorStr.match(/"retryDelay"\s*:\s*"([^"]+)"/) || errorStr.match(/Please retry in ([^\s]+)/);
      if (retryMatch && retryMatch[1]) retryTime = retryMatch[1];

      await sendErrorReply(
        `${EMOJI_ERROR} **API利用制限エラー (429)**\n` +
        `無料枠のリクエスト上限に達しました。\n` +
        `⏱️ **再試行までの目安時間**: \`${retryTime}\``
      );
      return;
    }

    // 未知のエラー（404等含む）が発生した場合
    apiErrorCount++;
    await sendErrorReply(`${EMOJI_ERROR} **予期せぬエラーが発生しました**\n\`\`\`js\n${errorStr.slice(0, 1800)}\n\`\`\``);

    try {
      const author = await client.users.fetch(AUTHOR_ID);
      const errEmbed = new EmbedBuilder()
        .setTitle('🚨 未知のBotエラーが発生しました')
        .addFields(
          { name: '発生サーバー', value: `${guildName} (${message.guild?.id || 'DM'})` },
          { name: '発生チャンネル', value: `#${channelName}` },
          { name: '実行ユーザー', value: `${message.author.tag} (${message.author.id})` },
          { name: 'エラー内容', value: `\`\`\`js\n${errorStr.slice(0, 1000)}\n\`\`\`` }
        )
        .setColor('#ff0000')
        .setTimestamp();
      await author.send({ embeds: [errEmbed] });
    } catch (dmErr) {
      console.error('開発者へのエラーDM通知失敗:', dmErr);
    }

  } finally {
    isProcessing = false;
  }
});

console.log('🔑 Attempting to login to Discord...');
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('🔑 Discord login promise resolved.'))
  .catch((err) => {
    console.error('❌ Discord Login Error:', err);
  });
