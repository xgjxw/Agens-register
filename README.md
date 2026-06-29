# Agens Register Chrome Extension

用于自动完成 Agnes / RedFox 平台注册、验证码收取、API Key 创建与待导出管理的 Chrome 插件。

## 功能概览

- 多轮循环注册
- 支持 Agnes 发卡 / RedFox 发卡类型切换
- 每轮强制重开 TempMail / 目标平台开户页面，降低旧状态污染
- TempMail 临时邮箱自动更换
- 自动触发目标平台验证码发送
- 自动轮询并提取验证码
- 自动回填验证码与密码完成注册
- 自动创建 API Key
- API Key 先缓存到待导出队列
- Popup 表格展示待导出 Key
- 一键导出后自动从表格移除

## 目录结构

- `manifest.json`
- `background.js`
- `content/tempmail.js`
- `content/agnes.js`
- `content/redfox.js`
- `popup.html`
- `popup.css`
- `popup.js`
- `Agens插件流程图.md`
- `scripts/debug-extension.js`

## 安装

1. 打开 Chrome
2. 进入 `chrome://extensions/`
3. 开启“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择当前目录

## 使用

### 配置项

- `循环次数`
- `发卡类型`
- `固定密码`
- `失败是否计数`
- `单轮最大重试`
- `验证码超时(ms)`
- `轮询间隔(ms)`
- `导出文件名`

### 运行流程

1. 在 Popup 中保存配置
2. 点击“开始”
3. 插件执行注册、收码、建 Key
4. 成功生成的 Key 进入“待导出 Key”表格
5. 点击“一键导出”
6. 浏览器下载导出文件
7. 导出成功后，已导出的 Key 从表格中移除

## 导出字段

- `round`
- `targetType`
- `email`
- `password`
- `apiKey`
- `status`
- `createdAt`
- `error`

## 当前实现说明

- 采用 DOM 自动化方案，不是直接调用平台官网接口
- TempMail 侧已针对旧邮箱、旧弹窗、旧验证码状态做隔离处理
- Agnes 侧已支持注册、创建 Key、读取 `sk-...`、确认弹窗
- RedFox 侧已支持注册、创建密钥、读取 `ak_...`、确认保存弹窗
- 导出目标是浏览器默认下载目录，不直接写工作区文件

## 调试

如遇扩展通信问题：

1. 打开 `chrome://extensions/`
2. 重新加载扩展
3. 关闭现有 TempMail / Agnes / RedFox 标签页
4. 重新执行流程

本仓库包含一个本地调试脚本：

- `scripts/debug-extension.js`

## 开发

安装依赖：

```bash
npm install
```

本地语法检查可直接使用：

```bash
node --check background.js
node --check popup.js
node --check content/tempmail.js
node --check content/agnes.js
```
