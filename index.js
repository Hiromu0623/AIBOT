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

// 処理中フラグ（連続呼び出し防止用）
let isProcessing = false;

// 共通ヘルプEmbed生成関数
function createHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('📖 AI Bot ヘルプ & 使い方ガイド')
    .setDescription('Gemini AIを搭載した高機能Botです！メンションや返信で話しかけてね。')
    .addFields(
      { name: '💬 会話する', value: 'Bot宛てにメンション（@Bot）するか、メッセージに返信（リプライ）して話しかけてください。' },
      { name: '📁 画像・ファイル解析', value: '画像、動画、テキストファイルなどを添付して話しかけると内容を読み取って回答します！' },
      { name: '🧠 記憶リセット', value: '「`リセット`」または「`forget`」と送信すると、このサーバーでの会話履歴を初期化します。' },
      { name: '❓ 質問・提案を送る', value: '「`/bot-question`」コマンドを実行すると、開発者へ質問や提案を送信できます。' },
      { name: '📝 アンケートに答える', value: '「`/bot-questionnaire`」コマンドでアンケートにご回答いただけます。' }
    )
    .setColor('#5865F2')
    .setFooter({ text: 'サーバーごとに独立した会話記憶を保持しています' });
}

// -------------------------------------------------------------
// 3. Ready イベント（ログイン & ステータス設定）
// -------------------------------------------------------------
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}!`);
  client.user.setActivity('/help で使い方を表示', { type: ActivityType.Playing });
  console.log('✅ Botが正常に起動しました！');
});

// -------------------------------------------------------------
// 4. モーダル ＆ スラッシュコマンド (Interaction) 処理
// -------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  // --- A. スラッシュコマンドの受信 ---
  if (interaction.isChatInputCommand()) {
    // /help コマンド
    if (interaction.commandName === 'help') {
      await interaction.reply({ embeds: [createHelpEmbed()] });
      return;
    }

    // /bot-question コマンド
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
      await interaction.showModal(modal);
    } 
    // /bot-questionnaire コマンド
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

      await interaction.showModal(modal);
    }
  }

  // --- B. モーダル送信の受信 ---
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_bot_question') {
      const content = interaction.fields.getTextInputValue('question_content');
      const userTag = interaction.user.tag;

      await interaction.reply({ content: '質問・提案を送信しました！ありがとうございます。', ephemeral: true });

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

      await interaction.reply({ content: 'アンケートへのご協力ありがとうございました！感謝メッセージをDMでお送りしました。', ephemeral: true });

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
// 5. 通常メッセージ処理（会話、通常チャットのhelp、画像/ファイル解析）
// -------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const prompt = message.content.replace(/<@!?\d+>/g, '').trim();

  // チャットで直接「help」や「ヘルプ」と送られてきた場合も対応
  if (prompt.toLowerCase() === 'help' || prompt === 'ヘルプ') {
    await message.reply({ embeds: [createHelpEmbed()] });
    return;
  }

  // 会話用のメンション/リプライチェック
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
    await message.reply('⏳ 現在、他の質問を処理中だよ！順番に話しかけてね。');
    return;
  }

  try {
    isProcessing = true;

    const contextKey = message.guild ? `guild_${message.guild.id}` : `dm_${message.author.id}`;

    if (prompt === 'リセット' || prompt === 'forget') {
      serverHistories.delete(contextKey);
      await message.reply('🧠 このサーバーでの会話の記憶をリセットしました！');
      return;
    }

    if (!prompt && message.attachments.size === 0) {
      await message.reply('何か質問、メッセージ、またはファイルを送信してください！');
      return;
    }

    await message.channel.sendTyping();

    if (!serverHistories.has(contextKey)) {
      serverHistories.set(contextKey, []);
    }
    const history = serverHistories.get(contextKey);

    const userParts = [];
    if (prompt) {
      userParts.push({ text: prompt });
    }

    if (message.attachments.size > 0) {
      for (const [_, attachment] of message.attachments) {
        try {
          const response = await fetch(attachment.url);
          const arrayBuffer = await response.arrayBuffer();
          const base64Data = Buffer.from(arrayBuffer).toString('base64');

          userParts.push({
            inlineData: {
              data: base64Data,
              mimeType: attachment.contentType || 'application/octet-stream',
            },
          });
        } catch (fileErr) {
          console.error('ファイル読み込みエラー:', fileErr);
        }
      }
    }

    history.push({
      role: 'user',
      parts: userParts,
    });

    // ⭕️ 修正後のコード
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: history,
    });
    const replyText = response.text;

    history.push({
      role: 'model',
      parts: [{ text: replyText }],
    });

    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, 2);
    }

    if (replyText.length > 2000) {
      await message.reply(replyText.slice(0, 1990) + '\n... (長文のため省略)');
    } else {
      await message.reply(replyText);
    }

  } catch (error) {
    console.error('API Exec Error:', error);
    const errorStr = String(error.message || error);

    const guildName = message.guild ? message.guild.name : 'ダイレクトメッセージ';
    const channelName = message.channel ? (message.channel.name || 'DM') : '不明';

    if (errorStr.includes('503') || errorStr.includes('UNAVAILABLE')) {
      await message.reply(
        `⚠️ **Gemini サーバー混雑エラー (503)**\n` +
        `現在、Gemini のサーバーが混み合っています。\n` +
        `📍 **発生場所**: サーバー「**${guildName}**」 / チャンネル「**#${channelName}**」\n` +
        `少し時間をおいてから再度お試しください。`
      );
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
      );
      return;
    }

    await message.reply(`**⚠️ エラーが発生しました**\n\`\`\`js\n${errorStr}\n\`\`\``);

  } finally {
    isProcessing = false;
  }
});

client.login(process.env.DISCORD_TOKEN);
