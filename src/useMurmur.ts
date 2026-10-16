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
  polish?: 'pending' | 'done' | 'failed';
};

export type Live = { id: string; text: string; startedAt: number; sender: string };

export type Helper = {
  connected: boolean;
  name: string; // the host's display name (whoever runs the Mac app)
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
  live: Live | null;
  helper: Helper;
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

// The Mac app opens the chat as …/#owner=<token>; keep it and tidy the URL so it isn't shared by accident.
function ownerToken() {
  const m = location.hash.match(/owner=([^&]+)/);
  if (m) {
    write('murmur.owner', decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname + location.search);
  }
  return read('murmur.owner') ?? '';
}

const clientId =
  read('murmur.clientId') ??
  (() => {
    const id = crypto.randomUUID();
    write('murmur.clientId', id);
    return id;
  })();

export const OWNER_ID = 'owner';

const initial: State = {
  ready: false,
  online: false,
  owner: false,
  messages: [],
  live: null,
  helper: { connected: false, name: 'Me', info: null },
  polish: true,
  polishAvailable: false,
  notice: null,
  name: read('murmur.name') ?? '',
};

// Mic levels arrive ~20×/s; they go to subscribers directly instead of through React state.
const levelListeners = new Set<(v: number) => void>();
export function onLevel(fn: (v: number) => void) {
  levelListeners.add(fn);
  return () => void levelListeners.delete(fn);
}

export function useMurmur() {
  const [s, setS] = useState<State>(initial);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let noticeTimer: ReturnType<typeof setTimeout>;
    const token = ownerToken();

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/ws${token ? `?owner=${encodeURIComponent(token)}` : ''}`);
      ws.current = sock;
      sock.onclose = () => {
        setS((p) => ({ ...p, online: false, live: null }));
        if (!closed) retry = setTimeout(connect, 1200);
      };
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'level') return levelListeners.forEach((fn) => fn(m.v));
        setS((p) => {
          switch (m.t) {
            case 'init':
              return {
                ...p,
                ready: true,
                online: true,
                owner: m.owner,
                messages: m.messages,
                live: m.live,
                helper: m.helper,
                polish: m.polish,
                polishAvailable: m.polishAvailable,
              };
            case 'live':
              return { ...p, live: m.live };
            case 'message':
              return { ...p, messages: [...p.messages, m.message], live: m.endLive ? null : p.live };
            case 'update':
              return { ...p, messages: p.messages.map((x) => (x.id === m.message.id ? m.message : x)) };
            case 'delete':
              return { ...p, messages: p.messages.filter((x) => x.id !== m.id) };
            case 'clear':
              return { ...p, messages: [] };
            case 'helper':
              return { ...p, helper: { connected: m.connected, name: m.name, info: m.info } };
            case 'polish':
              return { ...p, polish: m.on };
            case 'notice':
              if (m.ownerOnly && !p.owner) return p;
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

  return {
    ...s,
    myName: s.owner ? s.helper.name : s.name,
    isMine: (senderId: string) => (s.owner ? senderId === OWNER_ID : senderId === clientId),
    toggle: () => send({ t: 'toggle' }),
    cancel: () => send({ t: 'cancel' }),
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
