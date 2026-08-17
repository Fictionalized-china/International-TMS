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
npm run db:migrate:local
npm run dev:win
```

## 提交前检查

```powershell
npm run ci
git status
```

本地数据库位于 `.wrangler/state`，不提交到 Git。开发批次应分别提交，便于使用 `git log` 查找并回滚。
