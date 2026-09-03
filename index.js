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
} from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

// -------------------------------------------------------------
// 1. Render のスリープ回避用 HTTP サーバー
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive!');
}).listen(PORT, () => {
  console.log(`🌐 HTTP Server running on port ${PORT}`);
});

// -------------------------------------------------------------
// 2. 初期設定 & クライアント初期化
// -------------------------------------------------------------
const AUTHOR_ID = '1488322044335755294'; // 作者のDiscordユーザーID

// ★お知らせ配信の制御設定
const EXCLUDED_GUILD_ID = '1470380389561405554'; // 除外対象のサーバーID
const ENABLE_EXCLUDED_GUILD_ANNOUNCEMENT = false; // trueにすると除外サーバーにも送る / falseだと送らない

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// サーバー（Guild）ごとの会話記憶用 Map
const serverHistories = new Map();
const MAX_HISTORY = 10;

// APIレート制限計算用（1分間あたりのリクエスト履歴）
const requestTimestamps = [];
const GEMINI_RPM_LIMIT = 15; // Gemini API Free Tier (Flash) の1分間あたりの制限回数

// 処理中フラグ（連続呼び出し防止用）
let isProcessing = false;

// ★ステータス（アクティビティ）の更新関数
function updateBotStatus() {
  const now = Date.now();
  // 1分(60,000ミリ秒)以上前の古い記録を削除
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - 60000) {
    requestTimestamps.shift();
  }

  const serverCount = client.guilds.cache.size;
  const remainingRequests = Math.max(0, GEMINI_RPM_LIMIT - requestTimestamps.length);

  const statusText = `導入サーバー数 : ${serverCount} | 残り回答制限数 : ${remainingRequests}`;
  client.user.setActivity(statusText, { type: ActivityType.Custom });
}

// 共通ヘルプEmbed生成関数
function createHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('📖 AI Bot ヘルプ & 使い方ガイド')
    .setDescription('Gemini AIを搭載した高機能Botです！メンションや返信で話しかけてね。')
    .addFields(
      { name: '💬 会話する', value: 'Bot宛てにメンション（@Bot）するか、メッセージに返信（リプライ）して話しかけてください。' },
      { name: '📁 画像・ファイル解析', value: '画像、動画、ソースコード(.js等)などの添付ファイルも読み取れます！' },
      { name: '📢 一斉お知らせ機能', value: '管理者専用のコマンドです（`!AI <文章>`）。' },
      { name: '🧠 記憶リセット', value: '「`リセット`」または「`forget`」と送信すると、このサーバーでの会話履歴を初期化します。' },
      { name: '❓ 質問・提案を送る', value: '「`/bot-question`」コマンドを実行すると、開発者へ質問や提案を送信できます。' },
      { name: '📝 アンケートに答える', value: '「`/bot-questionnaire`」コマンドでアンケートにご回答いただけます。' }
    )
    .setColor('#5865F2')
    .setFooter({ text: 'サーバーごとに独立した会話記憶を保持しています' });
}

// -------------------------------------------------------------
// 3. Ready イベント（ログイン & ステータス設定 & コマンド自動登録）
// -------------------------------------------------------------
client.once('clientReady', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}!`);
  updateBotStatus();

  // ★スラッシュコマンド (/help など) のグローバル登録
  try {
    const helpCommand = new SlashCommandBuilder()
      .setName('help')
      .setDescription('Botの使い方やヘルプを表示します');

    await client.application.commands.create(helpCommand);
    console.log('✅ /help スラッシュコマンドを正常に登録しました！');
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
// 4. モーダル ＆ スラッシュコマンド (Interaction) 処理
// -------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'help') {
      await interaction.reply({ embeds: [createHelpEmbed()] }).catch(console.error);
      return;
    }

    if (interaction.commandName === 'bot-question') {
      const modal = new ModalBuilder()
        .setCustomId('modal_bot_question')
        .setTitle('Botへの質問・提案');

      const questionInput = new TextInputBuilder()
        .setCustomId('question_content')
        .setLabel('質問や提案の内容を入力してください')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(questionInput));
      await interaction.showModal(modal).catch(console.error);
    } 
    else if (interaction.commandName === 'bot-questionnaire') {
      const modal = new ModalBuilder()
        .setCustomId('modal_bot_questionnaire')
        .setTitle('Botアンケート');

      const q1Input = new TextInputBuilder()
        .setCustomId('q1_content')
        .setLabel('Q1. Botを使ってどう思いますか？')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const q2Input = new TextInputBuilder()
        .setCustomId('q2_content')
        .setLabel('Q2. Botで提案したいことはありますか？')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const q3Input = new TextInputBuilder()
        .setCustomId('q3_content')
        .setLabel('Q3. どのぐらいおすすめできるか教えてください。')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(q1Input),
        new ActionRowBuilder().addComponents(q2Input),
        new ActionRowBuilder().addComponents(q3Input)
      );

      await interaction.showModal(modal).catch(console.error);
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_bot_question') {
      const content = interaction.fields.getTextInputValue('question_content');
      const userTag = interaction.user.tag;

      await interaction.reply({ content: '質問・提案を送信しました！ありがとうございます。', ephemeral: true }).catch(console.error);

      try {
        const author = await client.users.fetch(AUTHOR_ID);
        const embed = new EmbedBuilder()
          .setTitle('📩 新しい質問・提案が届きました')
          .addFields(
            { name: '送信者', value: `${userTag} (${interaction.user.id})` },
            { name: '内容', value: content }
          )
          .setColor('#0099ff')
          .setTimestamp();

        await author.send({ embeds: [embed] });
      } catch (e) {
        console.error('作者へのDM送信失敗:', e);
      }
    }

    if (interaction.customId === 'modal_bot_questionnaire') {
      const q1 = interaction.fields.getTextInputValue('q1_content');
      const q2 = interaction.fields.getTextInputValue('q2_content');
      const q3 = interaction.fields.getTextInputValue('q3_content');
      const userTag = interaction.user.tag;

      await interaction.reply({ content: 'アンケートへのご協力ありがとうございました！感謝メッセージをDMでお送りしました。', ephemeral: true }).catch(console.error);

      try {
        await interaction.user.send('🌟 **アンケートにご協力いただきありがとうございました！**\n頂いたご意見・ご提案は今後の改善に役立てさせていただきます！');
      } catch (e) {
        console.error('ユーザーへのDM送信失敗:', e);
      }

      try {
        const author = await client.users.fetch(AUTHOR_ID);
        const embed = new EmbedBuilder()
          .setTitle('📊 新しいアンケート回答が届きました')
          .addFields(
            { name: '回答者', value: `${userTag} (${interaction.user.id})` },
            { name: 'Q1. Botを使ってどう思いますか？', value: q1 },
            { name: 'Q2. Botで提案したいことはありますか？', value: q2 },
            { name: 'Q3. おすすめ度', value: q3 }
          )
          .setColor('#00ff99')
          .setTimestamp();

        await author.send({ embeds: [embed] });
      } catch (e) {
        console.error('作者へのDM送信失敗:', e);
      }
    }
  }
});

// -------------------------------------------------------------
// 5. 通常メッセージ処理（会話、通常チャットのhelp、画像/ファイル解析、!AIコマンド）
// -------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ★修正機能: 特定ユーザー専用の一斉お知らせ (!AI <文章>)
  if (message.content.startsWith('!AI ')) {
    // 実行者のID制限チェック (指定のID以外は弾く)
    if (message.author.id !== '1488322044335755294') {
      await message.reply('⚠️ このコマンドはBot開発者（管理者）のみ実行できます。').catch(console.error);
      return;
    }

    const announcementText = message.content.slice(4).trim();
    if (!announcementText) {
      await message.reply('お知らせの文章を入力してください！（例: `!AI 本日はメンテナンスです`）').catch(console.error);
      return;
    }

    const guilds = client.guilds.cache;
    let successCount = 0;
    let skippedCount = 0;

    for (const [guildId, guild] of guilds) {
      // 特定サーバーの送信スキップ判定
      if (guildId === EXCLUDED_GUILD_ID && !ENABLE_EXCLUDED_GUILD_ANNOUNCEMENT) {
        skippedCount++;
        continue;
      }

      try {
        let targetChannel = guild.systemChannel;

        if (!targetChannel || !targetChannel.permissionsFor(guild.members.me)?.has('SendMessages')) {
          targetChannel = guild.channels.cache.find(
            (ch) =>
              ch.type === ChannelType.GuildText &&
              ch.permissionsFor(guild.members.me)?.has('SendMessages')
          );
        }

        if (targetChannel) {
          await targetChannel.send(`# AIBOTからのお知らせ\n${announcementText}`);
          successCount++;
        }
      } catch (err) {
        console.error(`サーバー (${guild.name}) への配信失敗:`, err);
      }
    }

    let resultMsg = `📢 ${successCount}個のサーバーへお知らせを配信しました！`;
    if (skippedCount > 0) {
      resultMsg += `\n(※設定により ${skippedCount} 個のサーバーを除外しました)`;
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
    await message.reply('⏳ 現在、他の質問を処理中だよ！順番に話しかけてね。').catch(console.error);
    return;
  }

  const contextKey = message.guild ? `guild_${message.guild.id}` : `dm_${message.author.id}`;

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

    await message.channel.sendTyping().catch(() => {});

    if (!serverHistories.has(contextKey)) {
      serverHistories.set(contextKey, []);
    }
    const history = serverHistories.get(contextKey);

    const jstNow = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    let textContent = `[現在の日本時間: ${jstNow}]\n${prompt}`;

    // -------------------------------------------------------------
// ★修正箇所：添付ファイルとテキストの読み込み処理
// -------------------------------------------------------------
const userParts = [];

if (message.attachments.size > 0) {
  for (const [_, attachment] of message.attachments) {
    try {
      const response = await fetch(attachment.url);
      const mimeType = attachment.contentType || '';

      // テキスト・コード類の場合
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
      } 
      // 画像・動画・その他メディアの場合（★ここに修正が入りました）
      else {
        const arrayBuffer = await response.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString('base64');

        userParts.push({
          inlineData: {
            // 画像形式が判別できない場合のフォールバックを指定
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

// ★テキストを【配列の最後】に追加（または画像を後に配置）
userParts.push({ text: textContent });

history.push({
  role: 'user',
  parts: userParts,
});

    requestTimestamps.push(Date.now());
    updateBotStatus();

    const response = await ai.models.generateContent({
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
      history.splice(0, 2);
    }

    if (replyText.length > 1900) {
      const chunks = replyText.match(/[\s\S]{1,1900}/g) || [replyText];
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await message.reply(chunks[i]).catch(console.error);
        } else {
          await message.channel.send(chunks[i]).catch(console.error);
        }
      }
    } else {
      await message.reply(replyText).catch(console.error);
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

    if (errorStr.includes('503') || errorStr.includes('UNAVAILABLE')) {
      await message.reply(
        `⚠️ **Gemini サーバー混雑エラー (503)**\n` +
        `現在、Gemini のサーバーが混み合っています。\n` +
        `📍 **発生場所**: サーバー「**${guildName}**」 / チャンネル「**#${channelName}**」\n` +
        `少し時間をおいてから再度お試しください。`
      ).catch(console.error);
      return;
    }

    if (errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED')) {
      let retryTime = '不明（少し待ってからお試しください）';
      const retryMatch = errorStr.match(/"retryDelay"\s*:\s*"([^"]+)"/) || errorStr.match(/Please retry in ([^\s]+)/);
      if (retryMatch && retryMatch[1]) {
        retryTime = retryMatch[1];
      }

      await message.reply(
        `⚠️ **API利用制限エラー (429)**\n` +
        `無料枠のリクエスト上限（クォータ）に達しました。\n` +
        `⏱️ **再試行までの目安時間**: \`${retryTime}\` \n` +
        `指定の時間が経過してから再度お試しください。`
      ).catch(console.error);
      return;
    }

    await message.reply(`**⚠️ エラーが発生しました**\n\`\`\`js\n${errorStr.slice(0, 1800)}\n\`\`\``).catch(console.error);

  } finally {
    isProcessing = false;
  }
});

client.login(process.env.DISCORD_TOKEN);
