import { mkdir, copyFile, readdir } from 'node:fs/promises';

const files = ['index.html', 'styles.css', 'app.js', 'ai.js', 'session.js'];
const target = new URL('./.build/assets/', import.meta.url);
await mkdir(target, { recursive: true });
const existing = await readdir(target);
if (existing.some(file => !files.includes(file))) throw new Error('公開資産ディレクトリに未承認のファイルがあります');
for (const file of files) await copyFile(new URL(file, import.meta.url), new URL(file, target));
console.log(`公開する Web 資産：${files.join(', ')}。企業データは含みません。`);
