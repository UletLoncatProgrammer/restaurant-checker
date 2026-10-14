// Notification sounds, generated in code (no audio files to ship or lose).
//
// Why HTML <audio> and not the Web Audio API: on iPad/iPhone, Web Audio output
// is silenced by the hardware silent switch, while <audio> elements play.
// Why the "unlock" dance: iOS/Safari only lets a page start audio from inside a
// user tap. We play a silent clip on the first tap anywhere, which unlocks each
// element for later programmatic play (when a socket event arrives).
//
// Hard limits that code cannot fix (documented in the README): if the tablet
// screen locks or Safari is backgrounded, the page is suspended and no sound
// plays. Set Auto-Lock to Never / use Guided Access on kitchen and floor tablets.

const SAMPLE_RATE = 22050;

// notes: [{ f: Hz, d: seconds }] ; f = 0 is a rest.
export function buildWav(notes, { volume = 0.9 } = {}) {
  const total = notes.reduce((s, n) => s + n.d, 0);
  const length = Math.max(1, Math.floor(total * SAMPLE_RATE));
  const data = new Int16Array(length);
  let offset = 0;
  for (const n of notes) {
    const count = Math.floor(n.d * SAMPLE_RATE);
    for (let i = 0; i < count && offset + i < length; i++) {
      if (n.f === 0) continue;
      const t = i / SAMPLE_RATE;
      const attack = Math.min(1, i / (SAMPLE_RATE * 0.005));
      const decay = Math.exp((-3 * i) / count);
      // fundamental + a quiet octave for a bell-like timbre that carries in a noisy kitchen
      const s = Math.sin(2 * Math.PI * n.f * t) + 0.35 * Math.sin(2 * Math.PI * n.f * 2 * t);
      data[offset + i] = Math.max(-1, Math.min(1, (s / 1.35) * attack * decay * volume)) * 32767;
    }
    offset += count;
  }
  const buffer = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(buffer);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + data.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, data.length * 2, true);
  new Int16Array(buffer, 44).set(data);
  return new Uint8Array(buffer);
}

export const SOUNDS = {
  // Kitchen: new ticket. Two-note "ding-dong" played twice; loud and distinct.
  newOrder: [{ f: 880, d: 0.25 }, { f: 1175, d: 0.35 }, { f: 0, d: 0.1 }, { f: 880, d: 0.25 }, { f: 1175, d: 0.45 }],
  // Waiters: food ready. Rising three-note chime.
  ready: [{ f: 660, d: 0.2 }, { f: 880, d: 0.2 }, { f: 1320, d: 0.55 }],
  // Kitchen/floor: something was voided. Low falling double beep.
  void: [{ f: 330, d: 0.3 }, { f: 0, d: 0.08 }, { f: 220, d: 0.45 }],
};

const STORAGE_KEY = "soundEnabled";
const state = { enabled: true, unlocked: false, listeners: new Set() };
const players = new Map(); // sound name -> HTMLAudioElement
const urls = new Map();
let silentUrl = null;

try {
  state.enabled = localStorage.getItem(STORAGE_KEY) !== "off";
} catch {
  /* storage can be unavailable (private mode); default to on */
}

function emit() {
  state.snapshot = { enabled: state.enabled, unlocked: state.unlocked };
  state.listeners.forEach((l) => l());
}
state.snapshot = { enabled: state.enabled, unlocked: state.unlocked };

export function subscribe(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}
export function getSoundState() {
  return state.snapshot;
}

function urlFor(name, notes) {
  if (!urls.has(name)) urls.set(name, URL.createObjectURL(new Blob([buildWav(notes)], { type: "audio/wav" })));
  return urls.get(name);
}

function ensurePlayers() {
  if (players.size > 0) return;
  silentUrl = urlFor("silent", [{ f: 0, d: 0.05 }]);
  for (const [name, notes] of Object.entries(SOUNDS)) {
    const el = new Audio();
    el.preload = "auto";
    el.src = urlFor(name, notes);
    players.set(name, el);
  }
}

// Call from inside a user gesture (tap/click/key). Safe to call repeatedly.
export function unlockAudio() {
  if (state.unlocked) return;
  ensurePlayers();
  let pending = players.size;
  let ok = 0;
  for (const [name, el] of players) {
    const real = el.src;
    el.src = silentUrl;
    el.play()
      .then(() => {
        ok++;
      })
      .catch(() => {})
      .finally(() => {
        el.src = real;
        if (--pending === 0 && ok > 0) {
          state.unlocked = true;
          emit();
        }
      });
  }
}

export function setSoundEnabled(enabled) {
  state.enabled = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    /* ignore */
  }
  emit();
}

// Plays one of SOUNDS. Returns a promise resolving true if playback started.
// If the browser refuses (audio not unlocked yet), flips `unlocked` to false so
// the UI can show a "tap to enable sound" bar.
export async function playSound(name) {
  if (!state.enabled || !SOUNDS[name]) return false;
  ensurePlayers();
  const el = players.get(name);
  try {
    el.currentTime = 0;
    await el.play();
    if (!state.unlocked) {
      state.unlocked = true;
      emit();
    }
    return true;
  } catch {
    if (state.unlocked) {
      state.unlocked = false;
      emit();
    }
    return false;
  }
}

// Test hook
export function _resetForTests() {
  players.clear();
  urls.clear();
  state.unlocked = false;
  state.enabled = true;
  emit();
}
