import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

// スラッシュコマンド定義（help コマンドを追加）
const commands = [
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Botの使い方やコマンド一覧を表示します'),
  new SlashCommandBuilder()
    .setName('bot-question')
    .setDescription('Botへの質問や提案を送信します（モーダルが開きます）'),
  new SlashCommandBuilder()
    .setName('bot-questionnaire')
    .setDescription('Botに関するアンケートに回答します（モーダルが開きます）'),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const CLIENT_ID = process.env.CLIENT_ID || '1507941181584052266';

(async () => {
  try {
    console.log('🔄 スラッシュコマンドをデプロイ（登録）中...');

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );

    console.log('✅ スラッシュコマンドのデプロイが完了しました！');
  } catch (error) {
    console.error('❌ デプロイエラー:', error);
  }
})();
