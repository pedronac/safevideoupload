/**
 * Maintien de l'écran allumé : Screen Wake Lock si disponible, sinon (iOS ancien, Android WebView)
 * lecture en boucle d'une vidéo noire silencieuse de 1 s, technique « NoSleep ».
 * `enable()` doit être appelé depuis un geste utilisateur (clic sur Démarrer).
 */

const MP4 =
  "data:video/mp4;base64,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";
const WEBM =
  "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAALCEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggKs7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECPQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYgx6x5Wp7doxpyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAX14QDgibCBQLqBQJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYgx6x5Wp7doxmfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAB9DtnVBB+eBAKOqgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/q1CAo5aBAGQA0QEAARAQABgAGFgv9AAIjoAAo5aBAMgA0QEAARAQABgAGFgv9AAIjoAAo5aBASwA0QEAARAQABgAGFgv9AAIjoAAo5aBAZAA0QEAARAQABgAGFgv9AAIjoAAo5aBAfQA0QEAARAQABgAGFgv9AAIjoAAo5aBAlgA0QEAARAQABgAGFgv9AAIjoAAo5aBArwA0QEAARAQFGAAYWC/0AAiOgAAo5aBAyAA0QEAARAQABgAGFgv9AAIjoAAo5aBA4QA0QEAARAQABgAGFgv9AAIjoAAHFO7a5G7j7OBALeK94EB8YIBn/CBAw==";

export class ScreenKeeper {
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    this.wakeLock = null;
    this.video = null;
    this.enabled = false;
    this.mode = "none";
  }

  async enable() {
    this.enabled = true;
    await this._acquire();
  }

  /** À rappeler quand la page redevient visible : le verrou est libéré par le navigateur en arrière-plan. */
  async refresh() {
    if (this.enabled) await this._acquire();
  }

  async _acquire() {
    if (navigator.wakeLock?.request) {
      try {
        if (!this.wakeLock || this.wakeLock.released) {
          this.wakeLock = await navigator.wakeLock.request("screen");
          this.wakeLock.addEventListener("release", () => {
            if (this.enabled) this.onChange(this.mode, false);
          });
        }
        this.mode = "wakelock";
        this._stopVideo();
        this.onChange(this.mode, true);
        return;
      } catch {
        this.wakeLock = null;
      }
    }
    await this._playVideo();
  }

  async _playVideo() {
    if (!this.video) {
      const v = document.createElement("video");
      v.setAttribute("playsinline", "");
      v.setAttribute("muted", "");
      v.muted = true;
      v.loop = true;
      v.setAttribute("aria-hidden", "true");
      v.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none";
      const canWebm = v.canPlayType("video/webm") !== "";
      v.src = canWebm ? WEBM : MP4;
      document.body.appendChild(v);
      this.video = v;
    }
    try {
      await this.video.play();
      this.mode = "video";
      this.onChange(this.mode, true);
    } catch {
      this.mode = "none";
      this.onChange(this.mode, false);
    }
  }

  _stopVideo() {
    if (this.video) {
      this.video.pause();
      this.video.remove();
      this.video = null;
    }
  }

  async disable() {
    this.enabled = false;
    this._stopVideo();
    try {
      await this.wakeLock?.release();
    } catch {
      /* déjà libéré */
    }
    this.wakeLock = null;
    this.mode = "none";
  }
}
