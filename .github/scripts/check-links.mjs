// 月次メンテナンス: 商品リンクの死活チェック
// products.json の全URLをチェックし、死んだリンクを検出してレポート

import { readFileSync, writeFileSync, appendFileSync } from 'fs';

const TIMEOUT = 15000;          // 15秒タイムアウト
const PARALLEL = 8;             // 並列リクエスト数
const USER_AGENT = 'Mozilla/5.0 (compatible; MeimeiZukan-LinkChecker/1.0)';

const data = JSON.parse(readFileSync('products.json', 'utf-8'));
const products = data.products || [];

console.log(`🔍 ${products.length}件の商品リンクをチェック中...`);

async function checkUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    // HEADがブロックされる場合があるのでGETで（bodyは読まない）
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*' }
    });
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url,
      // Amazon特有: 商品ページが削除されると検索ページにリダイレクトされる
      redirectedToSearch: res.url.includes('/s?') || res.url.includes('search')
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 並列バッチ実行
async function checkBatch(items, fn, batchSize) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    process.stdout.write(`  進捗: ${Math.min(i + batchSize, items.length)}/${items.length}\r`);
  }
  console.log('');
  return results;
}

const startTime = Date.now();
const results = await checkBatch(products, async (p) => {
  const r = await checkUrl(p.url);
  return { product: p, result: r };
}, PARALLEL);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

// 集計
const failures = [];
const warnings = [];
let okCount = 0;

for (const { product, result } of results) {
  if (!result.ok) {
    failures.push({ product, result });
  } else if (result.redirectedToSearch) {
    warnings.push({ product, result });
  } else {
    okCount++;
  }
}

const today = new Date().toISOString().slice(0, 10);

// レポート生成
let report = `**実行日時:** ${today} (JST)  \n`;
report += `**所要時間:** ${elapsed}秒  \n\n`;
report += `| 区分 | 件数 |\n|---|---|\n`;
report += `| ✅ 正常 | ${okCount} |\n`;
report += `| ⚠️ 警告（検索ページにリダイレクト） | ${warnings.length} |\n`;
report += `| ❌ エラー | ${failures.length} |\n`;
report += `| 📦 総商品数 | ${products.length} |\n\n`;

if (failures.length > 0) {
  report += `## ❌ 要対応：エラー (${failures.length}件)\n\n`;
  for (const { product: p, result: r } of failures) {
    report += `### ID:${p.id} - ${p.name}\n`;
    report += `- **カテゴリー:** ${p.category} / **ショップ:** ${p.shop}\n`;
    report += `- **エラー:** ${r.error || `HTTP ${r.status}`}\n`;
    report += `- **URL:** ${p.url}\n\n`;
  }
}

if (warnings.length > 0) {
  report += `## ⚠️ 要確認：検索ページにリダイレクト (${warnings.length}件)\n`;
  report += `（商品が削除されてAmazon検索ページに飛んでいる可能性）\n\n`;
  for (const { product: p, result: r } of warnings) {
    report += `- **ID:${p.id}** ${p.name}\n`;
    report += `  - リダイレクト先: ${r.finalUrl}\n`;
  }
  report += `\n`;
}

if (failures.length > 0 || warnings.length > 0) {
  report += `## 🤖 メンテナンス依頼方法\n\n`;
  report += `Claude Code で以下のように指示してください：\n\n`;
  report += `\`\`\`\n`;
  report += `meimei-zukan のメンテをして。最新のIssueを見て対応してください。\n`;
  report += `\`\`\`\n\n`;
  report += `Claude が自動で：\n`;
  report += `1. 問題のある商品を products.json から確認\n`;
  report += `2. ランキングサイトから代替商品を選定\n`;
  report += `3. products.json を更新\n`;
  report += `4. commit & push（GitHub Pagesへ反映）\n`;
} else {
  report += `## ✅ 全リンク正常\n\n対応不要です。`;
}

writeFileSync('maintenance-report.md', report);

console.log('\n=== 結果 ===');
console.log(`✅ 正常: ${okCount}件`);
console.log(`⚠️ 警告: ${warnings.length}件`);
console.log(`❌ エラー: ${failures.length}件`);

// GitHub Actions output
const out = process.env.GITHUB_OUTPUT;
if (out) {
  const hasFailures = failures.length > 0 || warnings.length > 0;
  appendFileSync(out, `has_failures=${hasFailures}\n`);
  appendFileSync(out, `failure_count=${failures.length}\n`);
  appendFileSync(out, `warning_count=${warnings.length}\n`);
  const titleEmoji = failures.length > 0 ? '❌' : '⚠️';
  appendFileSync(out, `issue_title=${titleEmoji} 月次メンテナンス: ${failures.length}件エラー / ${warnings.length}件警告 (${today})\n`);
}

// 失敗があっても exit 0（ワークフローを止めない）
process.exit(0);
