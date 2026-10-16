import { ArrowUp, Check, Copy, Eye, Microphone, Sparks, Trash, WarningTriangle, Xmark } from 'iconoir-react';
import { Pause, Play } from 'iconoir-react/solid';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/atoms/Button';
import { Shimmer } from '@/components/atoms/Shimmer';
import { cn } from '@/lib/utils';
import { type Helper, type Live, type Message, onLevel, useMurmur } from './useMurmur';

const GROUP_MS = 2 * 60_000; // bubbles closer than this stack as one group
const DIVIDER_MS = 15 * 60_000; // a gap this long gets a time divider

export function App() {
  const m = useMurmur();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lives = Object.values(m.lives).sort((a, b) => a.startedAt - b.startedAt);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [m.messages, m.lives]);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  const empty = m.ready && m.messages.length === 0 && !lives.length;
  // whoever is on the other end: the host for guests, the most recent other speaker for the host
  const other = m.owner ? m.helpers.find((h) => h.id !== m.myId)?.name ?? 'your friend' : m.hostName;

  return (
    <div className="flex h-full flex-col bg-page">
      <Header {...m} liveList={lives} />
      {(m.owner || m.myHelper) && <Notices helper={m.myHelper} owner={m.owner} online={m.online} />}
      <div ref={scroller} onScroll={onScroll} className="murmur-scroll flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-[720px] flex-col px-4 pt-6 pb-4">
          {empty ? (
            <EmptyState canDictate={!!m.myHelper || m.owner} other={other} />
          ) : (
            <Thread messages={m.messages} lives={lives} owner={m.owner} isMine={m.isMine} onDelete={m.remove} />
          )}
        </div>
      </div>
      {!m.ready ? null : !m.owner && !m.name ? (
        <NameForm onSubmit={m.setName} host={m.hostName} />
      ) : (
        <Composer
          live={m.myLive}
          name={m.owner ? null : m.name}
          canDictate={!!m.myHelper}
          onToggle={m.toggle}
          onCancel={m.cancel}
          onSend={m.sendText}
          onRename={() => m.setName('')}
        />
      )}
      {m.notice && <Toast text={m.notice} onClose={m.dismissNotice} />}
    </div>
  );
}

// ---------------------------------------------------------------- header

function names(list: string[]) {
  return list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

function Header(m: ReturnType<typeof useMurmur> & { liveList: Live[] }) {
  const talking = m.liveList.filter((l) => l.senderId !== m.myId).map((l) => l.sender);
  const online = m.helpers.filter((h) => h.id !== m.myId).map((h) => h.name);
  const fnReady = m.myHelper?.info?.perms.input === 'granted';
  const [dot, status] = !m.online
    ? ['bg-ink-3', m.ready ? 'Reconnecting…' : 'Connecting…']
    : m.myLive
      ? ['bg-red', 'Listening…']
      : talking.length
        ? ['bg-red', `${names(talking)} ${talking.length > 1 ? 'are' : 'is'} talking…`]
        : m.myHelper && !fnReady
          ? ['bg-orange', 'Waiting for Input Monitoring']
          : online.length
            ? ['bg-green', `${names(online)} ${online.length > 1 ? 'are' : 'is'} online`]
            : m.myHelper
              ? ['bg-green', 'Press fn to talk']
              : m.owner
                ? ['bg-ink-3', 'Mac app not connected']
                : ['bg-ink-3', `${m.hostName} is offline`];

  return (
    <header className="border-b border-line">
      <div className="mx-auto flex h-14 max-w-[720px] items-center gap-3 px-4">
        <div className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-canvas">
          <Bars />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] leading-tight font-semibold">Murmur</div>
          <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
            <span className={cn('size-1.5 shrink-0 rounded-full', dot, dot === 'bg-red' && 'animate-pulse')} />
            <span className="truncate">{status}</span>
          </div>
        </div>
        {m.owner && <OwnerControls {...m} />}
      </div>
    </header>
  );
}

function OwnerControls(m: ReturnType<typeof useMurmur>) {
  return (
    <>
      <Button
        size="xs"
        variant={m.polish && m.polishAvailable ? 'secondary' : 'quiet'}
        disabled={!m.polishAvailable}
        aria-pressed={m.polish}
        title={
          m.polishAvailable
            ? 'Claude removes filler words and applies self-corrections after you send'
            : 'Add ANTHROPIC_API_KEY to enable clean-up'
        }
        onClick={() => m.setPolish(!m.polish)}
      >
        <Sparks width={14} height={14} className={m.polish && m.polishAvailable ? 'text-accent' : 'text-ink-3'} />
        Clean up {m.polish && m.polishAvailable ? 'on' : 'off'}
      </Button>
      <Button
        size="xs"
        variant="quiet"
        title="Clear chat"
        aria-label="Clear chat"
        disabled={!m.messages.length}
        onClick={() => confirm('Delete every message in this chat?') && m.clear()}
      >
        <Trash width={15} height={15} />
      </Button>
    </>
  );
}

function Bars() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="2" y="5.5" width="2.4" height="5" rx="1.2" />
      <rect x="6.8" y="2" width="2.4" height="12" rx="1.2" />
      <rect x="11.6" y="4.5" width="2.4" height="7" rx="1.2" />
    </svg>
  );
}

// ---------------------------------------------------------------- setup notices

const FN_HINT_KEY = 'murmur.fnHintDismissed';

function Notices({ helper, owner, online }: { helper: Helper | null; owner: boolean; online: boolean }) {
  const [fnDismissed, setFnDismissed] = useState(() => {
    try {
      return localStorage.getItem(FN_HINT_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!online) return null;

  const items: { key: string; text: ReactNode; dismiss?: () => void }[] = [];
  const perms = helper?.info?.perms;
  if (!helper) {
    if (owner)
      items.push({
        key: 'helper',
        text: (
          <>
            Your Murmur Mac app isn’t connected. Open it from Applications, or build it with <Code>npm run helper</Code>.
          </>
        ),
      });
  } else if (perms) {
    if (perms.input !== 'granted')
      items.push({
        key: 'input',
        text: (
          <>
            Turn on <b className="font-medium">Murmur</b> in System Settings › Privacy &amp; Security › Input Monitoring
            so it can hear the fn key.
          </>
        ),
      });
    if (perms.mic !== 'granted' || perms.speech !== 'granted')
      items.push({
        key: 'perms',
        text: <>Murmur needs Microphone and Speech Recognition access (System Settings › Privacy &amp; Security).</>,
      });
    if (helper.info?.fnUsage !== 0 && !fnDismissed)
      items.push({
        key: 'fn',
        text: (
          <>
            If fn also opens the emoji picker, set System Settings › Keyboard › “Press 🌐 key to” → <b className="font-medium">Do Nothing</b>.
          </>
        ),
        dismiss: () => {
          setFnDismissed(true);
          try {
            localStorage.setItem(FN_HINT_KEY, '1');
          } catch {
            /* private mode */
          }
        },
      });
  }
  if (!items.length) return null;

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2 px-4 pt-3">
      {items.map((n) => (
        <div key={n.key} className="flex items-start gap-2.5 rounded-[10px] bg-orange-tint px-3 py-2 text-[13px] text-ink">
          <WarningTriangle width={15} height={15} className="mt-[2px] shrink-0 text-orange" />
          <div className="flex-1">{n.text}</div>
          {n.dismiss && (
            <button className="mt-[1px] rounded-full p-0.5 text-ink-2 hover:bg-hover-2" aria-label="Dismiss" onClick={n.dismiss}>
              <Xmark width={14} height={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-[5px] bg-surface px-1.5 py-[1px] font-mono text-[12px] shadow-hairline">{children}</code>;
}

// ---------------------------------------------------------------- thread

function Thread({
  messages,
  lives,
  owner,
  isMine,
  onDelete,
}: {
  messages: Message[];
  lives: Live[];
  owner: boolean;
  isMine: (senderId: string) => boolean;
  onDelete: (id: string) => void;
}) {
  // sent messages, then whatever people are saying right now, as one stream for grouping
  const items = [
    ...messages.map((msg) => ({ kind: 'msg' as const, key: msg.id, senderId: msg.senderId, at: msg.createdAt, msg })),
    ...lives.map((live) => ({ kind: 'live' as const, key: `live-${live.senderId}`, senderId: live.senderId, at: live.startedAt, live })),
  ];
  const rows: ReactNode[] = [];
  items.forEach((item, i) => {
    const prev = items[i - 1];
    const next = items[i + 1];
    const divider = !prev || !sameDay(prev.at, item.at) || item.at - prev.at > DIVIDER_MS;
    if (divider) rows.push(<Divider key={`d-${item.key}`} t={item.at} />);
    const joinedAbove = !divider && prev.senderId === item.senderId && item.at - prev.at < GROUP_MS;
    const joinedBelow = !!next && next.senderId === item.senderId && next.at - item.at < GROUP_MS && sameDay(next.at, item.at);
    const mine = isMine(item.senderId);
    rows.push(
      item.kind === 'msg' ? (
        <Bubble
          key={item.key}
          msg={item.msg}
          mine={mine}
          canDelete={owner || mine}
          joinedAbove={joinedAbove}
          joinedBelow={joinedBelow}
          onDelete={onDelete}
        />
      ) : (
        <LiveBubble key={item.key} live={item.live} mine={mine} joinedAbove={joinedAbove} />
      ),
    );
  });

  return <div className="mt-auto flex flex-col gap-[3px]">{rows}</div>;
}

function Divider({ t }: { t: number }) {
  return (
    <div className="mt-5 mb-2 text-center text-[11.5px] text-ink-3 first:mt-0">
      <span className="font-medium text-ink-2">{dayLabel(t)}</span> {timeLabel(t)}
    </div>
  );
}

const bubbleBase =
  'rounded-[18px] px-3.5 py-[7px] text-left text-[15px] leading-[1.42] whitespace-pre-wrap break-words';

/** Mine: blue on the right. Theirs: gray on the left, corners joined on the left edge. */
function bubbleShape(mine: boolean, joinedAbove: boolean, joinedBelow: boolean) {
  return cn(
    bubbleBase,
    mine ? 'bg-accent text-white' : 'bg-hover-2 text-ink',
    joinedAbove && (mine ? 'rounded-tr-[6px]' : 'rounded-tl-[6px]'),
    joinedBelow && (mine ? 'rounded-br-[6px]' : 'rounded-bl-[6px]'),
  );
}

function SenderName({ name }: { name: string }) {
  return <div className="mb-1 ml-3 text-[11.5px] font-medium text-ink-2">{name}</div>;
}

function Bubble({
  msg,
  mine,
  canDelete,
  joinedAbove,
  joinedBelow,
  onDelete,
}: {
  msg: Message;
  mine: boolean;
  canDelete: boolean;
  joinedAbove: boolean;
  joinedBelow: boolean;
  onDelete: (id: string) => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const firstText = useRef(msg.text);
  const edited = msg.polish === 'done' && msg.raw !== msg.text;
  const text = showRaw && edited ? msg.raw : msg.text;

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const meta = msg.polish === 'pending' ? (
    <Shimmer>Cleaning up…</Shimmer>
  ) : showRaw && edited ? (
    'Original transcript'
  ) : !joinedBelow ? (
    <>
      {timeLabel(msg.createdAt)}
      {msg.source === 'voice' && msg.durationMs ? ` · ${clock(msg.durationMs)}` : ''}
      {edited ? ' · Cleaned up' : ''}
    </>
  ) : null;

  return (
    <div className={cn('group flex flex-col', mine ? 'items-end' : 'items-start', !joinedAbove && 'mt-2.5')}>
      {!mine && !joinedAbove && <SenderName name={msg.sender} />}
      <div className={cn('flex max-w-[82%] items-center gap-1', !mine && 'flex-row-reverse')}>
        <div className="flex shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          {edited && (
            <IconButton label={showRaw ? 'Show cleaned-up text' : 'Show original transcript'} active={showRaw} onClick={() => setShowRaw(!showRaw)}>
              <Eye width={14} height={14} />
            </IconButton>
          )}
          <IconButton label="Copy" onClick={copy}>
            {copied ? <Check width={14} height={14} /> : <Copy width={14} height={14} />}
          </IconButton>
          {canDelete && (
            <IconButton label="Delete" onClick={() => onDelete(msg.id)}>
              <Trash width={14} height={14} />
            </IconButton>
          )}
        </div>
        <div
          className={cn(
            bubbleShape(mine, joinedAbove, joinedBelow),
            showRaw && edited && (mine ? 'bg-ink-2' : 'bg-line-strong'),
            msg.audio && 'min-w-[230px]',
          )}
        >
          {msg.audio && <VoicePlayer src={msg.audio} durationMs={msg.durationMs} mine={mine} />}
          <span key={text} className={text !== firstText.current ? 'bubble-swap' : undefined}>
            {text}
          </span>
        </div>
      </div>
      {meta && <div className="mx-1 mt-1 mb-0.5 text-[11.5px] text-ink-3">{meta}</div>}
    </div>
  );
}

let playingNow: HTMLAudioElement | null = null; // one voice message plays at a time

/** ▶ for a voice message's recording: play/pause, progress, time left. */
function VoicePlayer({ src, durationMs, mine }: { src: string; durationMs?: number; mine: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [length, setLength] = useState((durationMs ?? 0) / 1000);

  useEffect(() => () => audio.current?.pause(), []);

  const toggle = () => {
    let a = audio.current;
    if (!a) {
      a = new Audio(src);
      a.onloadedmetadata = () => Number.isFinite(a!.duration) && setLength(a!.duration);
      a.ontimeupdate = () => setPos(a!.currentTime);
      a.onplay = () => setPlaying(true);
      a.onpause = () => setPlaying(false);
      a.onended = () => setPos(0);
      audio.current = a;
    }
    if (!a.paused) return a.pause();
    if (playingNow && playingNow !== a) playingNow.pause();
    playingNow = a;
    void a.play();
  };

  const pct = length ? Math.min(100, (pos / length) * 100) : 0;
  return (
    <div className="mb-1.5 flex items-center gap-2.5 pt-0.5">
      <button
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play recording'}
        title={playing ? 'Pause' : 'Play recording'}
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full transition-transform active:scale-95',
          mine ? 'bg-white text-accent' : 'bg-ink text-canvas',
        )}
      >
        {playing ? <Pause width={12} height={12} /> : <Play width={12} height={12} className="translate-x-[1px]" />}
      </button>
      <div className={cn('h-[3px] flex-1 overflow-hidden rounded-full', mine ? 'bg-white/30' : 'bg-ink/15')}>
        <div className={cn('h-full rounded-full', mine ? 'bg-white' : 'bg-ink')} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('font-mono text-[11.5px] tabular-nums', mine ? 'text-white/80' : 'text-ink-2')}>
        {clock(Math.max(0, length - pos) * 1000)}
      </span>
    </div>
  );
}

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'grid size-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink',
        active && 'text-accent',
      )}
    >
      {children}
    </button>
  );
}

function LiveBubble({ live, mine, joinedAbove }: { live: Live; mine: boolean; joinedAbove: boolean }) {
  return (
    <div className={cn('flex flex-col', mine ? 'items-end' : 'items-start', !joinedAbove && 'mt-2.5')}>
      {!mine && !joinedAbove && <SenderName name={live.sender} />}
      <div className={cn(bubbleShape(mine, joinedAbove, true), 'bubble-live max-w-[82%]')}>
        {live.text ? <LiveText text={live.text} /> : <TypingDots />}
      </div>
      <div className="mx-1 mt-1 mb-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
        <span className="size-1.5 animate-pulse rounded-full bg-red" />
        {mine ? 'Listening' : 'Talking'} · <Elapsed since={live.startedAt} />
      </div>
    </div>
  );
}

/** Partial transcripts keep growing; only the words that just arrived animate in. */
function LiveText({ text }: { text: string }) {
  const prev = useRef('');
  let stable = 0;
  while (stable < text.length && stable < prev.current.length && text[stable] === prev.current[stable]) stable++;
  stable = text.lastIndexOf(' ', stable) + 1; // back up to a word boundary
  useEffect(() => {
    prev.current = text;
  });
  return (
    <>
      {text.slice(0, stable)}
      <span key={`${stable}:${text.length}`} className="live-new">
        {text.slice(stable)}
      </span>
      <span aria-hidden className="stream-caret" />
    </>
  );
}

function TypingDots() {
  return (
    <span className="flex h-[21px] items-center gap-[5px] px-0.5" aria-label="Listening">
      {[0, 1, 2].map((i) => (
        <span key={i} className="typing-dot size-[7px] rounded-full bg-current" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </span>
  );
}

function EmptyState({ canDictate, other }: { canDictate: boolean; other: string }) {
  return (
    <div className="m-auto flex max-w-[340px] flex-col items-center pb-10 text-center">
      <kbd className="grid size-14 place-items-center rounded-[12px] bg-surface font-mono text-[17px] font-medium text-ink shadow-raised">
        {canDictate ? 'fn' : <Bars />}
      </kbd>
      <h2 className="mt-5 text-[17px] font-semibold tracking-[-0.02em]">
        {canDictate ? 'Press fn and start talking' : `Waiting for ${other}`}
      </h2>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
        {canDictate
          ? 'Your words show up here live as you speak. Press fn again and they’re sent as a message anyone here can play back.'
          : `When ${other} talks, their words appear here live as they speak. You can reply below.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- composer

function NameForm({ host, onSubmit }: { host: string; onSubmit: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <footer className="shrink-0">
      <div className="mx-auto max-w-[720px] px-4 pt-1 pb-3">
        <form
          className="flex h-11 items-center gap-2 rounded-full bg-surface pr-1.5 pl-4 shadow-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSubmit(name.trim().slice(0, 40));
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className="min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-ink-3"
          />
          <Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>
            Join chat
          </Button>
        </form>
        <div className="mt-2 text-center text-[11.5px] text-ink-3">So {host} knows who’s replying.</div>
      </div>
    </footer>
  );
}

function Composer({
  live,
  name,
  canDictate,
  onToggle,
  onCancel,
  onSend,
  onRename,
}: {
  live: Live | null;
  name: string | null; // a guest's chosen name (null for the host)
  canDictate: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onSend: (text: string) => void;
  onRename: () => void;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    if (!text.trim()) return;
    onSend(text);
    setText('');
  };

  return (
    <footer className="shrink-0">
      <div className="mx-auto max-w-[720px] px-4 pt-1 pb-3">
        {live ? (
          <div className="flex h-11 items-center gap-3 rounded-full bg-surface pr-1.5 pl-4 shadow-card">
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-red" />
            <Elapsed since={live.startedAt} className="w-9 shrink-0 font-mono text-[12.5px] text-ink-2 tabular-nums" />
            <Waveform />
            <Button size="sm" variant="quiet" onClick={onCancel}>
              Discard
            </Button>
            <SendButton label="Send (fn)" onClick={onToggle} />
          </div>
        ) : (
          <form
            className="flex h-11 items-center gap-2 rounded-full bg-surface pr-1.5 pl-4 shadow-card"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Message"
              className="min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-ink-3"
            />
            {text.trim() || !canDictate ? (
              <SendButton label="Send" type="submit" disabled={!text.trim()} />
            ) : (
              <button
                type="button"
                title="Dictate (fn)"
                aria-label="Dictate"
                onClick={onToggle}
                className="grid size-8 place-items-center rounded-full text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink disabled:opacity-40"
              >
                <Microphone width={17} height={17} />
              </button>
            )}
          </form>
        )}
        <div className="mt-2 flex justify-center gap-3 text-[11.5px] text-ink-3">
          {!canDictate && name ? (
            <span>
              Chatting as <span className="font-medium text-ink-2">{name}</span> ·{' '}
              <button className="underline-offset-2 hover:text-ink hover:underline" onClick={onRename}>
                change
              </button>
            </span>
          ) : live ? (
            <>
              <span>
                <Kbd>fn</Kbd> send
              </span>
              <span>
                <Kbd>esc</Kbd> discard
              </span>
            </>
          ) : canDictate ? (
            <span>
              <Kbd>fn</Kbd> anywhere on your Mac to dictate
            </span>
          ) : null}
        </div>
      </div>
    </footer>
  );
}

function SendButton({
  label,
  onClick,
  type = 'button',
  disabled,
}: {
  label: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white transition-[transform,background-color,opacity] hover:bg-accent-ink active:scale-[0.94] disabled:opacity-35 disabled:pointer-events-none"
    >
      <ArrowUp width={16} height={16} strokeWidth={2.2} />
    </button>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mr-1 rounded-[5px] bg-surface px-1.5 py-[1px] font-mono text-[10.5px] text-ink-2 shadow-btn">{children}</kbd>
  );
}

function Waveform() {
  const [bars, setBars] = useState<number[]>(() => Array(48).fill(0));
  useEffect(() => onLevel((v) => setBars((b) => [...b.slice(1), v])), []);
  return (
    <div className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden" aria-hidden>
      {bars.map((v, i) => (
        <span
          key={i}
          className="w-[3px] shrink-0 rounded-full bg-ink transition-[height] duration-75"
          style={{ height: 3 + v * 22, opacity: 0.3 + v * 0.7 }}
        />
      ))}
    </div>
  );
}

function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return <span className={className}>{clock(Math.max(0, now - since))}</span>;
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 flex justify-center px-4">
      <div className="toast-in pointer-events-auto flex max-w-[520px] items-center gap-2 rounded-full bg-[var(--tooltip-bg)] py-2 pr-2 pl-4 text-[13px] text-[var(--tooltip-fg)] shadow-overlay">
        <span>{text}</span>
        <button className="rounded-full p-1 text-[var(--tooltip-muted)] hover:text-[var(--tooltip-fg)]" aria-label="Dismiss" onClick={onClose}>
          <Xmark width={14} height={14} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- time helpers

function sameDay(a: number, b: number) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function dayLabel(t: number) {
  const d = new Date(t);
  const today = new Date();
  if (sameDay(t, today.getTime())) return 'Today';
  if (sameDay(t, today.getTime() - 86_400_000)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeLabel(t: number) {
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
