# Agens 发卡机 Chrome 插件

## 当前能力

- 支持配置循环次数
- 自动打开 TempMail 和 Agnes 页面
- 从 TempMail 读取临时邮箱
- 在 Agnes 页面触发发送验证码
- 轮询 TempMail 提取验证码
- 回填验证码和密码完成注册
- 创建 API Key
- 成功结果先缓存到待导出队列
- 插件内表格展示待导出 key
- 一键导出后自动从表格移除
- 支持停止任务、失败计数控制、单轮重试

## 当前目录结构

- `manifest.json`
- `background.js`
- `content/tempmail.js`
- `content/agnes.js`
- `popup.html`
- `popup.css`
- `popup.js`
- `Agens插件流程图.md`

## 安装方式

1. 打开 Chrome
2. 进入 `chrome://extensions/`
3. 打开“开发者模式”
4. 选择“加载已解压的扩展程序”
5. 选择当前目录 `D:\workspace\myself\Agens发卡机`

## 使用方式

1. 在插件弹窗中配置：
   - 循环次数
   - 固定密码
   - 失败是否计数
   - 单轮最大重试次数
   - 验证码超时
   - 轮询间隔
   - 导出文件名
2. 点击“开始”
3. 插件会自动执行多轮注册和发卡
4. 成功生成的 key 会先进入 popup 里的“待导出 Key”表格
5. 点击“一键导出”后，导出文件通过 Chrome 下载能力保存到浏览器下载目录
6. 导出成功后，这批 key 会从表格中移除

## 注意

- 这是首版通用 DOM 自动化骨架。
- Agnes 页面具体字段、注册页跳转方式、API Key 页面结构如果和当前脚本假设不同，需要再按真实 DOM 微调。
- 当前导出是下载到浏览器默认下载目录，不是直接写工作区文件。
- 如果首次运行报 `Receiving end does not exist`，先点扩展页的“重新加载”，然后关闭并重新打开 TempMail / Agnes 标签页再试。
