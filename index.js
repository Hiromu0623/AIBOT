import http from 'http';
import { Client, GatewayIntentBits } from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

// Renderのスリープ回避用サーバー
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive!');
}).listen(PORT, () => {
  console.log(`🌐 HTTP Server running on port ${PORT}`);
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const chatHistories = new Map();
const MAX_HISTORY = 10;

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}!`);
  console.log('✅ Botが正常に起動しました！');
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

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

  try {
    const prompt = message.content.replace(/<@!?\d+>/g, '').trim();

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

    const userId = message.author.id;
    if (!chatHistories.has(userId)) {
      chatHistories.set(userId, []);
    }
    const history = chatHistories.get(userId);

    history.push({
      role: 'user',
      parts: [{ text: prompt }],
    });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
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
    const errorName = error.name || 'Error';
    const errorMessage = error.message || String(error);
    await message.reply(`**⚠️ エラーが発生しました**\n\`\`\`js\n${errorName}: ${errorMessage}\n\`\`\``);
  }
});

client.login(process.env.DISCORD_TOKEN);