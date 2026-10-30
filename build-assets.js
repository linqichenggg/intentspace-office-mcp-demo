import { mkdir, copyFile, readdir } from 'node:fs/promises';

const files = ['index.html', 'styles.css', 'app.js', 'ai.js', 'session.js', 'office.html', 'office.css', 'office.js', 'ui-i18n.js', 'office-layout.js', 'calendar-ui.js', 'equipment-feedback-ui.js'];
const target = new URL('./.build/assets/', import.meta.url);
await mkdir(target, { recursive: true });
const existing = await readdir(target);
if (existing.some(file => !files.includes(file))) throw new Error('公開資産ディレクトリに未承認のファイルがあります');
for (const file of files) await copyFile(new URL(file, import.meta.url), new URL(file, target));
console.log(`公開する Web 資産：${files.join(', ')}。TSG配置の派生モデルを含みます。企業CSV・原図画像は含みません。`);
