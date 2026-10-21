(() => {
  'use strict';

  // ---------- elements ----------

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const chat = $('chat');
  const chatHeader = $('chatHeader');
  const statusEl = $('status');

  // ---------- constants ----------

  const LS_KEY = 'vodChatReplay.channel';
  const NAME_COLORS = { default: '#000000', mod: '#006b2d', vip: '#7a1fa2' };
  const SYNC_WINDOW = 120;      // messages rebuilt around a seek
  const MAX_CHAT_NODES = 400;   // safety cap on chat DOM nodes
  const SEEK_THRESHOLD_MS = 3000; // a playback time change larger than this counts as a seek
  const INVISIBLE_RE = /[\u034f\u180e\u200b-\u200f\u2060\ufeff\u00ad\u{e0000}-\u{e007f}]/gu;

  // Twitch emote CDN variants, tried in order when an image is missing from one of them
  const TWITCH_EMOTE_VARIANTS = ['default/light/2.0', 'default/dark/2.0'];

  // BetterTTV emotes that are drawn over the previous emote
  const BTTV_ZERO_WIDTH = new Set(['SoSnowy', 'IceCold', 'SantaHat', 'TopHat', 'ReinDeer', 'CandyCane', 'cvMask', 'cvHazmat']);

  // 7TV v3 emote flag bits
  const STV_FLAG_PRIVATE = 1 << 0;
  const STV_FLAG_ZERO_WIDTH = 1 << 8;
  const STV_FLAG_TWITCH_DISALLOWED = 1 << 24;

  // ---------- state ----------

  let messages = [];                 // sorted: { ts, name, color, segs }
  let thirdPartyEmotes = new Map();  // code -> { url, zw }
  let nextIdx = 0;                   // index of the next message not yet shown
  let lastSyncMs = -1;
  let loopRunning = false;
  let loadToken = 0;                 // lets an older load be ignored when a newer one starts
  let currentVodUrl = null;          // blob URL of the loaded VOD

  // ---------- player ----------

  // Plyr lives in vendor/plyr/. If it didn't load, fall back to the browser's own controls.
  const plyrLoaded = typeof Plyr !== 'undefined';
  if (plyrLoaded) {
    new Plyr(video, {
      seekTime: 5,                                   // rewind / fast-forward buttons and arrow keys
      iconUrl: 'vendor/plyr/plyr.svg',
      keyboard: { focused: true, global: true },     // space toggles play/pause
      controls: ['play-large', 'play', 'rewind', 'fast-forward', 'progress',
                 'current-time', 'duration', 'mute', 'volume', 'settings', 'fullscreen'],
    });
  } else {
    video.controls = true;
  }

  // ---------- helpers ----------

  function setStatus(msg, isErr = false) {
    statusEl.textContent = msg;
    statusEl.className = isErr ? 'err' : '';
  }

  // Every external request goes through serve.py, which avoids CORS and caches responses on disk.
  function proxied(url) {
    return '/proxy?url=' + encodeURIComponent(url);
  }

  class HttpError extends Error {
    constructor(status) {
      super(`HTTP ${status}`);
      this.name = 'HttpError';
      this.status = status;
    }
  }

  async function fetchResponse(url) {
    const r = await fetch(proxied(url));
    if (!r.ok) throw new HttpError(r.status);
    return r;
  }

  async function fetchJson(url) {
    return (await fetchResponse(url)).json();
  }

  async function fetchText(url) {
    return (await fetchResponse(url)).text();
  }

  // "https://www.twitch.tv/name", "twitch.tv/name" or "@name" -> "name"
  function parseChannel(input) {
    const s = input.trim();
    const m = s.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);
    if (m) return m[1].toLowerCase();
    if (/^@?[A-Za-z0-9_]+$/.test(s)) return s.replace(/^@/, '').toLowerCase();
    return null;
  }

  // ---------- third-party emotes (BetterTTV and 7TV) ----------

  const bttvEmoteUrl = (id) => `https://cdn.betterttv.net/emote/${id}/2x`;

  // Builds the emote map. The first name wins, in this order:
  //   BetterTTV: global, then channel and shared
  //   7TV:       global set, then channel set
  async function fetchThirdPartyEmotes(twitchId) {
    const byCode = new Map();
    const errors = [];
    const add = (code, url, zeroWidth) => {
      if (code && !byCode.has(code)) byCode.set(code, { url, zw: zeroWidth });
    };

    // A failing provider is reported and skipped; the rest still load.
    // For channel lookups a 404 just means the channel has no emotes there.
    async function attempt(label, fn, notFoundMeansEmpty = false) {
      try {
        await fn();
      } catch (err) {
        if (notFoundMeansEmpty && err.status === 404) return;
        errors.push(`${label}: ${err.message}`);
      }
    }

    await attempt('BTTV global', async () => {
      for (const e of await fetchJson('https://api.betterttv.net/3/cached/emotes/global')) {
        add(e.code, bttvEmoteUrl(e.id), BTTV_ZERO_WIDTH.has(e.code));
      }
    });

    await attempt('BTTV channel', async () => {
      const ch = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`);
      for (const e of [...(ch.channelEmotes || []), ...(ch.sharedEmotes || [])]) {
        add(e.code, bttvEmoteUrl(e.id), BTTV_ZERO_WIDTH.has(e.code));
      }
    }, true);

    const addStv = (e) => {
      const data = e.data || {};
      const flags = data.flags || 0;
      if (flags & (STV_FLAG_PRIVATE | STV_FLAG_TWITCH_DISALLOWED)) return;
      const hasWebp = (data.host?.files || []).some((f) => String(f.format).toLowerCase() === 'webp');
      if (!hasWebp) return;
      add(e.name, `https:${data.host.url}/2x.webp`, Boolean(flags & STV_FLAG_ZERO_WIDTH));
    };

    await attempt('7TV global', async () => {
      const set = await fetchJson('https://7tv.io/v3/emote-sets/global');
      for (const e of set.emotes || []) addStv(e);
    });

    await attempt('7TV channel', async () => {
      const user = await fetchJson(`https://7tv.io/v3/users/twitch/${twitchId}`);
      if (!user.emote_set_id) return;
      const set = await fetchJson(`https://7tv.io/v3/emote-sets/${user.emote_set_id}`);
      for (const e of set.emotes || []) addStv(e);
    }, true);

    return { emotes: byCode, errors };
  }

  // ---------- chat parsing ----------

  // Twitch's IRC "emotes" tag, e.g. "emotesv2_<id>:0-6,8-14/<id2>:20-25".
  // Ranges are inclusive indexes in Unicode code points (not UTF-16 units).
  // Returns Map: startIndex -> { end, urls }.
  function parseEmoteTag(tag) {
    const map = new Map();
    if (!tag) return map;
    for (const part of tag.split('/')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const id = part.slice(0, colon).replace(/^emotesv2_/, '');
      const urls = TWITCH_EMOTE_VARIANTS.map((v) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/${v}`);
      for (const range of part.slice(colon + 1).split(',')) {
        const [s, e] = range.split('-').map(Number);
        if (Number.isNaN(s) || Number.isNaN(e)) continue;
        map.set(s, { end: e, urls });
      }
    }
    return map;
  }

  // Splits text into { type: 'text' | 'emote' } segments using Twitch's native emote positions.
  function buildSegments(text, emoteMap) {
    const cps = Array.from(text);
    const segs = [];
    let buf = '';
    const flush = () => {
      if (buf) segs.push({ type: 'text', value: buf });
      buf = '';
    };
    for (let i = 0; i < cps.length;) {
      const hit = emoteMap.get(i);
      if (hit) {
        flush();
        segs.push({ type: 'emote', urls: hit.urls, code: cps.slice(i, hit.end + 1).join(''), zw: false });
        i = hit.end + 1;
      } else {
        buf += cps[i++];
      }
    }
    flush();
    return segs;
  }

  // Whitespace-separated words that exactly match a BetterTTV/7TV code become emotes.
  function applyThirdParty(segs, emotes) {
    if (emotes.size === 0) return segs;
    const out = [];
    for (const s of segs) {
      if (s.type !== 'text') { out.push(s); continue; }
      let buf = '';
      for (const tok of s.value.split(/(\s+)/)) {
        if (!tok) continue;
        if (/^\s+$/.test(tok)) { buf += tok; continue; }
        const code = tok.replace(INVISIBLE_RE, '');
        const hit = emotes.get(code);
        if (!hit) { buf += tok; continue; }
        if (buf) { out.push({ type: 'text', value: buf }); buf = ''; }
        out.push({ type: 'emote', urls: [hit.url], code, zw: hit.zw });
      }
      if (buf) out.push({ type: 'text', value: buf });
    }
    return out;
  }

  function parseMessages(raw, emotes) {
    const out = [];
    for (const m of raw) {
      if (!m) continue;
      const ts = Number(m.video_ts_ms ?? (m.content_offset_seconds * 1000));
      if (!Number.isFinite(ts)) continue;

      const tags = m.tags || {};
      const badges = tags.badges || '';
      const isMod = tags.mod === '1' || tags.mod === 1 || /(^|,)moderator\//.test(badges);
      const isVip = Boolean(tags.vip) || /(^|,)vip\//.test(badges);
      const color = isMod ? NAME_COLORS.mod : isVip ? NAME_COLORS.vip : NAME_COLORS.default;
      const name = tags['display-name'] || m.display_name || 'unknown';

      const segs = applyThirdParty(buildSegments(m.message ?? '', parseEmoteTag(tags.emotes)), emotes);
      out.push({ ts, name, color, segs });
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  // ---------- rendering ----------

  function emoteImage(seg) {
    const img = document.createElement('img');
    img.className = 'emote';
    img.alt = seg.code;
    img.title = seg.code;
    let i = 0;
    img.src = proxied(seg.urls[i]);
    img.onerror = () => {
      i++;
      if (i < seg.urls.length) img.src = proxied(seg.urls[i]);
      else img.replaceWith(document.createTextNode(seg.code));
    };
    return img;
  }

  function renderMessage(m) {
    const row = document.createElement('div');
    row.className = 'msg';

    const name = document.createElement('span');
    name.className = 'name';
    name.style.color = m.color;
    name.textContent = m.name + ':';
    row.append(name, ' ');

    let lastBox = null; // zero-width emotes are drawn over the most recent emote box
    for (const s of m.segs) {
      if (s.type === 'text') {
        row.append(document.createTextNode(s.value));
      } else if (s.zw && lastBox) {
        const img = emoteImage(s);
        img.classList.add('zw');
        lastBox.append(img);
      } else {
        const box = document.createElement('span');
        box.className = 'emote-box';
        box.append(emoteImage(s));
        row.append(box);
        lastBox = box;
      }
    }
    return row;
  }

  // ---------- sync with the video ----------

  // Index of the first message with ts > t.
  function upperBound(t) {
    let lo = 0, hi = messages.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (messages[mid].ts <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Removes messages that have scrolled fully above the top of the chat box.
  function trimOffscreen() {
    const top = chat.getBoundingClientRect().top;
    while (chat.firstElementChild &&
           chat.firstElementChild.getBoundingClientRect().bottom <= top) {
      chat.firstElementChild.remove();
    }
    while (chat.childElementCount > MAX_CHAT_NODES) chat.firstElementChild.remove();
  }

  // Positive offset delays the chat, negative shows it earlier.
  function getOffsetMs() {
    const v = parseInt($('offsetMs').value, 10);
    return Number.isFinite(v) ? v : 0;
  }

  function resetChat() {
    chat.textContent = '';
    nextIdx = 0;
    lastSyncMs = -1;
  }

  function sync(force = false) {
    if (messages.length === 0) return;
    const t = video.currentTime * 1000 - getOffsetMs();
    const rewound = t < lastSyncMs;
    const jumped = Math.abs(t - lastSyncMs) > SEEK_THRESHOLD_MS;

    if (force || lastSyncMs < 0 || rewound || jumped) {
      // seek, rewind or first draw: rebuild the visible tail for this position
      chat.textContent = '';
      const i = upperBound(t);
      for (let k = Math.max(0, i - SYNC_WINDOW); k < i; k++) {
        chat.appendChild(renderMessage(messages[k]));
      }
      nextIdx = i;
      trimOffscreen();
    } else {
      let added = false;
      while (nextIdx < messages.length && messages[nextIdx].ts <= t) {
        chat.appendChild(renderMessage(messages[nextIdx++]));
        added = true;
      }
      if (added) trimOffscreen();
    }
    lastSyncMs = t;
  }

  function tick() {
    sync();
    if (!video.paused && !video.ended) {
      requestAnimationFrame(tick);
    } else {
      loopRunning = false;
    }
  }

  video.addEventListener('play', () => {
    if (!loopRunning) {
      loopRunning = true;
      requestAnimationFrame(tick);
    }
  });
  video.addEventListener('pause', () => sync());
  video.addEventListener('timeupdate', () => sync());
  video.addEventListener('seeked', () => sync(true));
  video.addEventListener('loadedmetadata', () => sync(true));
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    setStatus('Could not play the VOD. The browser may not support this format (mp4/webm work best).', true);
  });

  // ---------- loading ----------

  // The room ID comes from the chat JSON; if it's missing, ask decapi using the channel name.
  async function findRoomId(raw, login) {
    const fromTags = raw.find((m) => m?.tags?.['room-id'])?.tags['room-id'];
    if (fromTags) return fromTags;
    if (!login) return null;
    try {
      const id = (await fetchText(`https://decapi.me/twitch/id/${login}`)).trim();
      return /^\d+$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function rememberChannel(channelUrl) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ channelUrl }));
    } catch { /* storage unavailable: not essential */ }
  }

  async function load() {
    const vodFile = $('vodFile').files[0];
    const jsonFile = $('jsonFile').files[0];
    const channelUrl = $('channelUrl').value;

    if (!vodFile || !jsonFile) {
      setStatus('Choose both the VOD file and the chat JSON file.', true);
      return;
    }
    rememberChannel(channelUrl);

    const token = ++loadToken;
    try {
      setStatus('Reading chat JSON...');
      const raw = JSON.parse(await jsonFile.text());
      if (!Array.isArray(raw)) throw new Error('Chat JSON is not an array of messages.');

      const login = parseChannel(channelUrl);
      const roomId = await findRoomId(raw, login);

      let emotes = new Map();
      let errors = [];
      if (roomId) {
        setStatus('Loading BetterTTV / 7TV emotes...');
        ({ emotes, errors } = await fetchThirdPartyEmotes(roomId));
      }

      if (token !== loadToken) return; // a newer load started while this one was running

      // replaced on every load, so a channel without emotes doesn't keep the previous channel's
      thirdPartyEmotes = emotes;
      messages = parseMessages(raw, emotes);
      resetChat();
      chatHeader.textContent = 'Chat replay' + (login ? ` - ${login}` : '');

      // The VOD is read straight from disk by the browser; no server is involved.
      if (currentVodUrl) URL.revokeObjectURL(currentVodUrl);
      currentVodUrl = URL.createObjectURL(vodFile);
      video.src = currentVodUrl;

      let msg = `${messages.length} messages | ${emotes.size} BTTV/7TV emotes`;
      if (errors.length) msg += ' | failed: ' + errors.join('; ');
      setStatus(msg, errors.length > 0 && emotes.size === 0);
      sync(true);
    } catch (err) {
      console.error(err);
      if (err instanceof TypeError && location.protocol === 'file:') {
        setStatus('Open this page through serve.py (http://localhost:8000), not by double-clicking index.html.', true);
      } else {
        setStatus(err.message, true);
      }
    }
  }

  // ---------- init ----------

  $('loadBtn').addEventListener('click', load);
  $('channelUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  $('offsetMs').addEventListener('input', () => sync(true));

  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved?.channelUrl) $('channelUrl').value = saved.channelUrl;
  } catch { /* ignore a corrupt saved value */ }

  if (!plyrLoaded) {
    setStatus('Plyr not loaded: check that the vendor/plyr folder is next to index.html and is served. Using the browser default controls.', true);
  }
  if (location.protocol === 'file:') {
    setStatus('Open this page through serve.py (http://localhost:8000), not by double-clicking index.html.', true);
  }
})();
