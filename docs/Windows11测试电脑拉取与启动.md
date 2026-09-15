# Windows 11 本地启动与测试

## 环境

- Node.js 22 或项目当前兼容版本
- Git
- 可以访问 npm 与 Cloudflare 的网络

## 首次启动

```powershell
git clone https://github.com/object-tao/International-TMS.git
cd International-TMS
npm install
npm run db:migrate:local
npm run dev:win
```

后台地址：`http://127.0.0.1:5188/admin/orders`

客户门户：`http://127.0.0.1:5188/portal/login`

仓库作业端：`http://127.0.0.1:5188/warehouse/login`

## 日常开发前

```powershell
git status
npm install
npm run dev:win
```

`dev` 与 `dev:win` 会在启动服务前自动检查并应用本地数据库迁移。即使遗漏手动迁移，也不会让新版代码连接旧表结构后直接崩溃。

## 部署顺序保护

必须使用 `npm run deploy` 部署。该命令会先应用远程数据库迁移，迁移成功后才构建并发布代码；不要直接运行 `wrangler deploy` 跳过数据库升级。

## 提交前检查

```powershell
npm run ci
git status
```

本地数据库位于 `.wrangler/state`，不提交到 Git。开发批次应分别提交，便于使用 `git log` 查找并回滚。
