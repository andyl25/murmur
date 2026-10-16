# Murmur

Wispr Flow–style dictation into a chat window. Tap **fn** anywhere on your Mac, talk, and your words stream live into a messaging-style web app; tap **fn** again to send. **Esc** discards.

```
fn ─▶ Murmur.app (menu bar)            server (localhost:5320)            web app
      CGEventTap hears fn               ws /helper ─▶ hub ─▶ ws /ws        live bubble grows as you talk,
      AVAudioEngine → SFSpeechRecognizer  (start/partial/final/level)      becomes a sent message on stop
      on-device, live partials           saves data/messages.json          optional Claude clean-up
```

## Run it on your own Mac

You need macOS 13 or newer, [Node.js](https://nodejs.org) 20 or newer, and Apple's command-line tools. If you don't have the command-line tools, run `xcode-select --install` once.

```bash
git clone https://github.com/andyl25/murmur.git
cd murmur
npm install
npm run dev        # leave this running: chat server + web app on http://localhost:5320
```

In a second Terminal tab, in the same folder:

```bash
npm run helper     # builds Murmur.app, installs it in /Applications and opens it
```

A waveform icon appears in your menu bar. Murmur has no window or Dock icon. Then:

1. **Allow Microphone and Speech Recognition** when macOS asks.
2. **Turn on Input Monitoring:** go to System Settings › Privacy & Security › **Input Monitoring** and switch **Murmur** on. Without this, fn does nothing. If macOS offers *Quit & Reopen*, click it.
3. **Stop fn opening the emoji picker** (optional): System Settings › Keyboard › "Press 🌐 key to" → **Do Nothing**.
4. **Open the chat:** click the menu-bar icon › **Open Chat**. Tap **fn**, talk, then tap **fn** again to send. **Esc** discards.

**Optional clean-up** (Claude removes "um"s and applies corrections like "at 7, no wait, 8" → "at 8"): put `ANTHROPIC_API_KEY=sk-ant-…` in a `.env` file in this folder and restart `npm run dev`.

Each person's copy is fully local, with its own chat. Speech recognition runs on your Mac.

The helper is signed with your Apple Development certificate if you have one, so rebuilding keeps the permissions. Otherwise it's signed ad-hoc, and macOS asks for permissions again after each rebuild.

## How copose.ai is hosted (maintainer notes)

Murmur runs on an AWS Lightsail box (`murmur-chat`, us-east-1, static IP `23.21.240.217`, about $5/mo). It's Ubuntu with Node 22, Caddy for automatic HTTPS, and a systemd unit called `murmur`. GoDaddy's A record for `@` points at that IP, and `www` redirects to the bare domain.

- **Deploy changes:** `bash scripts/deploy.sh` builds the web app, bundles the server into one file, uploads both and restarts. SSH key: `~/.ssh/murmur_lightsail`.
- **Who can do what:** the Mac app has to present the helper token (`~/.murmur/helper-token`, which is also in `/opt/murmur/murmur.env` on the box). Its **Open Chat** menu item opens the site as the owner (`#owner=<token>`), who can start and stop the mic from the page, toggle clean-up and clear the chat. Everyone else is a guest: they pick a name, watch you talk live and can type replies.
- **Mac app target:** `defaults write com.andylee.murmur serverURL https://copose.ai`. Set it to `http://127.0.0.1:5320` for local dev.
- **Turn on clean-up on the server** (copies the key from your `.env`, never printed):
  ```bash
  grep '^ANTHROPIC_API_KEY=' ~/Documents/.env | ssh -i ~/.ssh/murmur_lightsail ubuntu@23.21.240.217 'sudo tee /opt/murmur/.env >/dev/null && sudo chown murmur:murmur /opt/murmur/.env && sudo chmod 600 /opt/murmur/.env && sudo systemctl restart murmur'
  ```
- **Tear down:** `aws lightsail delete-instance --instance-name murmur-chat` and `aws lightsail release-static-ip --static-ip-name murmur-ip` (both with `--profile andy --region us-east-1`), then set the GoDaddy A record back.

## Clean up

After you send, Claude (`claude-opus-5-5`, low effort) rewrites the raw transcript the way Wispr does: it drops filler words and applies self-corrections ("at 7, no wait, 8" → "at 8"). The raw text shows first and the cleaned version swaps in a moment later. Hover a message and click the eye icon to see what was actually heard. Toggle it with **Clean up** in the header. It needs `ANTHROPIC_API_KEY` in the environment, `.env`, or `~/Documents/.env`.

## Test without the mic

```bash
say -o /tmp/t.aiff "testing one two three"
open -n /Applications/Murmur.app --args --feed /tmp/t.aiff
```

This streams the file through the same recognizer as live audio, sends it as one message, and quits. It never takes over fn from the running helper.

## Files

- `helper/Murmur.swift`: fn tap, mic, speech recognition, floating waveform pill, menu bar
- `server/index.ts`: WebSocket hub, message storage, Claude clean-up
- `src/App.tsx`: chat UI, built on the Beautiful UI kit tokens (`src/beautifui/foundation.css`)

## Credits

The UI uses tokens and atoms from [Beautiful UI](https://www.beautifului.dev) (MIT): `src/beautifui/foundation.css`, `src/components/atoms/Button.tsx` and `Shimmer.tsx`.
