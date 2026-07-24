import http from 'http';
import { Client, GatewayIntentBits } from 'discord.js';
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
// 2. Gemini API & Discord Client の初期化
// -------------------------------------------------------------
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ユーザーごとの会話履歴を保存（メモリ上）
const chatHistories = new Map();
const MAX_HISTORY = 10; // 保持する会話ターン数

// 処理中フラグ（連続呼び出し防止用）
let isProcessing = false;

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}!`);
  console.log('✅ Botが正常に起動しました！（24時間稼働＆記憶機能有効）');
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // メンションまたはBotへの返信かを判定
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

  // すでに別の処理を行っている最中の場合はブロック
  if (isProcessing) {
    await message.reply('⏳ 現在、他の質問を処理中だよ！順番に話しかけてね。');
    return;
  }

  try {
    isProcessing = true; // 処理開始

    const prompt = message.content.replace(/<@!?\d+>/g, '').trim();

    // 記憶リセットコマンド
    if (prompt === 'リセット' || prompt === 'forget') {
      chatHistories.delete(message.author.id);
      await message.reply('🧠 会話の記憶をリセットしました！');
      return;
    }

    if (!prompt) {
      await message.reply('何か質問や話したいことを入力してください！');
      return;
    }

    await message.channel.sendTyping();

    // ユーザーごとの会話履歴の取得・更新
    const userId = message.author.id;
    if (!chatHistories.has(userId)) {
      chatHistories.set(userId, []);
    }
    const history = chatHistories.get(userId);

    history.push({
      role: 'user',
      parts: [{ text: prompt }],
    });

    // Gemini API 呼び出し
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: history,
    });

    const replyText = response.text;

    // 返答を履歴に追加
    history.push({
      role: 'model',
      parts: [{ text: replyText }],
    });

    // 履歴の上限オーバー分を削除
    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, 2);
    }

    // メッセージ送信
    if (replyText.length > 2000) {
      await message.reply(replyText.slice(0, 1990) + '\n... (長文のため省略)');
    } else {
      await message.reply(replyText);
    }

  } catch (error) {
    console.error('API Exec Error:', error);
    const errorStr = String(error.message || error);

    // サーバー名・チャンネル名の特定
    const guildName = message.guild ? message.guild.name : 'ダイレクトメッセージ';
    const channelName = message.channel ? (message.channel.name || 'DM') : '不明';

    // -------------------------------------------------------------
    // ⚠️ 503 (混雑エラー) の処理
    // -------------------------------------------------------------
    if (errorStr.includes('503') || errorStr.includes('UNAVAILABLE')) {
      await message.reply(
        `⚠️ **Gemini サーバー混雑エラー (503)**\n` +
        `現在、Gemini のサーバーが大変混み合っています。\n` +
        `📍 **発生場所**: サーバー「**${guildName}**」 / チャンネル「**#${channelName}**」\n` +
        `少し時間をおいてから再度お試しください。`
      );
      return;
    }

    // -------------------------------------------------------------
    // ⚠️ 429 (利用制限エラー) の処理 & retryDelay の抽出
    // -------------------------------------------------------------
    if (errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED')) {
      // エラーメッセージから "retryDelay": "◯s" や retryIn の値を正規表現で抽出
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

    // -------------------------------------------------------------
    // その他の予期せぬエラー
    // -------------------------------------------------------------
    await message.reply(`**⚠️ エラーが発生しました**\n\`\`\`js\n${errorStr}\n\`\`\``);

  } finally {
    isProcessing = false; // 処理終了（フラグ解除）
  }
});

client.login(process.env.DISCORD_TOKEN);
