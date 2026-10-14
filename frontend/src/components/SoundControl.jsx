import { useSyncExternalStore } from "react";
import { subscribe, getSoundState, setSoundEnabled, unlockAudio, playSound } from "../lib/sound";

function useSound() {
  return useSyncExternalStore(subscribe, getSoundState, getSoundState);
}

// Topbar toggle. Tapping it is also a user gesture, so it unlocks audio and
// plays a short test chime — staff can confirm the volume is audible.
export function SoundToggle() {
  const { enabled } = useSound();
  function toggle() {
    unlockAudio();
    const next = !enabled;
    setSoundEnabled(next);
    if (next) playSound("ready");
  }
  return (
    <button onClick={toggle} aria-pressed={enabled} className="sound-toggle">
      Sound: {enabled ? "ON" : "OFF"}
    </button>
  );
}

// Full-width bar shown while sound is on but the browser hasn't allowed audio
// yet (fresh page load / refresh). Any tap on the bar unlocks it.
export function SoundLockedBar() {
  const { enabled, unlocked } = useSound();
  if (!enabled || unlocked) return null;
  return (
    <div className="sound-bar" role="alert" onClick={() => { unlockAudio(); playSound("ready"); }}>
      Sound alerts are not active yet — tap here to turn them on
    </div>
  );
}
