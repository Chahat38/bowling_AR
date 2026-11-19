export function triggerHaptic(pattern) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch {
      // Ignore browser haptic blocks
    }
  }
}

export class SoundFX {
  constructor(muted = false) {
    this.muted = muted;
    this.ctx = null;
    this.rollOsc = null;
    this.rollFilter = null;
    this.rollGain = null;
    this.rollPanner = null;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    this.ctx = new AudioCtx();

    this.rollOsc = this.ctx.createOscillator();
    this.rollOsc.type = 'triangle';
    this.rollOsc.frequency.value = 50;

    this.rollFilter = this.ctx.createBiquadFilter();
    this.rollFilter.type = 'lowpass';
    this.rollFilter.frequency.value = 140;

    this.rollGain = this.ctx.createGain();
    this.rollGain.gain.value = 0;

    this.rollPanner = this._createPanner();

    this.rollOsc.connect(this.rollFilter);
    this.rollFilter.connect(this.rollGain);
    this.rollGain.connect(this.rollPanner);
    this.rollPanner.connect(this.ctx.destination);
    this.rollOsc.start();
  }

  _createPanner() {
    if (typeof this.ctx.createPanner === 'function') {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 0.9;
      p.maxDistance = 14;
      p.rolloffFactor = 1.15;
      return p;
    }
    return this.ctx.createGain();
  }

  _setNodePos(panner, pos, now) {
    if (!panner || !pos) return;
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(pos.x, now, 0.02);
      panner.positionY.setTargetAtTime(pos.y, now, 0.02);
      panner.positionZ.setTargetAtTime(pos.z, now, 0.02);
    } else if (typeof panner.setPosition === 'function') {
      panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  updateListener(cameraPos, forwardVec, upVec) {
    if (!this.ctx || !this.ctx.listener) return;
    const listener = this.ctx.listener;
    const now = this.ctx.currentTime;
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(cameraPos.x, now, 0.02);
      listener.positionY.setTargetAtTime(cameraPos.y, now, 0.02);
      listener.positionZ.setTargetAtTime(cameraPos.z, now, 0.02);
      listener.forwardX.setTargetAtTime(forwardVec.x, now, 0.02);
      listener.forwardY.setTargetAtTime(forwardVec.y, now, 0.02);
      listener.forwardZ.setTargetAtTime(forwardVec.z, now, 0.02);
      listener.upX.setTargetAtTime(upVec.x, now, 0.02);
      listener.upY.setTargetAtTime(upVec.y, now, 0.02);
      listener.upZ.setTargetAtTime(upVec.z, now, 0.02);
    } else if (typeof listener.setPosition === 'function') {
      listener.setPosition(cameraPos.x, cameraPos.y, cameraPos.z);
      if (typeof listener.setOrientation === 'function') {
        listener.setOrientation(
          forwardVec.x,
          forwardVec.y,
          forwardVec.z,
          upVec.x,
          upVec.y,
          upVec.z
        );
      }
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (muted && this.ctx && this.rollGain) {
      this.rollGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    }
  }

  updateRoll(speed, onSurface, worldPos = null) {
    if (!this.ctx || !this.rollGain || !this.rollOsc || !this.rollFilter) return;
    const now = this.ctx.currentTime;
    if (worldPos) {
      this._setNodePos(this.rollPanner, worldPos, now);
    }
    if (this.muted || !onSurface || speed < 0.25) {
      this.rollGain.gain.setTargetAtTime(0, now, 0.04);
      return;
    }
    const norm = Math.min(speed / 10, 1);
    this.rollOsc.frequency.setTargetAtTime(42 + norm * 34, now, 0.05);
    this.rollFilter.frequency.setTargetAtTime(115 + norm * 165, now, 0.05);
    this.rollGain.gain.setTargetAtTime(0.035 + norm * 0.06, now, 0.04);
  }

  playPinHit(intensity = 1, worldPos = null) {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    const base = 420 + (Math.random() - 0.5) * 90;
    const panner = this._createPanner();
    if (worldPos) {
      this._setNodePos(panner, worldPos, now);
    }
    panner.connect(this.ctx.destination);

    [1, 1.54].forEach((mult, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(base * mult, now);
      osc.frequency.exponentialRampToValueAtTime(base * mult * 0.65, now + 0.1);
      gain.gain.setValueAtTime(Math.min(0.18, (0.095 * intensity) / (idx + 1)), now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      osc.connect(gain);
      gain.connect(panner);
      osc.start(now);
      osc.stop(now + 0.14);
    });
  }

  playSuccess() {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      const t = now + i * 0.085;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.11, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.28);
    });
  }
}

export class UIController {
  constructor() {
    this.els = {
      screenStart: document.getElementById('screen-start'),
      screenMessage: document.getElementById('screen-message'),
      screenRotate: document.getElementById('screen-rotate'),
      screenMenu: document.getElementById('screen-menu'),
      screenResult: document.getElementById('screen-result'),
      screenLevels: document.getElementById('screen-levels'),
      filmGrain: document.getElementById('film-grain'),
      canvasEl: document.getElementById('canvas'),
      videoEl: document.getElementById('video'),
      uiRoot: document.getElementById('ui'),
      debugLayer: document.getElementById('debug-layer'),
      debugText: document.getElementById('debug-text'),
      debugFovSlider: document.getElementById('debug-fov-slider'),
      debugFovVal: document.getElementById('debug-fov-val'),
      hudRoot: document.getElementById('hud-root'),
      hudTop: document.getElementById('hud-top'),
      hudBar: document.getElementById('hud-bar'),
      hudLevel: document.getElementById('hud-level'),
      hudPins: document.getElementById('hud-pins'),
      hudBalls: document.getElementById('hud-balls'),
      hintPill: document.getElementById('hint-pill'),
      trackingLost: document.getElementById('tracking-lost'),
      lowLightBanner: document.getElementById('low-light-banner'),
      msgTitle: document.getElementById('msg-title'),
      msgBody: document.getElementById('msg-body'),
      btnStart: document.getElementById('btn-start'),
      btnRetryAR: document.getElementById('btn-retry-ar'),
      btnPreviewMode: document.getElementById('btn-preview-mode'),
      btnFit: document.getElementById('btn-fit'),
      btnReplace: document.getElementById('btn-replace'),
      btnMenu: document.getElementById('btn-menu'),
      btnCloseMenu: document.getElementById('btn-close-menu'),
      btnOpenLevels: document.getElementById('btn-open-levels'),
      btnToggleMove: document.getElementById('btn-toggle-move'),
      btnRecenter: document.getElementById('btn-recenter'),
      btnMute: document.getElementById('btn-mute'),
      iconSoundOn: document.getElementById('icon-sound-on'),
      iconSoundOff: document.getElementById('icon-sound-off'),
      resultTitle: document.getElementById('result-title'),
      resultStars: document.getElementById('result-stars'),
      resultInfo: document.getElementById('result-info'),
      btnNextLevel: document.getElementById('btn-next-level'),
      btnRetryLevel: document.getElementById('btn-retry-level'),
      btnCloseLevels: document.getElementById('btn-close-levels'),
      levelsGrid: document.getElementById('levels-grid'),
    };
    this.debugEnabled = false;
  }

  bindViewportSync(onResize) {
    const sync = () => {
      const h = Math.round(window.visualViewport?.height ?? window.innerHeight);
      document.documentElement.style.setProperty('--app-height', `${h}px`);
      const isMobileLandscape =
        navigator.maxTouchPoints > 0 && window.innerWidth > window.innerHeight;
      this.els.screenRotate.classList.toggle('hidden', !isMobileLandscape);
      if (onResize) onResize();
    };
    window.addEventListener('load', sync);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', () => {
      sync();
      window.setTimeout(sync, 300);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', sync);
      window.visualViewport.addEventListener('scroll', sync);
    }
    sync();
  }

  initDebugOverlay(initialFov, onFovChange) {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') {
      this.setDebugVisible(true);
    }

    if (this.els.debugFovSlider && this.els.debugFovVal) {
      this.els.debugFovSlider.value = String(initialFov);
      this.els.debugFovVal.textContent = String(initialFov);
      this.els.debugFovSlider.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        this.els.debugFovVal.textContent = String(val);
        if (onFovChange) onFovChange(val);
      });
    }

    // Secret 5-tap trigger in top-left corner (96x96px)
    let tapCount = 0;
    let tapTimer = 0;
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (e.clientX <= 96 && e.clientY <= 96) {
          tapCount++;
          window.clearTimeout(tapTimer);
          if (tapCount >= 5) {
            tapCount = 0;
            this.setDebugVisible(!this.debugEnabled);
          } else {
            tapTimer = window.setTimeout(() => {
              tapCount = 0;
            }, 2000);
          }
        }
      },
      true
    );
  }

  setDebugVisible(visible) {
    this.debugEnabled = visible;
    if (this.els.debugLayer) {
      this.els.debugLayer.classList.toggle('hidden', !visible);
    }
  }

  updateDebugInfo(text) {
    if (!this.debugEnabled || !this.els.debugText) return;
    this.els.debugText.textContent = text;
  }

  setARBlend(enabled, softEdges = true) {
    if (this.els.filmGrain) {
      this.els.filmGrain.classList.toggle('hidden', !enabled);
    }
    if (this.els.canvasEl) {
      this.els.canvasEl.classList.toggle('soft-ar', enabled && softEdges);
    }
  }

  setFitVisible(visible) {
    if (this.els.btnFit) {
      this.els.btnFit.classList.toggle('hidden', !visible);
    }
  }

  setReplaceVisible(visible) {
    if (this.els.btnReplace) {
      this.els.btnReplace.classList.toggle('hidden', !visible);
    }
  }

  getHudBottomPx() {
    if (this.els.hudTop) {
      const rect = this.els.hudTop.getBoundingClientRect();
      if (rect.bottom > 0) return rect.bottom;
    }
    return 68;
  }

  setMuteIcon(muted) {
    this.els.iconSoundOn.classList.toggle('hidden', muted);
    this.els.iconSoundOff.classList.toggle('hidden', !muted);
  }

  showHUD(visible) {
    this.els.hudRoot.classList.toggle('hidden', !visible);
  }

  showTopBar(visible) {
    this.els.hudBar.classList.toggle('hidden', !visible);
  }

  updateTopBar(levelId, pinsDown, targetPins, ballsLeft, popPins = false) {
    this.els.hudLevel.textContent = `Level ${levelId}`;
    this.els.hudPins.textContent = `Pins ${pinsDown}/${targetPins}`;
    this.els.hudBalls.textContent = `Balls ${ballsLeft}`;
    if (popPins) {
      this.els.hudPins.classList.remove('pop');
      void this.els.hudPins.offsetWidth;
      this.els.hudPins.classList.add('pop');
      window.setTimeout(() => this.els.hudPins.classList.remove('pop'), 180);
    }
  }

  setHint(text) {
    if (!text) {
      this.els.hintPill.classList.add('hidden');
    } else {
      this.els.hintPill.textContent = text;
      this.els.hintPill.classList.remove('hidden');
    }
  }

  setTrackingLost(lost) {
    this.els.trackingLost.classList.toggle('hidden', !lost);
  }

  setLowLight(low) {
    if (this.els.lowLightBanner) {
      this.els.lowLightBanner.classList.toggle('hidden', !low);
    }
  }

  showMessage(title, body) {
    this.els.msgTitle.textContent = title;
    this.els.msgBody.textContent = body;
    this.els.screenMessage.classList.remove('hidden');
  }

  hideMessage() {
    this.els.screenMessage.classList.add('hidden');
  }

  starSvg(filled, small = false) {
    const cls = small
      ? `tile-star ${filled ? 'star-on' : 'star-off'}`
      : `star-svg ${filled ? 'star-on' : 'star-off'}`;
    return `<svg class="${cls}" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
  }

  showResult(won, stars, pinsDown, score, hasNext) {
    this.els.resultTitle.textContent = won ? 'Level complete' : 'Try again';
    this.els.resultStars.innerHTML = [1, 2, 3].map((n) => this.starSvg(n <= stars)).join('');
    this.els.resultInfo.textContent = `Pins ${pinsDown} · Score ${score}`;
    this.els.btnNextLevel.classList.toggle('hidden', !hasNext);
    this.els.screenResult.classList.remove('hidden');
  }

  hideResult() {
    this.els.screenResult.classList.add('hidden');
  }

  renderLevelsGrid(levels, progress, currentLevelIdx, onSelect) {
    this.els.levelsGrid.innerHTML = '';
    levels.forEach((lvl, idx) => {
      const unlocked = lvl.id <= progress.unlockedLevel;
      const stars = progress.stars[lvl.id] || 0;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `level-tile ${unlocked ? '' : 'locked'} ${
        idx === currentLevelIdx ? 'current' : ''
      }`;
      btn.disabled = !unlocked;
      const starsHtml = [1, 2, 3].map((n) => this.starSvg(n <= stars, true)).join('');
      btn.innerHTML = `<span>${lvl.id}</span><div class="tile-stars">${starsHtml}</div>`;
      if (unlocked) {
        btn.addEventListener('click', () => onSelect(idx));
      }
      this.els.levelsGrid.appendChild(btn);
    });
  }
}
