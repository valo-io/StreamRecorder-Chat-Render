(() => {
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const player = new Plyr(video, {
    seekTime: 5,                          // rewind / fast-forward buttons and arrow keys jump 5s
    iconUrl: 'vendor/plyr/plyr.svg',
    keyboard: { focused: true, global: true }, // space toggles play/pause
    controls: ['play-large', 'play', 'rewind', 'fast-forward', 'progress',
               'current-time', 'duration', 'mute', 'volume', 'settings', 'fullscreen'],
  });
  const chat = $('chat');
  const statusEl = $('status');

  const LS_KEY = 'vodChatReplay.paths';
  const NAME_COLORS = { default: '#000000', mod: '#006b2d', vip: '#7a1fa2' };
  const WINDOW = 120;      // messages rebuilt around a seek
  const MAX_NODES = 400;   // hard safety cap on DOM nodes
  const INVISIBLE_RE = /[\u034f\u180e\u200b-\u200f\u2060\ufeff\u00ad\u{e0000}-\u{e007f}]/gu;

  // Zero-width emote codes and 7TV flag bits used to decide overlay behaviour and filtering
  const BTTV_ZERO_WIDTH = new Set(['SoSnowy', 'IceCold', 'SantaHat', 'TopHat', 'ReinDeer', 'CandyCane', 'cvMask', 'cvHazmat']);
  const STV_FLAG_PRIVATE = 1 << 0;
  const STV_FLAG_ZERO_WIDTH = 1 << 8;
  const STV_FLAG_TWITCH_DISALLOWED = 1 << 24;

  let messages = [];          // { ts, name, color, segs }
  let thirdParty = new Map(); // code -> { url, zw }
  let nextIdx = 0;
  let lastSyncT = -1;
  let loopRunning = false;
  let loadToken = 0;

  // ---------- helpers ----------

  function setStatus(msg, isErr = false) {
    statusEl.textContent = msg;
    statusEl.className = isErr ? 'err' : '';
  }

  function cleanPath(p) {
    return p.trim().replace(/^["']|["']$/g, '');
  }

  function localUrl(p) {
    return '/local?path=' + encodeURIComponent(p);
  }

  // External APIs go through serve.py (/proxy) to avoid browser CORS blocks.
  function proxied(url) {
    return '/proxy?url=' + encodeURIComponent(url);
  }

  function parseChannel(input) {
    const s = input.trim();
    if (!s) return null;
    const m = s.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);
    if (m) return m[1].toLowerCase();
    if (/^@?[A-Za-z0-9_]+$/.test(s)) return s.replace(/^@/, '').toLowerCase();
    return null;
  }

  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.text()).trim();
  }

  // ---------- third-party emotes (BetterTTV and 7TV) ----------

  // Builds the emote list in priority order: first code wins.
  //   BetterTTV: global -> channel -> shared
  //   7TV:       global set -> channel set
  async function fetchThirdPartyList(twitchId) {
    const list = [];
    const seen = new Set();
    const push = (code, url, zw) => {
      if (!code || seen.has(code)) return;
      seen.add(code);
      list.push({ code, url, zw });
    };
    const errors = [];

    // BetterTTV
    try {
      const globals = await fetchJson(proxied('https://api.betterttv.net/3/cached/emotes/global'));
      for (const e of globals) {
        push(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`, BTTV_ZERO_WIDTH.has(e.code));
      }
    } catch (e) { errors.push(`BTTV global: ${e.message}`); }

    try {
      // 404 just means the channel has no BTTV emotes, which is fine
      const ch = await fetchJson(proxied(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`));
      for (const e of [...(ch.channelEmotes || []), ...(ch.sharedEmotes || [])]) {
        push(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`, BTTV_ZERO_WIDTH.has(e.code));
      }
    } catch (e) {
      if (!String(e.message).includes('404')) errors.push(`BTTV channel: ${e.message}`);
    }

    // 7TV
    const add7tv = (e) => {
      const data = e.data || {};
      const flags = data.flags || 0;
      if (flags & STV_FLAG_PRIVATE) return;
      if (flags & STV_FLAG_TWITCH_DISALLOWED) return;
      const files = (data.host && data.host.files) || [];
      if (!files.some((f) => String(f.format).toLowerCase() === 'webp')) return;
      push(e.name, `https:${data.host.url}/2x.webp`, !!(flags & STV_FLAG_ZERO_WIDTH));
    };

    try {
      const g = await fetchJson(proxied('https://7tv.io/v3/emote-sets/global'));
      for (const e of g.emotes || []) add7tv(e);
    } catch (e) { errors.push(`7TV global: ${e.message}`); }

    try {
      const user = await fetchJson(proxied(`https://7tv.io/v3/users/twitch/${twitchId}`));
      if (user.emote_set_id) {
        const set = await fetchJson(proxied(`https://7tv.io/v3/emote-sets/${user.emote_set_id}`));
        for (const e of set.emotes || []) add7tv(e);
      }
    } catch (e) {
      if (!String(e.message).includes('404')) errors.push(`7TV channel: ${e.message}`);
    }

    return { list, errors };
  }

  // Responses are cached by serve.py, so repeat runs work offline.
  async function loadThirdPartyEmotes(twitchId) {
    const { list, errors } = await fetchThirdPartyList(twitchId);
    thirdParty = new Map(list.map((e) => [e.code, { url: e.url, zw: e.zw }]));
    return { errors };
  }

  // ---------- chat parsing ----------

  // Twitch IRC "emotes" tag: "emotesv2_<id>:0-6,8-14/<id2>:20-25"
  // Indexes are Unicode code points, so we walk code points, not UTF-16 units.
  // Twitch CDN variants tried in order when an emote image is missing in one of them
  const TWITCH_EMOTE_VARIANTS = ['default/light/2.0', 'default/dark/2.0', 'animated/light/2.0', 'animated/dark/2.0'];

  function parseEmoteTag(tag) {
    const map = new Map(); // startIndex -> { end, urls }
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

  // Native Twitch emotes by position -> segments
  function buildSegments(text, emoteMap) {
    const cps = Array.from(text);
    const segs = [];
    let buf = '';
    const flush = () => { if (buf) { segs.push({ type: 'text', value: buf }); buf = ''; } };
    for (let i = 0; i < cps.length;) {
      const hit = emoteMap.get(i);
      if (hit) {
        flush();
        segs.push({ type: 'emote', urls: hit.urls, code: cps.slice(i, hit.end + 1).join(''), zw: false });
        i = hit.end + 1;
      } else {
        buf += cps[i];
        i++;
      }
    }
    flush();
    return segs;
  }

  // Whitespace-separated words that exactly match a 7TV/BTTV code become emotes.
  function applyThirdParty(segs) {
    if (thirdParty.size === 0) return segs;
    const out = [];
    for (const s of segs) {
      if (s.type !== 'text') { out.push(s); continue; }
      let buf = '';
      for (const tok of s.value.split(/(\s+)/)) {
        if (!tok) continue;
        if (/^\s+$/.test(tok)) { buf += tok; continue; }
        const key = tok.replace(INVISIBLE_RE, '');
        const hit = thirdParty.get(key);
        if (hit) {
          if (buf) { out.push({ type: 'text', value: buf }); buf = ''; }
          out.push({ type: 'emote', urls: [hit.url], code: key, zw: hit.zw });
        } else {
          buf += tok;
        }
      }
      if (buf) out.push({ type: 'text', value: buf });
    }
    return out;
  }

  function parseMessages(raw) {
    const out = [];
    for (const m of raw) {
      const ts = Number(m.video_ts_ms ?? (m.content_offset_seconds * 1000));
      if (!Number.isFinite(ts)) continue;

      const tags = m.tags || {};
      const badges = tags.badges || '';
      const isMod = tags.mod === '1' || tags.mod === 1 || /(^|,)moderator\//.test(badges);
      const isVip = !!tags.vip || /(^|,)vip\//.test(badges);
      const color = isMod ? NAME_COLORS.mod : isVip ? NAME_COLORS.vip : NAME_COLORS.default;
      const name = tags['display-name'] || m.display_name || 'unknown';

      const segs = applyThirdParty(buildSegments(m.message ?? '', parseEmoteTag(tags.emotes)));
      out.push({ ts, name, color, segs });
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  function makeImg(seg) {
    const img = document.createElement('img');
    img.className = 'emote';
    let next = 0;
    img.alt = seg.code;
    img.title = seg.code;
    img.src = proxied(seg.urls[next]);
    img.onerror = () => {
      next++;
      if (next < seg.urls.length) img.src = proxied(seg.urls[next]);
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

    let lastBox = null; // most recent emote box, zero-width emotes overlay it
    for (const s of m.segs) {
      if (s.type === 'text') {
        row.append(document.createTextNode(s.value));
        continue;
      }
      if (s.zw && lastBox) {
        const img = makeImg(s);
        img.classList.add('zw');
        lastBox.append(img);
        continue;
      }
      const box = document.createElement('span');
      box.className = 'emote-box';
      box.append(makeImg(s));
      row.append(box);
      lastBox = box;
    }
    return row;
  }

  // ---------- sync with video ----------

  // index of first message with ts > t
  function upperBound(t) {
    let lo = 0, hi = messages.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (messages[mid].ts <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // remove messages that have scrolled fully above the top of the chat box
  function trimOffscreen() {
    const top = chat.getBoundingClientRect().top;
    while (chat.firstElementChild &&
           chat.firstElementChild.getBoundingClientRect().bottom <= top) {
      chat.firstElementChild.remove();
    }
    while (chat.childElementCount > MAX_NODES) chat.firstElementChild.remove();
  }

  // positive offset delays the chat, negative shows it earlier
  function getOffsetMs() {
    const v = parseInt($('offsetMs').value, 10);
    return Number.isFinite(v) ? v : 0;
  }

  function sync(force = false) {
    if (messages.length === 0) return;
    const t = video.currentTime * 1000 - getOffsetMs();
    const backward = t < lastSyncT;
    const jumped = Math.abs(t - lastSyncT) > 3000;

    if (force || lastSyncT < 0 || backward || jumped) {
      chat.textContent = '';
      const i = upperBound(t);
      for (let k = Math.max(0, i - WINDOW); k < i; k++) {
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
    lastSyncT = t;
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

  // ---------- load ----------

  async function load() {
    const vodPath = cleanPath($('vodPath').value);
    const jsonPath = cleanPath($('jsonPath').value);
    const channelUrl = $('channelUrl').value;

    if (!vodPath || !jsonPath) {
      setStatus('Enter both the VOD path and the chat JSON path.', true);
      return;
    }
    localStorage.setItem(LS_KEY, JSON.stringify({ vodPath, jsonPath, channelUrl }));

    const token = ++loadToken;
    try {
      setStatus('Loading chat JSON...');
      const raw = await fetchJson(localUrl(jsonPath));
      if (!Array.isArray(raw)) throw new Error('Chat JSON is not an array of messages.');

      const login = parseChannel(channelUrl);
      let roomId = raw.find((m) => m.tags && m.tags['room-id'])?.tags['room-id'] ?? null;
      if (!roomId && login) {
        roomId = await fetchText(proxied(`https://decapi.me/twitch/id/${login}`)).catch(() => null);
      }

      setStatus('Loading BetterTTV / 7TV emotes...');
      let info = { errors: [] };
      if (roomId) info = await loadThirdPartyEmotes(roomId);

      if (token !== loadToken) return; // a newer load superseded this one

      messages = parseMessages(raw);
      chat.textContent = '';
      nextIdx = 0;
      lastSyncT = -1;
      $('chatHeader').textContent = 'Chat replay' + (login ? ` - ${login}` : '');

      video.src = localUrl(vodPath);
      video.load();

      let msg = `${messages.length} messages | ${thirdParty.size} BTTV/7TV emotes`;
      if (info.errors.length) msg += ' | failed: ' + info.errors.join('; ');
      setStatus(msg, info.errors.length > 0 && thirdParty.size === 0);
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
  $('offsetMs').addEventListener('input', () => sync(true));
  for (const id of ['vodPath', 'jsonPath', 'channelUrl']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  }

  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved) {
      $('vodPath').value = saved.vodPath || '';
      $('jsonPath').value = saved.jsonPath || '';
      $('channelUrl').value = saved.channelUrl || '';
    }
  } catch (_) { /* ignore */ }

  if (location.protocol === 'file:') {
    setStatus('Open this page through serve.py (http://localhost:8000), not by double-clicking index.html.', true);
  }
})();
