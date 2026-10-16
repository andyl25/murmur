# Murmur

Wispr Flow–style voice chat. Tap **fn** anywhere on your Mac and talk: your words stream live into a shared chat at **https://copose.ai** as you speak. Tap **fn** again to send. **Esc** discards. Every voice message also keeps its recording: anyone in the chat can tap ▶ to hear it, and each word lights up as it’s spoken.

```
fn ─▶ Murmur.app (menu bar)             server (copose.ai)                      web chat
      CGEventTap hears fn                ws /helper ─▶ hub ─▶ ws /ws             live bubble per speaker,
      AVAudioEngine → SFSpeechRecognizer   one Mac app per person                 sent message with ▶ audio,
      on-device, live partials + .m4a     stores messages + recordings           optional Claude clean-up
```

## Talk in the chat from your Mac

You need macOS 13 or newer, git, and Apple's command-line tools. If you don't have the command-line tools, run `xcode-select --install` once.

```bash
git clone https://github.com/andyl25/murmur.git
cd murmur
bash helper/build.sh && open /Applications/Murmur.app
```

This builds the Murmur Mac app on your machine, installs it in Applications and opens it. You don't need Node or anything else. A waveform icon appears in your menu bar; Murmur has no window or Dock icon. Then:

1. **Allow Microphone and Speech Recognition** when macOS asks.
2. **Turn on Input Monitoring:** go to System Settings › Privacy & Security › **Input Monitoring** and switch **Murmur** on. Without this, fn does nothing. If macOS offers *Quit & Reopen*, click it.
3. **Stop fn opening the emoji picker** (optional): System Settings › Keyboard › "Press 🌐 key to" → **Do Nothing**.
4. **Open the chat:** click the menu-bar icon › **Open Chat**. Always open it this way: it tells the page which messages and mic are yours. Then tap **fn**, talk, and tap **fn** again to send.

Your name in the chat is your Mac's first name. To change it, run this and then quit and reopen Murmur:

```bash
defaults write com.andylee.murmur displayName "Your Name"
```

Speech recognition runs on your Mac. Only the text and the recording of each message you send go to the chat, and the chat is public to anyone with the link.

## Run your own private copy instead

To run the whole thing locally, with your own chat on http://localhost:5320, you also need [Node.js](https://nodejs.org) 20 or newer:

```bash
npm install
npm run dev                                                         # chat server + web app
defaults write com.andylee.murmur serverURL http://127.0.0.1:5320   # point your Mac app at it
npm run helper                                                      # (re)build and open the Mac app
```

**Optional clean-up** (Claude removes "um"s and applies corrections like "at 7, no wait, 8" → "at 8"): put `ANTHROPIC_API_KEY=sk-ant-…` in a `.env` file in this folder and restart `npm run dev`.

The Mac app is signed with your Apple Development certificate if you have one, so rebuilding keeps the permissions. Otherwise it's signed ad-hoc, and macOS asks for permissions again after each rebuild.

## How copose.ai is hosted (maintainer notes)

Murmur runs on an AWS Lightsail box (`murmur-chat`, us-east-1, static IP `23.21.240.217`, about $5/mo). It's Ubuntu with Node 22, Caddy for automatic HTTPS, and a systemd unit called `murmur`. GoDaddy's A record for `@` points at that IP, and `www` redirects to the bare domain.

- **Deploy changes:** `bash scripts/deploy.sh` builds the web app, bundles the server into one file, uploads both and restarts. SSH key: `~/.ssh/murmur_lightsail`.
- **Who can do what:** the host's Mac app presents the helper token (`~/.murmur/helper-token`, set with `defaults write com.andylee.murmur helperToken …`; also in `/opt/murmur/murmur.env` on the box) and speaks as the owner. Only the owner can clear the chat or toggle clean-up. Everyone else's Mac app joins with its own random install key, which **Open Chat** hands to their browser (`#key=…&name=…`), so each person controls only their own mic. Visitors without the Mac app pick a name and type. Recordings are stored in `/opt/murmur/data/audio`.
- **Mac app target:** copose.ai by default. For local dev, run `defaults write com.andylee.murmur serverURL http://127.0.0.1:5320`; to go back, `defaults delete com.andylee.murmur serverURL`.
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
