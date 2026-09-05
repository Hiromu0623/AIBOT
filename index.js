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

// 会話記憶・ステータス管理用変数
const serverHistories = new Map();
const MAX_HISTORY = 5;

const requestTimestamps = [];
const GEMINI_RPM_LIMIT = 15;

let isProcessing = false;

// エラーカウント用変数
let apiErrorCount = 0;       // 429等のAPIエラー
let congestionErrorCount = 0; // 503混雑エラー

// /bot-info の各サーバー最新メッセージ管理 Map
const activeInfoMessages = new Map();

// -------------------------------------------------------------
// 管理パネル (Admin Panel) 用の各種管理変数
// -------------------------------------------------------------
const startTime = Date.now(); // 稼働時間計測用
let totalCommandCount = 0;   // 累計コマンド・会話実行回数

// 管理パネルの表示メッセージ保持 (削除用)
let lastAdminMessage = null;

// 管理者の操作ステップ管理: null | 'panel' | 'server' | 'all'
let adminState = null;

// 停止状態フラグ
let isAllStopped = false;            // 全サーバー停止
const stoppedGuilds = new Set();     // 特定サーバー停止 (Guild ID)

// Admin Panel メッセージの削除＆新規送信共通処理
async function sendAdminPanelMessage(channel, embed) {
  if (lastAdminMessage) {
    try {
      await lastAdminMessage.delete();
    } catch (e) {
      // 既に削除されている場合などは無視
    }
    lastAdminMessage = null;
  }
  const sentMsg = await channel.send({ embeds: [embed] }).catch(console.error);
  if (sentMsg) {
    lastAdminMessage = sentMsg;
  }
  return sentMsg;
}

// 稼働時間のフォーマット関数
function getUptimeString() {
  const diff = Math.floor((Date.now() - startTime) / 1000);
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  return `${days}日 ${hours}時間 ${minutes}分 ${seconds}秒`;
}

// サーバーのデフォルト送信先チャンネル取得関数
async function getDefaultChannel(guild) {
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
  return targetChannel;
}

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
      { name: '🧠 記憶リセット', value: '「`リセット`」または「`forget`」と送信すると、このサーバーでの会話履歴を初期化します。' },
      { name: '❓ 質問・提案を送る', value: '「`/bot-question`」コマンドを実行すると、開発者へ質問や提案を送信できます。' }
    )
    .setColor('#5865F2')
    .setFooter({ text: 'サーバーごとに独立した会話記憶を保持しています' });
}

// 作者のステータス文字列を取得する関数
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

// /bot-info 用 Embed 生成関数
async function createInfoEmbed(guild) {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - 60000) {
    requestTimestamps.shift();
  }
  const remainingRequests = Math.max(0, GEMINI_RPM_LIMIT - requestTimestamps.length);
  const ping = client.ws.ping >= 0 ? `${client.ws.ping}ms` : '計測中...';

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

// 503混雑エラー発生時の自動リトライ付き API 実行関数
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
  if (interaction.isChatInputCommand()) {
    totalCommandCount++;

    if (interaction.commandName === 'help') {
      await interaction.reply({ embeds: [createHelpEmbed()] }).catch(console.error);
      return;
    }

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

  if (interaction.isModalSubmit()) {
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
// 5. 通常メッセージ処理（管理パネル・会話等）
// -------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const contentTrimmed = message.content.trim();

  // -----------------------------------------------------------
  // A. 管理者専用 管理パネル機能 (Admin Panel)
  // -----------------------------------------------------------
  if (contentTrimmed.startsWith('!AI ')) {
    const args = contentTrimmed.slice(4).trim().split(/\s+/);
    const subCommand = args[0] ? args[0].toLowerCase() : '';

    // 管理者権限チェック
    if (message.author.id !== AUTHOR_ID) {
      await message.reply('⚠️ このコマンドはBot開発者（管理者）のみ実行できます。').catch(console.error);
      return;
    }

    totalCommandCount++;

    // 1. !AI AdminPanel (メインパネル開く)
    if (subCommand === 'adminpanel') {
      adminState = 'panel';
      const embed = new EmbedBuilder()
        .setTitle('⚙️ Admin Panel')
        .setDescription(
          '**server** : Server AI Bot Settings\n' +
          '**All** : All AIBOT settings\n' +
          '**Info** : Bot Info\n' +
          '**Cancel** : Exit Admin Panel'
        )
        .setColor('#2b2d31');

      await sendAdminPanelMessage(message.channel, embed);
      return;
    }

    // 2. !AI Cancel (パネル閉じる)
    if (subCommand === 'cancel') {
      if (adminState !== null) {
        adminState = null;
        if (lastAdminMessage) {
          try {
            await lastAdminMessage.delete();
          } catch (e) {}
          lastAdminMessage = null;
        }
      }
      return;
    }

    // 3. !AI server 関連機能
    if (subCommand === 'server') {
      if (adminState !== 'panel' && adminState !== 'server') return;

      const action = args[1] ? args[1].toLowerCase() : '';

      // サブアクションなし: メニューを表示して状態変更
      if (!action) {
        adminState = 'server';
        const embed = new EmbedBuilder()
          .setTitle('⚙️ Server AIBOT Settings')
          .setDescription(
            '**Stop** : Servers AIBOT Stop\n' +
            '**Start** : Servers AIBOT Start\n' +
            '**Send** : Send Message\n' +
            '**ServerInfo** : Server Info'
          )
          .setColor('#0099ff');

        await sendAdminPanelMessage(message.channel, embed);
        return;
      }

      // 状態が 'server' の場合のみアクションを実行可能
      if (adminState === 'server') {
        const guild = message.guild;

        if (action === 'stop') {
          if (guild) stoppedGuilds.add(guild.id);
          const embed = new EmbedBuilder()
            .setTitle('⚙️ Server AIBOT Settings')
            .setDescription(`🛑 このサーバー（${guild ? guild.name : 'DM'}）で AIBOT の応答を停止しました。`)
            .setColor('#ff0000');
          await sendAdminPanelMessage(message.channel, embed);
          return;
        }

        if (action === 'start') {
          if (guild) stoppedGuilds.delete(guild.id);
          const embed = new EmbedBuilder()
            .setTitle('⚙️ Server AIBOT Settings')
            .setDescription(`🟢 このサーバー（${guild ? guild.name : 'DM'}）で AIBOT の応答を再開しました。`)
            .setColor('#00ff00');
          await sendAdminPanelMessage(message.channel, embed);
          return;
        }

        if (action === 'send') {
          const sendText = args.slice(2).join(' ');
          if (!sendText) {
            const embed = new EmbedBuilder()
              .setTitle('⚙️ Server AIBOT Settings')
              .setDescription('⚠️ 送信するメッセージを指定してください。（例: `!AI server send メッセージ`）')
              .setColor('#ffff00');
            await sendAdminPanelMessage(message.channel, embed);
            return;
          }

          if (guild) {
            const targetCh = await getDefaultChannel(guild);
            if (targetCh) {
              await targetCh.send(sendText).catch(console.error);
              const embed = new EmbedBuilder()
                .setTitle('⚙️ Server AIBOT Settings')
                .setDescription(`✉️ #${targetCh.name} にメッセージを送信しました！`)
                .setColor('#00ff00');
              await sendAdminPanelMessage(message.channel, embed);
            } else {
              const embed = new EmbedBuilder()
                .setTitle('⚙️ Server AIBOT Settings')
                .setDescription('❌ 書き込み可能なチャンネルが見つかりませんでした。')
                .setColor('#ff0000');
              await sendAdminPanelMessage(message.channel, embed);
            }
          }
          return;
        }

        if (action === 'info' || action === 'serverinfo') {
          if (guild) {
            const embed = new EmbedBuilder()
              .setTitle(`📊 Server Info - ${guild.name}`)
              .addFields(
                { name: 'サーバーID', value: `\`${guild.id}\``, inline: true },
                { name: 'メンバー数', value: `\`${guild.memberCount}\` 人`, inline: true },
                { name: '応答ステータス', value: stoppedGuilds.has(guild.id) ? '🔴 停止中' : '🟢 稼働中', inline: true }
              )
              .setColor('#00ffff');
            await sendAdminPanelMessage(message.channel, embed);
          }
          return;
        }
      }
      return;
    }

    // 4. !AI All 関連機能
    if (subCommand === 'all') {
      if (adminState !== 'panel' && adminState !== 'all') return;

      const action = args[1] ? args[1].toLowerCase() : '';

      // サブアクションなし: メニューを表示して状態変更
      if (!action) {
        adminState = 'all';
        const embed = new EmbedBuilder()
          .setTitle('⚙️ All AIBOT Settings')
          .setDescription(
            '**Stop** : All AIBOT Stop\n' +
            '**Start** : All AIBOT Start\n' +
            '**Send** : All Send Messages\n' +
            '**ServerInfo** : All Servers Info'
          )
          .setColor('#ff9900');

        await sendAdminPanelMessage(message.channel, embed);
        return;
      }

      // 状態が 'all' の場合のみアクションを実行可能
      if (adminState === 'all') {
        if (action === 'stop') {
          isAllStopped = true;
          const embed = new EmbedBuilder()
            .setTitle('⚙️ All AIBOT Settings')
            .setDescription('🛑 **すべてのサーバー**で AIBOT の応答を一時停止しました。')
            .setColor('#ff0000');
          await sendAdminPanelMessage(message.channel, embed);
          return;
        }

        if (action === 'start') {
          isAllStopped = false;
          const embed = new EmbedBuilder()
            .setTitle('⚙️ All AIBOT Settings')
            .setDescription('🟢 **すべてのサーバー**で AIBOT の応答を再開しました。')
            .setColor('#00ff00');
          await sendAdminPanelMessage(message.channel, embed);
          return;
        }

        if (action === 'send') {
          const sendText = args.slice(2).join(' ');
          if (!sendText) {
            const embed = new EmbedBuilder()
              .setTitle('⚙️ All AIBOT Settings')
              .setDescription('⚠️ 送信するメッセージを指定してください。（例: `!AI all send メッセージ`）')
              .setColor('#ffff00');
            await sendAdminPanelMessage(message.channel, embed);
            return;
          }

          let successCount = 0;
          for (const guild of client.guilds.cache.values()) {
            const targetCh = await getDefaultChannel(guild);
            if (targetCh) {
              await targetCh.send(sendText).catch(() => null);
              successCount++;
            }
          }

          const embed = new EmbedBuilder()
            .setTitle('⚙️ All AIBOT Settings')
            .setDescription(`📢 ${successCount} 個のサーバーに一斉メッセージを送信しました。`)
            .setColor('#00ff00');
          await sendAdminPanelMessage(message.channel, embed);
          return;
        }

        if (action === 'info' || action === 'serverinfo') {
          const guildList = client.guilds.cache
            .map(g => `・ **${g.name}** (ID: \`${g.id}\` | 👥 ${g.memberCount}人)`)
            .join('\n') || 'なし';

          const embed = new EmbedBuilder()
            .setTitle('📋 All Servers Info')
            .setDescription(guildList.length > 4000 ? guildList.slice(0, 4000) + '...' : guildList)
            .setColor('#00ffcc');
          await sendAdminPanelMessage(message.channel, embed);
          return;
        }
      }
      return;
    }

    // 5. !AI Info (詳細 Bot 情報・要約機能付き)
    if (subCommand === 'info') {
      if (adminState !== 'panel') return;

      const now = Date.now();
      while (requestTimestamps.length > 0 && requestTimestamps[0] < now - 60000) {
        requestTimestamps.shift();
      }
      const remainingRequests = Math.max(0, GEMINI_RPM_LIMIT - requestTimestamps.length);
      const ping = client.ws.ping >= 0 ? `${client.ws.ping}ms` : '計測中...';
      const totalErrors = apiErrorCount + congestionErrorCount;
      const uptimeStr = getUptimeString();

      // 各サーバーの会話ログをまとめる
      let rawConversations = '';
      for (const [key, history] of serverHistories.entries()) {
        if (history.length > 0) {
          rawConversations += `\n【コンテキスト: ${key}】\n`;
          history.forEach(item => {
            const role = item.role === 'user' ? 'ユーザー' : 'Bot';
            const textPart = item.parts.map(p => p.text || '[メディア/添付ファイル]').join(' ');
            rawConversations += `${role}: ${textPart}\n`;
          });
        }
      }

      let aiSummary = '会話記憶データがありません。';
      if (rawConversations.trim().length > 0) {
        try {
          const summaryPrompt = `以下の各サーバー/DMでの会話履歴を、サーバーごとにどのような会話が行われているか箇条書きで簡潔に要約整理してください:\n${rawConversations}`;
          const summaryRes = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: summaryPrompt }] }],
          });
          aiSummary = summaryRes.text || '要約の取得に失敗しました。';
        } catch (sumErr) {
          console.error('要約エラー:', sumErr);
          aiSummary = '要約処理中にエラーが発生しました。';
        }
      }

      const infoText = 
        `**Ping** : ${ping}\n` +
        `**Rest** : ${remainingRequests} / ${GEMINI_RPM_LIMIT}\n` +
        `**Error** : ${totalErrors} 回 (429: ${apiErrorCount} / 503: ${congestionErrorCount})\n` +
        `**Operating time** : ${uptimeStr}\n` +
        `**Command count** : ${totalCommandCount} 回\n\n` +
        `**AI information** :\n${aiSummary}`;

      const embed = new EmbedBuilder()
        .setTitle('ℹ️ AIBOT Info')
        .setDescription(infoText.length > 4000 ? infoText.slice(0, 4000) + '...' : infoText)
        .setColor('#00ffff');

      await sendAdminPanelMessage(message.channel, embed);
      return;
    }

    // ※単体の `!AI <メッセージ>` お知らせ一斉送信機能は廃止したため、定義されていないサブコマンドは無視されます。
    return;
  }

  // -----------------------------------------------------------
  // B. 通常メッセージ・会話処理
  // -----------------------------------------------------------
  const prompt = message.content.replace(/<@[!&]?\d+>/g, '').replace(/<#\d+>/g, '').trim();

  if (prompt.toLowerCase() === 'help' || prompt === 'ヘルプ') {
    totalCommandCount++;
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

  // ★ 停止設定のチェック (Stop機能有効時は応答しない)
  if (isAllStopped) return;
  if (message.guild && stoppedGuilds.has(message.guild.id)) return;

  totalCommandCount++;

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

    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, history.length - (MAX_HISTORY * 2));
    }

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

    const sendErrorReply = async (content) => {
      if (loadingMsg) {
        await loadingMsg.edit(content).catch(console.error);
      } else {
        await message.reply(content).catch(console.error);
      }
    };

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

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Discord Login Error:', err);
});
