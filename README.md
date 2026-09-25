# Rigël Theatre 粉丝站（站名待定）

设计文档：https://claude.ai/code/artifact/5ee23162-4144-4a62-9504-ab7e28d2607d

线上预览（Cloudflare Access 保护，只有管理组能进）：https://rigel-archive.shionchoy.workers.dev/admin
整理工作都在线上进行。上传后的核对与解包、推流版与预览、声学指纹，都由 Cloudflare 容器里的
处理程序自动完成（每晚的加密备份也由它做，但 B2 尚未开通，见「加密备份」），本机不需要常驻任何程序；
本机只在导入新的合辑文件时用 `ra push` 把原件传上去。
后台有中文与日文界面（左下角切换，或在「管理组」页给每位成员设定）。

| 目录 | 内容 |
| --- | --- |
| `site/` | 网站与管理后台：Astro 7 + Cloudflare Workers，D1 数据库，R2 存储 |
| `tools/ra/` | 导入工具与处理程序 `ra`（Python，用 uv 管理）：扫描、解包、读规格、归类建议、种子数据、上传到云端、处理队列、推流版、声学指纹、备份；`Dockerfile` 是云端容器的镜像 |
| `tools/ra/cloud.env` | 连接线上站点的地址与密钥（服务令牌、处理程序令牌）；只在本机，不进 git |
| `tools/ra/backup.env` | B2 密钥与备份加密口令；只在本机，不进 git，**另存一份到密码管理器** |
| `data/seed/catalog.yaml` | 初始作品目录（53 个作品与各自 7 个版本栏位的状态）；导入后以数据库为准 |

原件工作区在 `D:\documents\projects\rigel-archive`（WSL 下为 `/mnt/d/documents/projects/rigel-archive`）：

| 目录 | 内容 |
| --- | --- |
| `source/Rigel Theatre合辑` | 合辑原件，所有工具只读不写 |
| `extracted/<SHA-256 前 16 位>/` | `ra extract` 解开的压缩包与光盘镜像，按包的内容命名，相同的包只解一次 |
| `manifest/scan.jsonl` | `ra scan`：每个文件的大小、修改时间、SHA-256 |
| `manifest/archives/<SHA-256>.json` | `ra extract`：每个包的格式、文件名编码、状态和包内文件清单（含 SHA-256） |
| `manifest/probe.jsonl` | `ra probe`：音频、视频、图片的规格、内嵌标签与 PCM MD5 |
| `manifest/push-state.json` | `ra push`：大文件分块上传的进度，中断后从这里接着传 |
| `manifest/push.log` | `ra push` 的运行记录 |
| `tmp/` | `ra worker` 下载与解包用的临时目录，处理完即删 |
| `backups/` | `npm run db:backup` 导出的线上数据库 |

2026-09-24 起本机的 `source/` 与 `extracted/` 已清空：原件在 R2 和 NAS 上（B2 备份开通后另有一份）。以后导入新的合辑文件时，
先放回 `source/` 再走导入流程，传完即可再删。

## 线上（Cloudflare）

| 资源 | 名称 |
| --- | --- |
| Worker | `rigel-archive`（workers.dev，版本预览网址已关闭） |
| D1 | `rigel-archive`（APAC），迁移在 `site/migrations/` |
| R2 | `rigel-archive-media`（APAC）：原件 `blobs/<SHA-256>`，推流版与预览 `derived/…` |
| 容器 | `rigel-archive-processor`（standard-4：4 vCPU、12 GiB、20 GB 磁盘，最多 1 个实例），由 Durable Object `Processor` 启停 |
| 定时任务 | 每 10 分钟：有待处理的工作就唤醒容器；每天 19:17 UTC（日本 4:17）：备份（设置好 B2 后才运行，现在跳过） |
| Access | 团队 `rigel-archive.cloudflareaccess.com`；Worker 级保护；服务令牌 `ra-worker` 走 Service Auth 策略 |
| 密钥 | `WORKER_TOKEN`（`wrangler secret put`），与 `cloud.env` 里的 `RA_WORKER_TOKEN` 相同；备份用的 5 个见下文「加密备份」 |

```sh
cd site
npm run deploy              # 类型检查 + 日文检查 + 构建 + 部署（本机 Docker 构建容器镜像并推送）
npm run db:migrate:remote   # 有新迁移时先执行
npm run db:backup           # 把线上数据库导出到工作区 backups/（D1 另有 30 天时间点恢复）

cd ../tools/ra
uv run ra push              # 把本机原件传到 R2（第三方文件也存，只有已忽略的不传）；中断后重跑会接着传
uv run ra push --dry-run    # 只看还差多少
uv run ra worker --once     # 平时不需要：云端容器会做。容器出问题时可在本机代替它处理队列
uv run ra processor         # 云端容器的状态与各队列数量；wake 立即处理，restart 重启（部署新版本后用），backup 立即备份
```

`ra push`、`ra worker` 等默认连 `cloud.env` 里的 `RA_SITE`；加 `--site http://localhost:4321` 改连本地开发站。
导入新的合辑文件：`ra scan` → `ra extract` → `ra probe` → `ra seed` → `npm run db:seed:remote` → `ra push`。
`db:seed:remote` 与本地一样可以重复执行，不会覆盖人工整理的内容。

管理组：两道检查——Access 策略里的邮箱能打开登录页，`/admin/team` 名单里的邮箱才能进后台。
加人时两边都加（组员没有 Cloudflare 账号时，在 Zero Trust 的 Login methods 里启用 One-time PIN）。
角色：站长（全部）、管理员（全部 + 管理成员与清理存储）、整理员（整理、上传、编辑、撤销）。

## 本地开发

```sh
cd tools/ra
uv run ra scan          # 扫描原件：大小、修改时间、SHA-256（增量，只重算有变化的文件）
uv run ra extract       # 解开压缩包与 ISO（增量；--retry 重试失败的包）
uv run ra probe         # 读取音视频与图片规格、PCM MD5（增量）
uv run ra report        # 查看归类规则覆盖了多少文件
uv run ra seed          # 生成 site/.seed/seed.sql（作品目录 + 文件 + 包内文件 + 归类建议）
uv run ra serve         # 只读文件服务 127.0.0.1:4322，供后台预览，另开终端常驻
uv run ra worker --site http://localhost:4321   # 处理本地站点的上传

cd ../../site
npm install
npm run db:reset        # 清空本地 D1，执行迁移并导入种子数据（整理结果也会清掉；之后要重启 npm run dev）
npm run db:seed         # 或：只导入新文件、刷新机器读取的字段，不动已做的整理
npm run dev             # http://localhost:4321/admin
```

`db:seed` 可以重复执行：新文件插入，已有文件只刷新大小、SHA-256、规格、PCM MD5 和脚本建议，
权属、状态、作品、栏位、备注等人工整理的内容不会被覆盖。

解压用 7-Zip。Debian 的 7-Zip 没有 RAR 解码器，遇到解不开的 RAR 会自动改用 Windows 上的 Bandizip
（需要已安装）；两种方式解出的每个文件都会与包内记录的 CRC32 核对。
RK 自解压包（2002 年前后的 BMS 包）7-Zip 和 Bandizip 都打不开，按设计不运行程序，只保留原件。

本地开发时后台不需要登录；部署后 `/admin` 由 Cloudflare Access 保护，并且只允许 `admins` 表里的邮箱。
没有设置 `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` 时，线上后台对所有人返回 403。
本地的 D1 与 R2 按 `wrangler.jsonc` 里的数据库 ID 存放；ID 改变后要 `npm run db:reset`。
归类规则在 `tools/ra/rules/mapping.yaml`，按顺序匹配，第一条命中的规则生效；建议只是提议，要在整理台确认。

## 在云端开发（全新检出）

仓库里只有代码：密钥（`cloud.env`、`backup.env`、`site/.dev.vars`）、原件工作区和线上数据都不在仓库里，也不要放进来。
在 Claude Code 网页版等云端环境，或任何全新检出里：

```sh
cd site && npm ci                             # 同时生成 worker-configuration.d.ts
cp .dev.vars.example .dev.vars                # WORKER_TOKEN 填一个随机字符串
cd ../tools/ra && uv sync && uv run ra seed   # 没有原件工作区时只导入作品目录（53 个作品，没有文件）
cd ../../site && npm run db:reset && npm run dev
```

- 没有 Docker 时 `npm run dev` 自动不启动处理容器，并提示改用 `uv run ra worker --site http://localhost:4321`
  处理上传（见 `site/astro.config.mjs`）。
- 检查与测试照常：`npx astro check`、`npm run check:i18n`、`cd tools/ra && uv run pytest`（缺 ffmpeg、metaflac、
  rclone 的测试自动跳过）。
- 部署要 Cloudflare API 令牌（环境变量 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）和 Docker（构建处理容器的镜像）。
  没有 Docker 的环境只改代码、跑测试，部署回本机做。

## 处理程序（云端容器）

`src/processor.ts` 里的 Durable Object 管理一个 Cloudflare 容器，容器里运行 `ra container`（镜像由
`tools/ra/Dockerfile` 构建：Python + ffmpeg + flac + 7-Zip（含 RAR 解码）+ rclone）。

- **何时运行**：上传登记后立即唤醒；另外每 10 分钟检查一次有没有待处理的工作；做完后空闲 10 分钟自动停下
  （长任务如视频转码、首次备份期间不会被停下）。停着的时候不收费。
- **怎样连网站**：容器访问 `http://site.internal/admin/api/worker/*`，这些请求不出 Cloudflare，由 Worker 直接交给
  网站自己的接口并补上 `WORKER_TOKEN`，所以容器里没有网站的密钥，也不经过 Access。
- **队列**：数据库表 `media_tasks`。每份内容开工前先「认领」，失败隔一小时重试，三次后放弃（`/admin/storage`
  可一键重试）。所以容器与本机 `ra worker` 同时运行也不会重复处理。中途中断满三次（例如转码时连续遇到部署）
  的任务每 10 分钟由定时任务标为失败，出现在失败列表里。
- **视频单独排队**：容器里视频一次一个、在自己的线程里转码（直播录像要一两个小时），音频、图片和新上传照常处理，
  不必等它；视频的指纹也由这条线用同一份下载来算。`/admin/storage` 的状态栏显示正在转码的视频。
- **状态**：`/admin/storage`（存储与处理）显示容器状态、各队列数量、失败项；文件页显示该文件的推流版、指纹与同一录音。
- **部署**：`npm run deploy` 会滚动替换正在运行的容器，进行中的任务（例如长视频转码）会在 20 分钟后重新开始；
  有长任务在跑时，最好等它完成再部署（`uv run ra processor` 可看当前任务）。
- **本机调试**：`npm run dev` 时，本机 Docker 会自动构建并运行同一个容器（`wrangler.jsonc` 的 containers 配置），
  出站拦截也与线上一致。

### 推流版与预览（`ra derive`）

处理程序从原件生成，存在 R2 的 `derived/` 下；原件不变，下载的始终是原件。规则版本号在
`tools/ra/src/ra/derive.py` 与 `site/src/lib/processing.ts` 两处（测试会比对），提高版本号会让全部文件重新生成。

| 原件 | 生成 |
| --- | --- |
| 无损音频（WAV、FLAC、AIFF 等） | 推流 FLAC（与原件逐采样一致：生成后核对 PCM MD5；每 10 秒一个定位点；去掉内嵌图片以加快起播）、AAC 256 kbps、波形；自带定位表的 FLAC 原件直接用原件推流 |
| 有损音频 | MP3、AAC 直接用原件推流；Vorbis、TwinVQ（VQF）、WMA 等另转 AAC；波形 |
| 图片 | WebP 240 / 640 / 1600 px（不放大原图） |
| 视频 | MP4（H.264 + AAC，最高 1080p）：已是浏览器能播的 H.264 就只换封装，否则转码；封面帧 WebP |

解码后音频相同的文件（如 WAV 与 FLAC）共用一套推流文件。短于 30 秒且没有归入作品的音频（多为 BMS 键音）不生成。
后台的播放器按浏览器支持依次选推流 FLAC → AAC → 原件；在 Chrome、Firefox、WebKit（Safari 的内核）里测试过播放与拖动进度。

### 声学指纹（`ra fingerprint`）

用 Chromaprint（ffmpeg 自带，与 fpcalc 相同算法）给每个音频（和视频的音轨）算整首的指纹，再两两比对：
先按指纹值的高、低 16 位建索引，投票找出在同一时间偏移上有大量相同值的候选，再逐秒比较相同位数的比例，
取连续匹配的片段。能找出不同编码或母带的同一录音、剪辑版，以及整张抓轨、合辑、游戏原声、PV 里的一段。
结果存在 `acoustic_matches`，用于：单曲页的合并候选与「还没挂到曲目的同一录音」、作品页的「自动对应」、
文件页的「同一录音」、整理台的「同一录音」筛选（可只看与社团自有文件是同一录音的第三方文件）。

```sh
uv run ra fingerprint --match-only   # 调整比对参数后，用已有指纹重新比对全部文件（约 2 分钟）
```

判定规则（`tools/ra/src/ra/fingerprint.py`，2026-09-24 按全部 1,771 个指纹的结果逐类核对后定下）：连续一致 30 秒以上，
或覆盖短文件一半以上且一致度 ≥ 0.85。一致度低于 0.8 的配对要人看一眼：节奏与和声相近的舞曲之间偶尔也会一致 30 秒以上。

### 加密备份（`ra backup`）

**现状（2026-09-24）：代码与容器已就绪，B2 尚未开通**，定时任务每晚跳过。开通前数据库只有 Cloudflare 这一份
（D1 的 30 天时间点恢复也在同一账号里），请不时运行 `npm run db:backup` 导出到本机工作区。
开通时顺带要做：只为备份唤醒的容器，备份完且队列为空就立即停下，不再空等 10 分钟（12 GiB 内存按运行时间计费，
每晚空等约合 $0.5/月）。费用估算：B2 存储约 $0.57/月（90.5 GB 原件，$6.95/TB/月，前 10 GB 免费；读写与恢复下载免费）。

每晚把全部原件（`blobs/`）和数据库的 SQL 导出备份到 Backblaze B2。用 rclone 的 crypt：文件名和内容在
上传前加密，B2 上只有密文。原件只增不删（网站上清理掉的内容在备份里仍然保留）；每次结束时从 B2
随机读回 3 个原件核对 SHA-256。结果显示在 `/admin/storage`，也可以在那里「立即备份」。

设置（一次）：

1. 在 Backblaze 建私有存储桶和只能访问该桶的 Application Key，填进 `tools/ra/backup.env`
   （`B2_KEY_ID`、`B2_APP_KEY`、`B2_BUCKET`；加密口令 `BACKUP_CRYPT_PASSWORD`、`BACKUP_CRYPT_SALT` 已生成好）。
2. `cd site && npm run secrets:backup`：把这 5 项设为 Worker 的密钥（不会显示在屏幕上）。
3. **把 `backup.env` 整个存进密码管理器**：两个加密口令丢失后，备份无法解密。

恢复（需要 rclone 和 `backup.env`）：

```sh
set -a; . tools/ra/backup.env; set +a
export RCLONE_CONFIG_B2_TYPE=b2 RCLONE_CONFIG_B2_ACCOUNT="$B2_KEY_ID" RCLONE_CONFIG_B2_KEY="$B2_APP_KEY"
export RCLONE_CONFIG_VAULT_TYPE=crypt RCLONE_CONFIG_VAULT_REMOTE="b2:$B2_BUCKET/rigel-archive"
export RCLONE_CONFIG_VAULT_PASSWORD="$(rclone obscure "$BACKUP_CRYPT_PASSWORD")"
export RCLONE_CONFIG_VAULT_PASSWORD2="$(rclone obscure "$BACKUP_CRYPT_SALT")"
rclone ls vault:db                        # 数据库导出，按日期
rclone copy vault:db/2026/<某天>.sql.gz .   # 取回一份导出
gunzip <某天>.sql.gz && npx wrangler d1 execute <新数据库> --remote --file <某天>.sql
rclone copy vault:blobs ./blobs           # 取回全部原件（文件名就是 SHA-256，可逐个核对）
```

## 界面语言

后台文字在代码里写中文，日文在 `site/src/lib/i18n-ja.ts`；`npm run check:i18n`（部署时自动执行）列出还没有日文的文字，
缺一条部署就不会继续。每位成员的语言存在 `admins.lang`（空 = 跟随浏览器），左下角按钮随时切换。
修改记录的摘要按「文字 + 参数」保存，所以中日两种界面都能读到各自语言的记录。

## 上传、删除与存储

- **上传**（`/admin/upload`）：浏览器先算 SHA-256，存储里已有相同内容就不重复传；50 MB 以上分块上传。
  文件进入整理台的「后台上传/日期 时间/…」目录。一次上传是一条修改记录，可以整批撤销。
- **处理**：处理程序（云端容器）取新上传的内容，下载后核对 SHA-256（分块上传只能事后核对），读取规格；
  压缩包（zip、rar、7z、lzh、iso，及 7-Zip 能打开的自解压包）用与 `ra extract` 相同的代码解开，
  包内文件存入 R2、加入整理台（在包的目录下，与上传同属一条修改记录，撤销上传会一并撤销），
  随后生成推流版与预览、算声学指纹。容器里的 7-Zip 带 RAR 解码器，RAR 包也能在云端解开。进度见 `/admin/storage`。
- **断点续传**：浏览器记得已传的分块，失败或刷新后重新选择同一文件会接着传。
- **上传新版本**：文件页「上传新版本」，新文件接替旧文件的作品、栏位、曲目与权属，旧文件留作旧版本。
- **删除**：只删记录，source 里的原件从不改动。后台上传的文件随时可删；合辑文件只有在最近一次导入
  （`ra seed`）时原件已不在 source 里才能删，否则只能「忽略」。已发布的文件要先改状态。压缩包连同包内文件一起删。
  删除可在修改记录里撤销。
- **存储清理**（`/admin/storage`）：没有任何文件引用的内容保留 `STORAGE_GRACE_DAYS`（默认 30）天后才能清理；
  清理后，对应的删除不能再撤销；由它生成的推流版、预览与指纹一并删除（备份里的原件仍保留）。

本地的存储是模拟的（`site/.wrangler/state/v3/r2`，在 WSL 磁盘上），`db:reset` 不会清空它。

## 作品、曲目与单曲

- **作品页**：版本栏位、曲目表（拖动排序；可从某个栏位的音频文件一键生成；「自动对应」先按同一音频或同一录音、
  再按曲号与标题把文件对应到曲目）、
  文件与曲目的对应、封面、中日英译名与介绍；「预览公开页」按公开页的样子列出栏位占位、曲目与播放器。
- **单曲**（`/admin/songs`）：同一首曲在不同作品里的版本合并为一个单曲；候选来自同名（忽略全半角、大小写、
  标点和括号里的版本说明）、解码后音频相同（PCM MD5）与声学指纹判断的同一录音。
- 文件归入「缺档」或「待确认」的栏位时，该栏位自动改为「已收录」（同一条修改记录）。

## 测试

```sh
cd tools/ra && uv run pytest        # 需要 metaflac、rclone 的几项在本机跳过；完整跑一遍用容器镜像：
docker build -t ra-processor tools/ra
docker run --rm -v "$PWD:/repo:ro" -w /repo/tools/ra -e UV_PROJECT_ENVIRONMENT=/tmp/venv -e UV_CACHE_DIR=/tmp/uv \
  --entrypoint sh ra-processor -c 'uv sync -q --frozen && uv run -q --no-sync pytest -q -p no:cacheprovider'
cd site && npx astro check && npm run check:i18n
```
