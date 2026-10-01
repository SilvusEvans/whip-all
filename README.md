# Whip-All

![Lash divider](assets/divider.png)

Sometimes things are going too slow — and you just need to give them a nudge.

A playful tool adapted from [OpenWhip](https://github.com/GitFrog1111/OpenWhip): it cracks a "cyber whip" at the foreground program that is slacking off, and hurries it along.

## Install + run

```bash
npm install -g whipall
whipall
```

Windows and macOS work out of the box; Linux needs `xdotool` for keyboard automation.

```bash
sudo apt install xdotool
```

Prebuilt Windows x64 builds are available on the [Releases](https://github.com/SilvusEvans/whip-all/releases) page — unzip and run `Whip-All.exe`.

## Controls

- Click the tray icon: summon the whip.
- `Ctrl+Q`: drop the whip when it is on screen, otherwise quit the app. The shortcut can be changed in Settings.
- Crack it.
- Each crack sends an interrupt (`Ctrl+C`) and then types a random phrase (for example "FASTER") followed by Enter.

The app lives in the tray and has no window, so on the first launch it posts a tray notification
with the current exit shortcut. If you miss it, the shortcut is always shown in the tray tooltip
and in the Quit menu item.

## How it works

It is a gag tool at heart; it does not actually change any program. Swinging the whip triggers:

1. an interrupt signal (`Ctrl+C`) to the current foreground terminal;
2. a randomly picked hurry-up phrase, typed in and submitted with Enter.

So "going faster" is purely psychological — the real value is blowing off steam.

## Settings

Right-click the tray icon to open Settings:

- Language (English / Simplified Chinese / Traditional Chinese / Japanese)
- Dark / light theme + accent color
- Whether to switch the IME to English automatically
- Whether to show the status badge (foreground app + IME state)
- Exit hotkey (default `Ctrl+Q`, drop the whip when visible, quit otherwise)
- Custom phrases

Settings are stored in `~/.whipall.json`.

## Roadmap

- [x] Initial release
- [x] Theme colors (solid-color whip)
- [x] Rename + rewritten phrases
- [x] Settings panel (Material You style + multilingual)
- [x] Configurable exit hotkey
- [ ] Whip physics improvements
- [ ] Count how many times you cracked

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for per-version changes.

## Credits

Adapted from [GitFrog1111/OpenWhip](https://github.com/GitFrog1111/OpenWhip), MIT licensed.
