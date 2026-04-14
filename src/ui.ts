const WS_URL = 'ws://localhost:3055';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

const statusDot = document.getElementById('status-dot') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const fileNameEl = document.getElementById('file-name') as HTMLElement;
const logEl = document.getElementById('log') as HTMLElement;
const lastResponseEl = document.getElementById('last-response') as HTMLElement;

// ─── UI Helpers ───────────────────────────────────────────────────────────────

type ConnStatus = 'connected' | 'disconnected' | 'reconnecting';

function setStatus(status: ConnStatus, message?: string) {
  statusDot.className = 'dot ' + status;
  const defaults: Record<ConnStatus, string> = {
    connected: 'MCP 서버 연결됨',
    disconnected: '연결 끊김',
    reconnecting: `재연결 중... (${reconnectAttempts}회)`,
  };
  statusText.textContent = message ?? defaults[status];
}

function addLog(text: string, direction: 'in' | 'out' | 'info' = 'info') {
  const el = document.createElement('div');
  el.className = 'log-line ' + direction;
  const time = new Date().toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const arrow = direction === 'in' ? '←' : direction === 'out' ? '→' : '·';
  el.textContent = `${time} ${arrow} ${text}`;
  logEl.prepend(el);
  if (logEl.children.length > 100) logEl.lastChild?.remove();
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  if (ws) {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    ws.close();
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectAttempts = 0;
    setStatus('connected');
    addLog('MCP 서버 연결됨', 'info');
    sendToPlugin('get_file_info', {}, '__init__');
  };

  ws.onclose = () => {
    ++reconnectAttempts;
    setStatus('reconnecting');
    addLog('연결 끊김, 3초 후 재시도', 'info');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    setStatus('disconnected', 'MCP 서버 없음 (포트 3055)');
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string) as {
        type: string;
        requestId: string;
        payload?: Record<string, unknown>;
      };
      const shortId = msg.requestId?.slice(0, 8) ?? '?';
      addLog(`${msg.type} [${shortId}]`, 'in');
      parent.postMessage({ pluginMessage: msg }, '*');
    } catch (e) {
      addLog(`파싱 오류: ${e}`, 'info');
    }
  };
}

// ─── Plugin ↔ WS Bridge ───────────────────────────────────────────────────────

function sendToPlugin(type: string, payload: Record<string, unknown>, requestId: string) {
  parent.postMessage({ pluginMessage: { type, payload, requestId } }, '*');
}

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as
    | { type?: string; requestId?: string; data?: unknown; error?: string }
    | undefined;
  if (!msg) return;

  if (msg.requestId === '__init__' && msg.data) {
    const info = msg.data as { fileName?: string };
    if (info.fileName) fileNameEl.textContent = info.fileName;
    return;
  }

  if (ws?.readyState === WebSocket.OPEN) {
    const shortId = msg.requestId?.slice(0, 8) ?? '?';
    const now = new Date().toLocaleTimeString('ko-KR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    lastResponseEl.textContent = `마지막 응답: ${now}`;
    addLog(`response [${shortId}]${msg.error ? ' ERROR' : ''}`, 'out');
    ws.send(JSON.stringify(msg));
  }
};

// ─── Button handlers ──────────────────────────────────────────────────────────

(window as unknown as Record<string, unknown>).testSelection = () => {
  const id = 'test-' + Date.now();
  sendToPlugin('get_selection', { maxDepth: 3 }, id);
  addLog(`get_selection [${id.slice(5, 13)}]`, 'out');
};

(window as unknown as Record<string, unknown>).testComments = () => {
  const id = 'test-' + Date.now();
  sendToPlugin('get_comments', {}, id);
  addLog(`get_comments [${id.slice(5, 13)}]`, 'out');
};

(window as unknown as Record<string, unknown>).testStyles = () => {
  const id = 'test-' + Date.now();
  sendToPlugin('get_styles', {}, id);
  addLog(`get_styles [${id.slice(5, 13)}]`, 'out');
};

(window as unknown as Record<string, unknown>).testFileInfo = () => {
  const id = 'test-' + Date.now();
  sendToPlugin('get_file_info', {}, id);
  addLog(`get_file_info [${id.slice(5, 13)}]`, 'out');
};

(window as unknown as Record<string, unknown>).testPageNodes = () => {
  const id = 'test-' + Date.now();
  sendToPlugin('get_page_nodes', { maxDepth: 2 }, id);
  addLog(`get_page_nodes [${id.slice(5, 13)}]`, 'out');
};

(window as unknown as Record<string, unknown>).clearLog = () => {
  logEl.innerHTML = '';
  addLog('로그 초기화', 'info');
};

(window as unknown as Record<string, unknown>).manualReconnect = () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts = 0;
  addLog('수동 재연결 시도', 'info');
  connect();
};

// ─── Help toggle ─────────────────────────────────────────────────────────────

(window as unknown as Record<string, unknown>).toggleHelp = () => {
  const overlay = document.getElementById('help-overlay') as HTMLElement;
  overlay.classList.toggle('visible');
};

// ─── Init ─────────────────────────────────────────────────────────────────────
connect();
