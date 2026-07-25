import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

// -------------------------------------------------------------
// スラッシュコマンド定義
// -------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('bot-question')
    .setDescription('Botへの質問や提案を送信します（モーダルが開きます）'),
  new SlashCommandBuilder()
    .setName('bot-questionnaire')
    .setDescription('Botに関するアンケートに回答します（モーダルが開きます）'),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 スラッシュコマンドをデプロイ（登録）中...');

    // BOTのアプリケーションID（クライアントID）をトークンから自動推測して登録
    // ※Discord.js v14 では CLIENT_ID なしでも Routes.applicationCommands に登録可能です
    // もし CLIENT_ID を .env に設定している場合は process.env.CLIENT_ID を使えます
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID || '1488322044335755294'), 
      { body: commands }
    );

    console.log('✅ スラッシュコマンドのデプロイが完了しました！');
  } catch (error) {
    console.error('❌ デプロイエラー:', error);
  }
})();
