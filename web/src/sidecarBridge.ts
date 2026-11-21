import { applyColorSchemeMeta } from './types';

declare global {
  interface Window {
    sidecar?: {
      conversationId?: string;
      fetch?: typeof fetch;
      getWorkspaceUris?: () => Promise<string[]>;
      onWorkspaceChange?: (listener: (uris: string[]) => void) => () => void;
      ui?: {
        toggleConversation?: (conversationId: string, options?: Record<string, unknown>) => void;
        toggleAuxPane?: (request: Record<string, unknown>) => void;
      };
    };
  }
}

export function isInSidecar(): boolean {
  try {
    if (typeof window !== 'undefined' && window.sidecar) return true;
    const params = new URLSearchParams(window.location.search);
    return params.get('sidecar') === '1';
  } catch {
    return false;
  }
}

export function getHostConversationId(): string | null {
  try {
    const fromHost = window.sidecar?.conversationId?.trim();
    if (fromHost) return fromHost;
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('conversationId')?.trim();
    return fromQuery || null;
  } catch {
    return null;
  }
}

export function canJumpHostConversation(): boolean {
  return typeof window !== 'undefined' && typeof window.sidecar?.ui?.toggleConversation === 'function';
}

export function jumpToHostConversation(conversationId: string): boolean {
  if (!conversationId || !canJumpHostConversation()) return false;
  try {
    window.sidecar!.ui!.toggleConversation!(conversationId);
    return true;
  } catch {
    return false;
  }
}

export function subscribeHostWorkspaces(onUpdate: (uris: string[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  let active = true;
  let unsub: (() => void) | null = null;

  if (typeof window.sidecar?.onWorkspaceChange === 'function') {
    unsub = window.sidecar.onWorkspaceChange((uris) => {
      if (active && Array.isArray(uris)) onUpdate(uris);
    });
  }
  if (typeof window.sidecar?.getWorkspaceUris === 'function') {
    window.sidecar
      .getWorkspaceUris()
      .then((uris) => {
        if (active && Array.isArray(uris) && uris.length > 0) {
          onUpdate(uris);
        }
      })
      .catch(() => {});
  }

  return () => {
    active = false;
    if (unsub) {
      try {
        unsub();
      } catch {}
    }
  };
}

function normalizeApiPath(apiPath: string): string {
  if (apiPath.startsWith('http://') || apiPath.startsWith('https://')) {
    return apiPath;
  }
  if (apiPath.startsWith('./')) {
    return apiPath.slice(1);
  }
  return apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
}

export function apiFetch(apiPath: string, init?: RequestInit): Promise<Response> {
  const url = normalizeApiPath(apiPath);
  if (typeof window !== 'undefined' && typeof window.sidecar?.fetch === 'function') {
    return window.sidecar.fetch(url, init);
  }
  return fetch(url, init);
}

export function createApiEventSource(apiPath: string): EventSource {
  return new EventSource(normalizeApiPath(apiPath));
}

function detectHostThemeFromRoot(): 'dark' | 'light' | null {
  try {
    const rootStyle = getComputedStyle(document.documentElement);
    const bgRaw = rootStyle.getPropertyValue('--background').trim();
    if (!bgRaw) return null;

    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background)';
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();

    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return null;
    const scale = computed.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum < 0.5 ? 'dark' : 'light';
  } catch {
    return null;
  }
}

export function observeHostTheme(): () => void {
  const sync = () => {
    try {
      const manual = localStorage.getItem('color-scheme');
      if (manual === 'light' || manual === 'dark') return;
    } catch {}
    const detected = detectHostThemeFromRoot();
    if (detected) {
      applyColorSchemeMeta(detected);
    }
  };

  sync();
  const observer = new MutationObserver(() => sync());
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme']
  });
  return () => observer.disconnect();
}
