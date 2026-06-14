# Store Scan 开发说明

## 1. 项目定位

这是一个个人使用的离线仓库/箱子管理工具。应用主要运行在安卓手机上，不上架应用商店，不依赖公网服务器，不做多人账号体系。

开发方式：

- 在电脑上开发前端应用。
- 使用 Capacitor 打包为安卓 APK。
- APK 手动安装到自己的安卓手机。
- 仓库现场使用手机完成扫码、查看、入库、出库、导出。

第一版优先目标是“稳定可用”，不是复杂的企业仓储系统。

## 2. 技术路线

推荐技术栈：

- React
- Vite
- TypeScript
- Capacitor
- IndexedDB
- SheetJS/xlsx
- QRCode 生成库
- Capacitor Camera 或扫码插件

第一版数据存储使用 IndexedDB。原因是配置简单、前端内可直接使用、适合快速做出 APK。后续如果数据量变大或需要更强一致性，可以迁移到 SQLite。

建议依赖：

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npm install idb xlsx qrcode
```

扫码依赖后续根据兼容性选择，候选：

```bash
npm install @capacitor-mlkit/barcode-scanning
```

或使用浏览器侧扫码库作为备选。

## 3. 运行形态

应用不使用网址二维码。二维码内容只保存箱子/仓库唯一 ID。

示例：

```text
BOX-20260612-0001
```

扫码后，App 根据这个 ID 在本机数据库中查找对应箱子/仓库。

这种方式的优点：

- 不需要服务器。
- 不需要备案。
- 没有网络也能用。
- 二维码长期有效，只要本地数据还在。

注意：

- 如果换手机，需要先从旧手机导出备份，再在新手机导入。
- 如果清除 App 数据，本地数据会丢失，所以必须提供备份/恢复功能。

## 4. 第一版功能范围

MVP 必须包含：

- 箱子/仓库列表
- 创建箱子/仓库
- 编辑箱子/仓库名称、备注
- 删除箱子/仓库
- 箱子/仓库详情
- 添加物品
- 编辑物品名称、数量、单位、备注
- 入库
- 出库
- 查看出入库记录
- 生成箱子/仓库二维码
- 保存或分享二维码图片，便于打印
- App 内扫码查找箱子/仓库
- 导出 Excel
- 导出数据备份 JSON
- 导入数据备份 JSON

第一版暂不做：

- 多人协作
- 登录注册
- 云同步
- 权限管理
- 复杂审批
- 采购单/销售单
- 条码商品库
- 后台管理系统

## 5. 页面结构

建议页面：

```text
/                  首页/箱子列表
/box/new           新建箱子
/box/:id           箱子详情
/box/:id/qr        箱子二维码
/scan              扫码
/export            导出 Excel
/backup            备份与恢复
/settings          设置
```

如果使用 Hash Router，路由可以是：

```text
#/
#/box/new
#/box/:id
#/box/:id/qr
#/scan
#/export
#/backup
#/settings
```

Capacitor APK 中使用 Hash Router 更稳，不容易遇到刷新路径问题。

## 6. 核心数据模型

### Box

箱子/仓库。

```ts
type Box = {
  id: string;
  name: string;
  code: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
};
```

字段说明：

- `id`: 内部唯一 ID，可以使用 `crypto.randomUUID()`。
- `code`: 打印到二维码里的可读唯一编码，例如 `BOX-20260612-0001`。
- `name`: 用户自定义名称，例如“3号货架 A 箱”。
- `archived`: 软删除/归档标记，避免误删。

### Item

物品。

```ts
type Item = {
  id: string;
  boxId: string;
  name: string;
  specModel?: string;
  quantity: number;
  unit?: string;
  imageDataUrl?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
};
```

字段说明：

- `boxId`: 所属箱子/仓库 ID。
- `name`: 物品类型，例如“防尘罩”“玻璃纤维绳”。
- `specModel`: 规格型号，例如“10米”“320g”“15L”。
- `quantity`: 当前库存数量。
- `unit`: 单位，例如“个”“箱”“包”“米”。
- `imageDataUrl`: 物品卡片显示图片，来自添加物品或最近一次带照片的入库记录。

### StockMovement

库存流水。

```ts
type StockMovement = {
  id: string;
  boxId: string;
  itemId: string;
  type: 'in' | 'out' | 'adjust';
  quantity: number;
  beforeQuantity: number;
  afterQuantity: number;
  teamName?: string;
  imageDataUrl?: string;
  note?: string;
  createdAt: string;
};
```

字段说明：

- `in`: 入库。
- `out`: 出库。
- `adjust`: 手动调整库存。
- `teamName`: 出库时的领取班组。
- `imageDataUrl`: 入库/出库拍照或上传图片留存。
- 每次库存变更都写入流水，方便追溯。

## 7. IndexedDB 设计

数据库名：

```text
store-scan-db
```

对象仓库：

```text
boxes
items
movements
meta
```

索引建议：

```text
boxes.code
items.boxId
movements.boxId
movements.itemId
movements.createdAt
```

建议封装一个数据访问层：

```text
src/lib/db.ts
src/lib/boxRepository.ts
src/lib/itemRepository.ts
src/lib/movementRepository.ts
```

业务层不要直接散落 IndexedDB 操作，避免后续迁移 SQLite 时改动过大。

## 8. 主要业务规则

### 创建箱子/仓库

1. 用户输入名称和备注。
2. 系统生成 `id`。
3. 系统生成 `code`。
4. 写入 `boxes`。
5. 跳转到箱子详情页。

`code` 格式建议：

```text
BOX-yyyyMMdd-四位序号
```

示例：

```text
BOX-20260612-0001
```

### 添加物品

1. 在箱子详情页点击添加物品。
2. 输入物品类型、规格型号、入库数量、入库时间、单位、备注，可拍照或上传图片。
3. 创建 `Item`。
4. 如果初始数量大于 0，同时创建一条 `in` 类型流水。

### 入库

1. 选择物品。
2. 输入入库数量、入库时间、备注，可拍照或上传图片。
3. 数量必须大于 0。
4. 更新物品当前数量。
5. 创建 `StockMovement`。

### 出库

1. 选择物品。
2. 输入领取班组、领取时间、出库数量、备注，可拍照或上传图片留存。
3. 数量必须大于 0。
4. 出库后库存不能小于 0。
5. 更新物品当前数量。
6. 创建 `StockMovement`。

### 扫码

1. App 打开扫码页面。
2. 读取二维码内容。
3. 按 `Box.code` 查找箱子。
4. 找到后进入箱子详情页。
5. 未找到时提示“本机没有找到该箱子，请确认是否导入过备份”。

### 删除

第一版建议默认软删除：

- 箱子删除：设置 `archived = true`。
- 物品删除：可以物理删除，但更建议先做软删除。

为简单起见，第一版可以只对箱子做归档，物品允许删除。

## 9. Excel 导出

Excel 导出以“箱子/仓库”为核心，不默认把所有数据混在一个 Sheet 中。

导出入口应支持：

- 导出当前箱子/仓库。
- 选择多个箱子/仓库导出。
- 全选所有箱子/仓库导出。
- 导出前自定义 Excel 文件名。

默认导出文件名：

```text
store-scan-export-yyyyMMdd-HHmm.xlsx
```

用户可在导出前修改文件名。文件名输入框默认填入上面的默认名称，但允许改成例如：

```text
3号货架库存-20260612.xlsx
维修工具箱盘点.xlsx
```

文件名规则：

- 自动补全 `.xlsx` 后缀。
- 去掉文件名中不适合作为文件名的字符。
- 如果用户留空，则使用默认文件名。

### 单个箱子/仓库导出

当只选择一个箱子/仓库时，Excel 建议包含以下 Sheet：

- `物品库存`
- `出入库记录`
- `箱子信息`

### 多个箱子/仓库导出

当选择多个箱子/仓库或全选导出时，每个箱子/仓库单独一个 Sheet。

Sheet 命名规则：

```text
箱子名称
```

如果名称过长或重复，则自动处理为：

```text
箱子名称-0001
箱子名称-0002
```

Excel Sheet 名称需要限制长度，并去掉 Excel 不支持的字符。

每个箱子 Sheet 内包含该箱子的物品库存。为了阅读方便，每个 Sheet 顶部先放箱子信息，再放物品列表。

每个箱子 Sheet 应参考纸质表格结构：

```text
箱子名称物品出入库明细表

序号
物品类型
规格型号
入库数量
入库时间
领取班组
领取时间
出库数量
库存结余
备注

负责人
工具箱编号
```

### 全量明细导出

除了按箱子分 Sheet 外，全选导出时可以额外附带汇总 Sheet：

- `箱子列表`
- `全部物品`
- `全部出入库记录`

### 箱子列表列

```text
箱子编码
箱子名称
备注
创建时间
更新时间
```

### 物品库存列

```text
箱子编码
箱子名称
物品类型
规格型号
操作类型
数量
时间
领取班组
库存结余
备注
```

### 出入库记录列

```text
时间
箱子编码
箱子名称
物品类型
规格型号
类型
变更数量
变更前数量
变更后数量
领取班组
备注
```

Excel 导出应在手机端直接生成 `.xlsx` 文件，并通过系统分享/保存能力导出。

导出交互要求：

1. 用户进入导出页。
2. 页面显示所有箱子/仓库，支持搜索。
3. 用户可勾选单个、多个或全选。
4. 页面实时显示已选择数量。
5. 用户点击“导出”。
6. 弹出文件名确认框。
7. 用户确认后生成 Excel。
8. 生成完成后显示“保存/分享”入口。
9. 如果没有选择箱子，导出按钮不可用。

## 10. 备份与恢复

备份文件名：

```text
store-scan-backup-yyyyMMdd-HHmm.json
```

备份结构：

```ts
type BackupFile = {
  app: 'store-scan';
  version: number;
  exportedAt: string;
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
};
```

恢复规则：

- 导入前校验 `app === 'store-scan'`。
- 导入前显示备份里的箱子数、物品数、流水数。
- 第一版可以采用“覆盖当前本地数据”的恢复方式。
- 覆盖前必须二次确认。

## 11. UI 原则

应用主要在仓库现场用，界面要偏工具型：

- 按钮足够大，适合单手操作。
- 关键信息优先显示：箱子名、箱子编码、物品名、数量。
- 入库/出库入口必须明显。
- 列表支持搜索。
- 不做复杂装饰。
- 尽量减少输入步骤。
- 高风险操作必须确认，例如删除、覆盖恢复、库存调整为更小数量。
- 高频操作不要隐藏太深，例如扫码、入库、出库、导出当前箱子。
- 输入框要适合手机输入，数量字段使用数字键盘。
- 操作完成后给出明确反馈，例如“已入库 5 个”“Excel 已生成”。
- 现场使用时可能光线差，文字和按钮对比度要足够高。

移动端优先布局：

- 底部导航：箱子、扫码、导出/备份、设置。
- 箱子详情页顶部固定显示箱子名称和二维码入口。
- 物品列表中每个物品展示当前数量，并提供入库/出库快捷按钮。

### 人机交互细节

箱子列表：

- 顶部提供搜索框，支持按箱子名称、箱子编码搜索。
- 新建箱子按钮固定在右下角或底部明显位置。
- 每个箱子卡片显示箱子名、编码、物品数量、最近更新时间。
- 支持按最近更新、创建时间、名称排序。
- 空状态显示“还没有箱子”，并提供新建按钮。

箱子详情：

- 顶部显示箱子名称、箱子编码、二维码入口。
- 显示物品总数和当前库存种类数。
- 物品列表支持按名称搜索。
- 每个物品卡片显示名称、数量、单位、备注。
- 每个物品卡片直接提供“入库”和“出库”按钮。
- 出库时如果数量超过库存，直接提示并禁止确认。

入库/出库弹窗：

- 默认聚焦数量输入框。
- 数量输入使用数字键盘。
- 显示当前库存和操作后的库存。
- 提供备注输入，但备注不是必填。
- 确认按钮文案要具体，例如“确认入库”“确认出库”。

扫码：

- 底部导航中扫码入口保持固定。
- 扫码成功后直接跳转到箱子详情页。
- 扫码失败或未找到箱子时，提供“重新扫码”和“返回箱子列表”。
- 扫码页要提示当前只识别本 App 生成的箱子二维码。

二维码页面：

- 二维码下方显示箱子编码和箱子名称。
- 提供保存二维码图片、分享二维码图片入口。
- 二维码图片应适合打印，背景为白色，码下带箱子编码。

导出页：

- 默认展示箱子多选列表。
- 支持全选、反选、清空选择。
- 显示已选箱子数量。
- 支持从箱子详情页直接导出当前箱子。
- 导出前必须允许用户修改文件名。
- 导出完成后显示文件名和保存/分享入口。

备份与恢复：

- 备份按钮文案使用“导出备份文件”。
- 恢复按钮文案使用“从备份文件恢复”。
- 恢复前显示备份文件中的箱子数、物品数、记录数。
- 覆盖恢复前必须二次确认。

错误与边界状态：

- 数据加载中要有明确加载状态。
- 数据为空要有空状态。
- 操作失败要显示可理解的原因。
- 不要只在控制台记录错误。
- 长列表要保持滚动流畅。

## 12. 建议目录结构

```text
store_scan/
  DEVELOPMENT.md
  package.json
  index.html
  capacitor.config.ts
  android/
  src/
    App.tsx
    main.tsx
    styles.css
    types/
      domain.ts
    lib/
      db.ts
      ids.ts
      dates.ts
      exportExcel.ts
      backup.ts
      qr.ts
    repositories/
      boxes.ts
      items.ts
      movements.ts
    pages/
      BoxListPage.tsx
      BoxDetailPage.tsx
      BoxQrPage.tsx
      ScanPage.tsx
      ExportPage.tsx
      BackupPage.tsx
      SettingsPage.tsx
    components/
      BottomNav.tsx
      ItemCard.tsx
      QuantityDialog.tsx
      EmptyState.tsx
```

## 13. 开发命令

初始化项目：

```bash
npm create vite@latest . -- --template react-ts
npm install
npm install @capacitor/core @capacitor/cli @capacitor/android
npm install idb xlsx qrcode
npx cap init store-scan com.local.storescan --web-dir=dist
```

本地开发：

```bash
npm run dev
```

构建网页：

```bash
npm run build
```

添加安卓项目：

```bash
npx cap add android
```

同步前端构建到安卓项目：

```bash
npx cap sync android
```

打开 Android Studio：

```bash
npx cap open android
```

## 14. APK 打包流程

开发时流程：

```bash
npm run build
npx cap sync android
npx cap open android
```

然后在 Android Studio 中：

1. 连接安卓手机。
2. 手机开启开发者选项和 USB 调试。
3. 点击 Run，把应用安装到手机。

导出可安装 APK 时：

1. Android Studio 菜单选择 Build。
2. 选择 Build Bundle(s) / APK(s)。
3. 选择 Build APK(s)。
4. 生成 debug APK 后手动安装到手机。

个人使用第一版可以先用 debug APK。后续需要长期安装，可以再配置 release 签名。

## 15. 风险与约束

必须注意：

- 本地数据不是云数据，清除 App 数据会丢失。
- 必须尽早实现备份/恢复。
- 二维码只保存箱子编码，不保存完整物品数据。
- 换手机必须通过备份文件迁移。
- 扫码插件在安卓上的兼容性需要实际手机测试。

## 16. 后续增强方向

第一版稳定后再考虑：

- SQLite 存储
- 图片附件
- 物品分类
- 库存低于阈值提醒
- 多条件搜索
- 按箱子单独导出 Excel
- PDF 打印二维码标签
- 云同步
- 桌面端管理页面

## 17. 后续编码优先级

建议实现顺序：

1. 初始化 React + Vite + TypeScript 项目。
2. 搭建移动端页面框架和底部导航。
3. 实现 IndexedDB 数据层。
4. 实现箱子列表、创建、详情。
5. 实现物品添加、编辑。
6. 实现入库、出库和流水。
7. 实现二维码生成。
8. 实现扫码查箱子。
9. 实现 Excel 导出：按箱子选择、全选、多 Sheet、自定义文件名。
10. 实现 JSON 备份/恢复。
11. 接入 Capacitor 并打包 APK。
12. 真机测试完整流程。
