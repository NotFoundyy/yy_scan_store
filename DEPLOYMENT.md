# Store Scan 私用部署

## 1. 领取和购买阿里云 ECS

1. 登录阿里云并完成实名认证、学生认证。
2. 在学生权益中心领取优惠，进入 ECS 下单页。
3. 优先检查地域是否有“中国香港”，并在最终订单页确认优惠可以抵扣。
4. 推荐 Ubuntu 24.04、1 核 2GB 或以上、40GB 系统盘。
5. 香港实例建议绑定域名；大陆实例不备案时使用 Tailscale 私网访问。
6. 安全组只开放 SSH。香港域名 HTTPS 方案额外开放 `80` 和 `443`。

## 2. 初始化服务器

使用 SSH 密钥登录后执行：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

退出 SSH 并重新登录，然后部署代码：

```bash
sudo mkdir -p /opt/store-scan
sudo chown "$USER":"$USER" /opt/store-scan
git clone <你的代码仓库地址> /opt/store-scan
cd /opt/store-scan
cp .env.server.example .env
```

编辑 `.env`，为 `POSTGRES_PASSWORD` 和 `JWT_SECRET` 填写随机长密码。

可用以下命令生成随机值：

```bash
openssl rand -base64 48
```

## 3A. 香港 ECS + HTTPS

1. 将域名的 `A` 记录解析到 ECS 公网 IP。
2. 将 `.env` 中的 `API_DOMAIN` 改为实际域名，例如 `api.example.com`。
3. 在阿里云安全组开放 TCP `80` 和 `443`。
4. 启动服务：

```bash
cd /opt/store-scan
docker compose up -d --build
docker compose logs -f api caddy
```

验证：

```bash
curl https://api.example.com/health
```

应返回 `{"ok":true}`。

## 3B. 大陆 ECS + Tailscale

大陆 ECS 不备案时，不通过公网域名提供 API。服务器和每台手机都安装 Tailscale，并加入同一个私有网络。

服务器执行：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

将 `.env` 中 `API_DOMAIN` 设置为 `:80`，启动服务：

```bash
docker compose up -d --build
```

手机使用服务器 Tailscale IP，例如 `http://100.x.x.x`。Tailscale 隧道本身加密，不要将 API 的 `3000` 端口开放到公网安全组。

当前 Android 工程允许明文 HTTP，仅用于 Tailscale 私网方案。香港 ECS 公网部署必须使用 HTTPS。

## 4. 构建 APK

在开发电脑创建 `.env.local`：

```env
VITE_API_BASE_URL=https://api.example.com
```

Tailscale 方案则填写服务器的 Tailscale 地址：

```env
VITE_API_BASE_URL=http://100.x.x.x
```

构建并同步 Android 工程：

```powershell
npm install
npm run build
npx cap sync android
```

之后使用 Android Studio 构建 APK，并私下分发给使用者。

## 5. 备份和更新

安装每日备份任务：

```bash
chmod +x /opt/store-scan/deploy/backup.sh
crontab -e
```

加入：

```cron
0 3 * * * /opt/store-scan/deploy/backup.sh
```

每周将 `/opt/store-scan/backups` 下载到本地电脑。更新服务：

```bash
cd /opt/store-scan
git pull
docker compose up -d --build
```

## 6. 当前限制

- 已完成在线账号、箱子、物品、出入库、旧数据上传和匿名二维码只读查看。
- 箱子、物品和出入库支持离线排队重放；服务器拒绝的操作会记录为冲突。当前仅显示冲突数量，尚未提供图形化冲突处理页面。
- 图片当前仍以 Data URL 存入数据库，适合少量私用；图片较多后应迁移到对象存储或服务器文件目录。
- 永久二维码无法撤销。二维码泄露后，只有删除箱子才能停止访问。
