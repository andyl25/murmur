import { useEffect, useRef, useState } from 'react';

export type Message = {
  id: string;
  text: string;
  raw: string;
  source: 'voice' | 'typed';
  sender: string;
  senderId: string;
  createdAt: number;
  durationMs?: number;
  audio?: string;
  polish?: 'pending' | 'done' | 'failed';
};

export type Live = { id: string; text: string; startedAt: number; sender: string; senderId: string };

/** A connected Murmur Mac app — one per person who can talk. */
export type Helper = {
  id: string;
  name: string;
  info: {
    fnUsage: number | null;
    onDevice: boolean;
    perms: { mic: string; speech: string; input: string };
  } | null;
};

type State = {
  ready: boolean;
  online: boolean;
  owner: boolean;
  messages: Message[];
  lives: Record<string, Live>;
  helpers: Helper[];
  hostName: string;
  polish: boolean;
  polishAvailable: boolean;
  notice: string | null;
  name: string;
};

// ---------------------------------------------------------------- local identity

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — identity lasts for this tab only */
  }
}

// The Mac app's "Open Chat" hands over who this browser is: #owner=<token> for the host,
// #key=<install key>&name=<name> for everyone else. Keep it and tidy the URL so it isn't shared.
function adoptHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const owner = params.get('owner');
  const key = params.get('key');
  const name = params.get('name');
  if (owner) write('murmur.owner', owner);
  if (key) write('murmur.clientId', key);
  if (name) write('murmur.name', name);
  if (owner || key) history.replaceState(null, '', location.pathname + location.search);
}
adoptHash();

const clientId =
  read('murmur.clientId') ??
  (() => {
    const id = crypto.randomUUID();
    write('murmur.clientId', id);
    return id;
  })();

export const OWNER_ID = 'owner';

/** True when the server now ships a different bundle than this page runs (once per build, so it can't loop). */
function staleBuild(build: string | null) {
  if (!build || document.querySelector(`script[src$="${build.split('/').pop()}"]`)) return false;
  try {
    if (sessionStorage.getItem('murmur.reloadedFor') === build) return false;
    sessionStorage.setItem('murmur.reloadedFor', build);
  } catch {
    return false;
  }
  return true;
}

const initial: State = {
  ready: false,
  online: false,
  owner: false,
  messages: [],
  lives: {},
  helpers: [],
  hostName: 'Me',
  polish: true,
  polishAvailable: false,
  notice: null,
  name: read('murmur.name') ?? '',
};

// Your own mic level arrives ~20×/s; it goes to subscribers directly instead of through React state.
const levelListeners = new Set<(v: number) => void>();
export function onLevel(fn: (v: number) => void) {
  levelListeners.add(fn);
  return () => void levelListeners.delete(fn);
}

export function useMurmur() {
  const [s, setS] = useState<State>(initial);
  const ws = useRef<WebSocket | null>(null);
  const me = useRef(clientId);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let noticeTimer: ReturnType<typeof setTimeout>;
    const token = read('murmur.owner') ?? '';

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/ws${token ? `?owner=${encodeURIComponent(token)}` : ''}`);
      ws.current = sock;
      sock.onclose = () => {
        setS((p) => ({ ...p, online: false, lives: {} }));
        if (!closed) retry = setTimeout(connect, 1200);
      };
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'level') {
          if (m.id === me.current) levelListeners.forEach((fn) => fn(m.v));
          return;
        }
        setS((p) => {
          switch (m.t) {
            case 'init':
              if (staleBuild(m.build)) location.reload();
              me.current = m.owner ? OWNER_ID : clientId;
              return {
                ...p,
                ready: true,
                online: true,
                owner: m.owner,
                messages: m.messages,
                lives: Object.fromEntries((m.lives as Live[]).map((l) => [l.senderId, l])),
                helpers: m.helpers,
                hostName: m.hostName,
                polish: m.polish,
                polishAvailable: m.polishAvailable,
              };
            case 'live': {
              const lives = { ...p.lives };
              if (m.live) lives[m.senderId] = m.live;
              else delete lives[m.senderId];
              return { ...p, lives };
            }
            case 'message': {
              const lives = { ...p.lives };
              if (m.endLive) delete lives[m.endLive];
              return { ...p, messages: [...p.messages, m.message], lives };
            }
            case 'update':
              return { ...p, messages: p.messages.map((x) => (x.id === m.message.id ? m.message : x)) };
            case 'delete':
              return { ...p, messages: p.messages.filter((x) => x.id !== m.id) };
            case 'clear':
              return { ...p, messages: [] };
            case 'helpers':
              return { ...p, helpers: m.helpers, hostName: m.hostName };
            case 'polish':
              return { ...p, polish: m.on };
            case 'notice':
              if (m.to && m.to !== me.current) return p;
              clearTimeout(noticeTimer);
              noticeTimer = setTimeout(() => setS((q) => ({ ...q, notice: null })), 6000);
              return { ...p, notice: m.text };
            default:
              return p;
          }
        });
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(noticeTimer);
      ws.current?.close();
    };
  }, []);

  const send = (msg: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  };

  const myId = s.owner ? OWNER_ID : clientId;
  return {
    ...s,
    myId,
    myName: s.owner ? s.hostName : s.name,
    myHelper: s.helpers.find((h) => h.id === myId) ?? null,
    myLive: s.lives[myId] ?? null,
    isMine: (senderId: string) => senderId === myId,
    toggle: () => send({ t: 'toggle', clientId }),
    cancel: () => send({ t: 'cancel', clientId }),
    sendText: (text: string) => send({ t: 'send', text, name: s.name, clientId }),
    remove: (id: string) => send({ t: 'delete', id, clientId }),
    clear: () => send({ t: 'clear' }),
    setPolish: (on: boolean) => send({ t: 'polish', on }),
    setName: (name: string) => {
      write('murmur.name', name);
      setS((p) => ({ ...p, name }));
    },
    dismissNotice: () => setS((p) => ({ ...p, notice: null })),
  };
}
