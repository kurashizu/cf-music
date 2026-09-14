import { defineConfig } from 'drizzle-kit';

// 只用 drizzle-kit 在本地生成 SQL migration 文件（不连接远程 D1）。
// 应用到实际数据库统一走 `wrangler d1 execute`（复用 wrangler 的 OAuth 登录会话），
// 不需要额外申请 Cloudflare API Token。
export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './migrations',
	dialect: 'sqlite',
	verbose: true,
	strict: true
});
