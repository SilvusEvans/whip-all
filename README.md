# Whip-All

![Lash divider](assets/divider.png)

Sometimes things are going too slow — and you just need to give them a nudge.

一个从 [OpenWhip](https://github.com/GitFrog1111/OpenWhip) 改编的趣味工具：用一条「赛博皮鞭」抽打摸鱼的前台程序，催它快点。

## Install + run

```bash
npm install -g whipall
whipall
```

Windows 和 macOS 开箱即用；Linux 需要安装 `xdotool` 来做键盘自动化。

```bash
sudo apt install xdotool
```

## Controls

- 点击托盘图标：生成鞭子。
- 点击：放下鞭子。
- 抽它 😩💢
- 每次鞭打会发送一个中断（Ctrl-C），并随机输入一句催促语（例如「FASTER」）。

## 原理

它本质上只是一个恶搞工具，不会真正改变任何程序。甩鞭子的动作会触发：

1. 向当前前台终端发送 `Ctrl+C` 中断信号；
2. 输入一句随机催促语并回车。

所以「变快」只是心理安慰——真正的意义是让你出一口气。😂

## 设置

右键托盘图标 → 设置，可配置：

- 语言（English / 简体 / 繁體 / 日本語）
- 深色/浅色主题 + 主题色
- 是否自动切英文输入法
- 是否显示状态徽章（前台程序 + 输入法状态）
- 自定义催促语

配置保存在 `~/.whipall.json`。

## Roadmap

- [x] Initial release! 🥳
- [x] 换上主题配色（纯色鞭子）
- [x] 改名 + 重写提示语
- [x] 设置面板（Material You 风格 + 多语言）
- [ ] 更新鞭子物理效果
- [ ] 记录你抽了多少次

## Credits

本项目改编自 [GitFrog1111/OpenWhip](https://github.com/GitFrog1111/OpenWhip)（原 BadClaude），MIT 协议。
