(function () {
  'use strict';

  const SESSION_SIDEBAR_STORAGE_KEY = 'kawaii-terminal-session-sidebar-visible';
  const LEFT_PANE_WIDTH_KEY = 'kawaii-terminal-left-pane-width-v2';
  const DEFAULT_LEFT_PANE_WIDTH = 360;
  const LEFT_PANE_FONT_SCALE_KEY = 'kawaii-terminal-left-pane-font-scale';
  const DEFAULT_LEFT_PANE_FONT_SCALE = 1;
  const LEFT_PANE_FONT_SCALE_MIN = 0.5;
  const LEFT_PANE_FONT_SCALE_MAX = 2;
  const LEFT_PANE_SMOOTH_SCROLL_KEY = 'kawaii-terminal-left-pane-smooth-scroll';
  const DEFAULT_LEFT_PANE_SMOOTH_SCROLL = false;
  const LEFT_PANE_SCROLL_WHEEL_SENSITIVITY = 20;
  const LEFT_PANE_SCROLL_WHEEL_SMOOTH_SCROLL_ENABLED = true;
  const LEFT_PANE_MOUSE_WHEEL_SCROLL_SENSITIVITY = 2;
  const LEFT_PANE_FAST_SCROLL_SENSITIVITY = 5;
  const LEFT_PANE_SCROLL_PREDOMINANT_AXIS = true;
  const LEFT_PANE_SCROLL_Y_TO_X = false;
  const LEFT_PANE_SCROLL_FLIP_AXES = false;
  const LEFT_PANE_ALWAYS_CONSUME_MOUSE_WHEEL = true;
  const LEFT_PANE_CONSUME_MOUSE_WHEEL_IF_SCROLLBAR_IS_NEEDED = false;
  const LEFT_PANE_MOUSE_WHEEL_SMOOTH_SCROLL = true;
  const LEFT_PANE_SMOOTH_SCROLL_DURATION_MS = 125;

  let leftPaneSmoothScrollEnabled = DEFAULT_LEFT_PANE_SMOOTH_SCROLL;
  let resizeFocusHandler = null;

  const clampNumber = (() => {
    const existing = window.KawaiiUtils?.clampNumber;
    if (typeof existing === 'function') return existing;
    const fallback = (value, min, max, fallbackValue) => {
      const num = Number(value);
      if (Number.isNaN(num)) return fallbackValue;
      return Math.min(max, Math.max(min, num));
    };
    const utils = window.KawaiiUtils || {};
    utils.clampNumber = fallback;
    window.KawaiiUtils = utils;
    return fallback;
  })();
  const isMacPlatform = () => window.windowAPI?.platform === 'darwin';

  function normalizeLeftPaneFontScale(value) {
    return clampNumber(value, LEFT_PANE_FONT_SCALE_MIN, LEFT_PANE_FONT_SCALE_MAX, DEFAULT_LEFT_PANE_FONT_SCALE);
  }

  function loadLeftPaneFontScale() {
    try {
      const raw = localStorage.getItem(LEFT_PANE_FONT_SCALE_KEY);
      if (!raw) return DEFAULT_LEFT_PANE_FONT_SCALE;
      const parsed = parseFloat(raw);
      if (!Number.isFinite(parsed)) return DEFAULT_LEFT_PANE_FONT_SCALE;
      return normalizeLeftPaneFontScale(parsed);
    } catch (_) {
      return DEFAULT_LEFT_PANE_FONT_SCALE;
    }
  }

  function applyLeftPaneFontScale(value, { persist = true } = {}) {
    const scale = normalizeLeftPaneFontScale(value);
    document.documentElement.style.setProperty('--left-pane-font-scale', String(scale));
    if (persist) {
      try {
        localStorage.setItem(LEFT_PANE_FONT_SCALE_KEY, String(scale));
      } catch (_) {
        // ignore persistence failures
      }
    }
    return scale;
  }

  function loadLeftPaneSmoothScroll() {
    try {
      const raw = localStorage.getItem(LEFT_PANE_SMOOTH_SCROLL_KEY);
      if (raw == null) return DEFAULT_LEFT_PANE_SMOOTH_SCROLL;
      return raw === 'true';
    } catch (_) {
      return DEFAULT_LEFT_PANE_SMOOTH_SCROLL;
    }
  }

  function applyLeftPaneSmoothScroll(value, { persist = true } = {}) {
    leftPaneSmoothScrollEnabled = Boolean(value);
    if (persist) {
      try {
        localStorage.setItem(LEFT_PANE_SMOOTH_SCROLL_KEY, leftPaneSmoothScrollEnabled ? 'true' : 'false');
      } catch (_) {
        // ignore persistence failures
      }
    }
    return leftPaneSmoothScrollEnabled;
  }

  function isLeftPaneSmoothScrollEnabled() {
    return Boolean(leftPaneSmoothScrollEnabled);
  }

  function getLeftPaneSmoothScrollDuration() {
    return isLeftPaneSmoothScrollEnabled() ? LEFT_PANE_SMOOTH_SCROLL_DURATION_MS : 0;
  }

  function initLeftPaneFontScaleUI() {
    const scaleInput = document.getElementById('left-pane-font-scale');
    if (!scaleInput) return;
    const syncInput = (value) => {
      scaleInput.value = String(value);
    };
    const initial = loadLeftPaneFontScale();
    syncInput(initial);
    scaleInput.addEventListener('change', () => {
      const value = parseFloat(scaleInput.value);
      if (!Number.isFinite(value)) {
        syncInput(loadLeftPaneFontScale());
        return;
      }
      const normalized = applyLeftPaneFontScale(value);
      syncInput(normalized);
    });
  }

  function initLeftPaneSmoothScrollUI() {
    const toggle = document.getElementById('left-pane-smooth-scroll');
    if (!toggle) return;
    const initial = loadLeftPaneSmoothScroll();
    toggle.checked = initial;
    applyLeftPaneSmoothScroll(initial, { persist: false });
    toggle.addEventListener('change', () => {
      applyLeftPaneSmoothScroll(toggle.checked);
    });
  }

  function applyStoredLeftPaneSettings() {
    applyLeftPaneFontScale(loadLeftPaneFontScale(), { persist: false });
    applyLeftPaneSmoothScroll(loadLeftPaneSmoothScroll(), { persist: false });
  }

  function setupSessionSidebar() {
    const sidebar = document.getElementById('session-sidebar');
    if (!sidebar) return;
    setupLeftPaneScrollBehavior();
  }

  function setupLeftPaneScrollBehavior() {
    const leftPane = document.getElementById('left-pane');
    if (!leftPane) return;

    const scrollableSelector = '.session-sidebar-body, .pin-list, .pin-project-list, .terminal-pin-content, .pin-detail-content';
    const scrollables = new WeakMap();
    const userAgent = navigator?.userAgent || '';
    const isFirefox = userAgent.includes('Firefox/');
    const isChrome = userAgent.includes('Chrome/') && !userAgent.includes('Edg/') && !userAgent.includes('OPR/');
    const isSafari = !isChrome && userAgent.includes('Safari/');
    const isWindows = window.windowAPI?.platform === 'win32';
    const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
    const chromeMajorVersion = chromeMatch ? Number.parseInt(chromeMatch[1], 10) : 123;
    const shouldFactorDpr = isChrome && chromeMajorVersion <= 122;

    class MouseWheelClassifierItem {
      constructor(timestamp, deltaX, deltaY) {
        this.timestamp = timestamp;
        this.deltaX = deltaX;
        this.deltaY = deltaY;
        this.score = 0;
      }
    }

    class MouseWheelClassifier {
      constructor() {
        this._capacity = 5;
        this._memory = [];
        this._front = -1;
        this._rear = -1;
      }

      isPhysicalMouseWheel() {
        if (this._front === -1 && this._rear === -1) return false;

        let remainingInfluence = 1;
        let score = 0;
        let iteration = 1;
        let index = this._rear;
        while (index !== null) {
          const isFront = index === this._front;
          const influence = (isFront ? remainingInfluence : Math.pow(2, -iteration));
          remainingInfluence -= influence;
          score += this._memory[index].score * influence;

          if (isFront) {
            index = null;
            continue;
          }

          index = (this._capacity + index - 1) % this._capacity;
          iteration += 1;
        }

        return score <= 0.5;
      }

      acceptStandardWheelEvent(e) {
        const pageZoomFactor = 1;
        if (isChrome) {
          this.accept(Date.now(), e.deltaX * pageZoomFactor, e.deltaY * pageZoomFactor);
        } else {
          this.accept(Date.now(), e.deltaX, e.deltaY);
        }
      }

      accept(timestamp, deltaX, deltaY) {
        let previousItem = null;
        const item = new MouseWheelClassifierItem(timestamp, deltaX, deltaY);

        if (this._front === -1 && this._rear === -1) {
          this._memory[0] = item;
          this._front = 0;
          this._rear = 0;
        } else {
          previousItem = this._memory[this._rear];
          this._rear = (this._rear + 1) % this._capacity;
          if (this._rear === this._front) {
            this._front = (this._front + 1) % this._capacity;
          }
          this._memory[this._rear] = item;
        }

        item.score = this._computeScore(item, previousItem);
      }

      _computeScore(item, previousItem) {
        if (Math.abs(item.deltaX) > 0 && Math.abs(item.deltaY) > 0) {
          return 1;
        }

        let score = 0.5;
        if (!this._isAlmostInt(item.deltaX) || !this._isAlmostInt(item.deltaY)) {
          score += 0.25;
        }

        if (previousItem) {
          const absDeltaX = Math.abs(item.deltaX);
          const absDeltaY = Math.abs(item.deltaY);
          const absPreviousDeltaX = Math.abs(previousItem.deltaX);
          const absPreviousDeltaY = Math.abs(previousItem.deltaY);

          const minDeltaX = Math.max(Math.min(absDeltaX, absPreviousDeltaX), 1);
          const minDeltaY = Math.max(Math.min(absDeltaY, absPreviousDeltaY), 1);
          const maxDeltaX = Math.max(absDeltaX, absPreviousDeltaX);
          const maxDeltaY = Math.max(absDeltaY, absPreviousDeltaY);

          const isSameModulo = (maxDeltaX % minDeltaX === 0 && maxDeltaY % minDeltaY === 0);
          if (isSameModulo) {
            score -= 0.5;
          }
        }

        return Math.min(Math.max(score, 0), 1);
      }

      _isAlmostInt(value) {
        const epsilon = Number.EPSILON * 100;
        const delta = Math.abs(Math.round(value) - value);
        return delta < 0.01 + epsilon;
      }
    }

    class ScrollState {
      constructor(forceIntegerValues, width, scrollWidth, scrollLeft, height, scrollHeight, scrollTop) {
        this._forceIntegerValues = forceIntegerValues;
        if (this._forceIntegerValues) {
          width |= 0;
          scrollWidth |= 0;
          scrollLeft |= 0;
          height |= 0;
          scrollHeight |= 0;
          scrollTop |= 0;
        }

        this.rawScrollLeft = scrollLeft;
        this.rawScrollTop = scrollTop;

        if (width < 0) width = 0;
        if (scrollLeft + width > scrollWidth) {
          scrollLeft = scrollWidth - width;
        }
        if (scrollLeft < 0) scrollLeft = 0;

        if (height < 0) height = 0;
        if (scrollTop + height > scrollHeight) {
          scrollTop = scrollHeight - height;
        }
        if (scrollTop < 0) scrollTop = 0;

        this.width = width;
        this.scrollWidth = scrollWidth;
        this.scrollLeft = scrollLeft;
        this.height = height;
        this.scrollHeight = scrollHeight;
        this.scrollTop = scrollTop;
      }

      equals(other) {
        return (
          this.rawScrollLeft === other.rawScrollLeft
          && this.rawScrollTop === other.rawScrollTop
          && this.width === other.width
          && this.scrollWidth === other.scrollWidth
          && this.scrollLeft === other.scrollLeft
          && this.height === other.height
          && this.scrollHeight === other.scrollHeight
          && this.scrollTop === other.scrollTop
        );
      }

      withScrollDimensions(update, useRawScrollPositions) {
        return new ScrollState(
          this._forceIntegerValues,
          (typeof update.width !== 'undefined' ? update.width : this.width),
          (typeof update.scrollWidth !== 'undefined' ? update.scrollWidth : this.scrollWidth),
          useRawScrollPositions ? this.rawScrollLeft : this.scrollLeft,
          (typeof update.height !== 'undefined' ? update.height : this.height),
          (typeof update.scrollHeight !== 'undefined' ? update.scrollHeight : this.scrollHeight),
          useRawScrollPositions ? this.rawScrollTop : this.scrollTop
        );
      }

      withScrollPosition(update) {
        return new ScrollState(
          this._forceIntegerValues,
          this.width,
          this.scrollWidth,
          (typeof update.scrollLeft !== 'undefined' ? update.scrollLeft : this.rawScrollLeft),
          this.height,
          this.scrollHeight,
          (typeof update.scrollTop !== 'undefined' ? update.scrollTop : this.rawScrollTop)
        );
      }
    }

    class SmoothScrollingUpdate {
      constructor(scrollLeft, scrollTop, isDone) {
        this.scrollLeft = scrollLeft;
        this.scrollTop = scrollTop;
        this.isDone = isDone;
      }
    }

    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const createEaseOutCubic = (from, to) => {
      const delta = to - from;
      return (completion) => from + delta * easeOutCubic(completion);
    };
    const createComposed = (a, b, cut) => (completion) => {
      if (completion < cut) {
        return a(completion / cut);
      }
      return b((completion - cut) / (1 - cut));
    };

    class SmoothScrollingOperation {
      constructor(from, to, startTime, duration) {
        this.from = from;
        this.to = to;
        this.duration = duration;
        this.startTime = startTime;
        this.animationFrameDisposable = null;
        this._initAnimations();
      }

      _initAnimations() {
        this.scrollLeft = this._initAnimation(this.from.scrollLeft, this.to.scrollLeft, this.to.width);
        this.scrollTop = this._initAnimation(this.from.scrollTop, this.to.scrollTop, this.to.height);
      }

      _initAnimation(from, to, viewportSize) {
        const delta = Math.abs(from - to);
        if (delta > 2.5 * viewportSize) {
          let stop1;
          let stop2;
          if (from < to) {
            stop1 = from + 0.75 * viewportSize;
            stop2 = to - 0.75 * viewportSize;
          } else {
            stop1 = from - 0.75 * viewportSize;
            stop2 = to + 0.75 * viewportSize;
          }
          return createComposed(createEaseOutCubic(from, stop1), createEaseOutCubic(stop2, to), 0.33);
        }
        return createEaseOutCubic(from, to);
      }

      dispose() {
        if (this.animationFrameDisposable) {
          this.animationFrameDisposable.dispose();
          this.animationFrameDisposable = null;
        }
      }

      acceptScrollDimensions(state) {
        this.to = state.withScrollPosition(this.to);
        this._initAnimations();
      }

      tick() {
        return this._tick(Date.now());
      }

      _tick(now) {
        const completion = (now - this.startTime) / this.duration;
        if (completion < 1) {
          const newScrollLeft = this.scrollLeft(completion);
          const newScrollTop = this.scrollTop(completion);
          return new SmoothScrollingUpdate(newScrollLeft, newScrollTop, false);
        }
        return new SmoothScrollingUpdate(this.to.scrollLeft, this.to.scrollTop, true);
      }

      combine(from, to, duration) {
        return SmoothScrollingOperation.start(from, to, duration);
      }

      static start(from, to, duration) {
        const adjusted = duration + 10;
        const startTime = Date.now() - 10;
        return new SmoothScrollingOperation(from, to, startTime, adjusted);
      }
    }

    class LeftPaneScrollable {
      constructor(element) {
        this.element = element;
        this.state = new ScrollState(true, 0, 0, 0, 0, 0, 0);
        this.smooth = null;
        this.smoothScrollDuration = getLeftPaneSmoothScrollDuration();
      }

      setSmoothScrollDuration(duration) {
        this.smoothScrollDuration = duration;
      }

      syncFromElement() {
        this.state = new ScrollState(
          true,
          this.element.clientWidth,
          this.element.scrollWidth,
          this.element.scrollLeft,
          this.element.clientHeight,
          this.element.scrollHeight,
          this.element.scrollTop
        );
        if (this.smooth) {
          this.smooth.acceptScrollDimensions(this.state);
        }
      }

      setScrollDimensions() {
        const newState = this.state.withScrollDimensions({
          width: this.element.clientWidth,
          scrollWidth: this.element.scrollWidth,
          height: this.element.clientHeight,
          scrollHeight: this.element.scrollHeight,
        }, Boolean(this.smooth));
        this._setState(newState, Boolean(this.smooth));
        this.smooth?.acceptScrollDimensions(this.state);
      }

      validateScrollPosition(update) {
        return this.state.withScrollPosition(update);
      }

      getFutureScrollPosition() {
        if (this.smooth) return this.smooth.to;
        return this.state;
      }

      setScrollPositionNow(update) {
        const newState = this.state.withScrollPosition(update);
        if (this.smooth) {
          this.smooth.dispose();
          this.smooth = null;
        }
        this._setState(newState, false);
      }

      setScrollPositionSmooth(update, reuseAnimation) {
        if (this.smoothScrollDuration === 0) {
          return this.setScrollPositionNow(update);
        }

        if (this.smooth) {
          const merged = {
            scrollLeft: (typeof update.scrollLeft === 'undefined' ? this.smooth.to.scrollLeft : update.scrollLeft),
            scrollTop: (typeof update.scrollTop === 'undefined' ? this.smooth.to.scrollTop : update.scrollTop),
          };
          const validTarget = this.state.withScrollPosition(merged);
          if (this.smooth.to.scrollLeft === validTarget.scrollLeft && this.smooth.to.scrollTop === validTarget.scrollTop) {
            return;
          }
          const nextSmooth = reuseAnimation
            ? new SmoothScrollingOperation(this.smooth.from, validTarget, this.smooth.startTime, this.smooth.duration)
            : this.smooth.combine(this.state, validTarget, this.smoothScrollDuration);
          this.smooth.dispose();
          this.smooth = nextSmooth;
        } else {
          const validTarget = this.state.withScrollPosition(update);
          this.smooth = SmoothScrollingOperation.start(this.state, validTarget, this.smoothScrollDuration);
        }

        this.smooth.animationFrameDisposable = this._scheduleAtNextAnimationFrame(() => {
          if (!this.smooth) return;
          this.smooth.animationFrameDisposable = null;
          this._performSmoothScrolling();
        });
      }

      _performSmoothScrolling() {
        if (!this.smooth) return;
        const update = this.smooth.tick();
        const newState = this.state.withScrollPosition(update);
        this._setState(newState, true);

        if (!this.smooth) return;
        if (update.isDone) {
          this.smooth.dispose();
          this.smooth = null;
          return;
        }

        this.smooth.animationFrameDisposable = this._scheduleAtNextAnimationFrame(() => {
          if (!this.smooth) return;
          this.smooth.animationFrameDisposable = null;
          this._performSmoothScrolling();
        });
      }

      _setState(newState, _inSmoothScrolling) {
        if (this.state.equals(newState)) return;
        this.state = newState;
        this.element.scrollTop = newState.scrollTop;
        this.element.scrollLeft = newState.scrollLeft;
      }

      _scheduleAtNextAnimationFrame(callback) {
        const id = requestAnimationFrame(callback);
        return { dispose: () => cancelAnimationFrame(id) };
      }
    }

    const wheelClassifier = new MouseWheelClassifier();

    const createStandardWheelEvent = (event) => {
      let deltaX = 0;
      let deltaY = 0;
      const devicePixelRatio = event?.view?.devicePixelRatio || 1;

      if (event) {
        if (typeof event.wheelDeltaY !== 'undefined') {
          deltaY = shouldFactorDpr
            ? event.wheelDeltaY / (120 * devicePixelRatio)
            : event.wheelDeltaY / 120;
        } else if (typeof event.VERTICAL_AXIS !== 'undefined' && event.axis === event.VERTICAL_AXIS) {
          deltaY = -event.detail / 3;
        } else if (event.type === 'wheel') {
          if (event.deltaMode === 1) {
            deltaY = isFirefox && !isMacPlatform() ? -event.deltaY / 3 : -event.deltaY;
          } else {
            deltaY = -event.deltaY / 40;
          }
        }

        if (typeof event.wheelDeltaX !== 'undefined') {
          if (isSafari && isWindows) {
            deltaX = -(event.wheelDeltaX / 120);
          } else {
            deltaX = shouldFactorDpr
              ? event.wheelDeltaX / (120 * devicePixelRatio)
              : event.wheelDeltaX / 120;
          }
        } else if (typeof event.HORIZONTAL_AXIS !== 'undefined' && event.axis === event.HORIZONTAL_AXIS) {
          deltaX = -event.detail / 3;
        } else if (event.type === 'wheel') {
          if (event.deltaMode === 1) {
            deltaX = isFirefox && !isMacPlatform() ? -event.deltaX / 3 : -event.deltaX;
          } else {
            deltaX = -event.deltaX / 40;
          }
        }

        if (deltaY === 0 && deltaX === 0 && event.wheelDelta) {
          deltaY = shouldFactorDpr
            ? event.wheelDelta / (120 * devicePixelRatio)
            : event.wheelDelta / 120;
        }
      }

      return { browserEvent: event, deltaX, deltaY };
    };

    const isScrollableValue = (value) => value === 'auto' || value === 'scroll' || value === 'overlay';

    const resolveScrollable = (target) => {
      const start = target instanceof Element ? target : target?.parentElement;
      let node = start;
      while (node && node !== leftPane) {
        if (node.matches?.(scrollableSelector)) {
          const style = window.getComputedStyle(node);
          const canScrollY = isScrollableValue(style.overflowY)
            && node.scrollHeight > node.clientHeight + 1;
          const canScrollX = isScrollableValue(style.overflowX)
            && node.scrollWidth > node.clientWidth + 1;
          if (canScrollX || canScrollY) {
            return { element: node, canScrollX, canScrollY };
          }
        }
        node = node.parentElement;
      }
      return null;
    };

    const getScrollable = (element) => {
      let scrollable = scrollables.get(element);
      if (!scrollable) {
        scrollable = new LeftPaneScrollable(element);
        scrollables.set(element, scrollable);
      }
      scrollable.setSmoothScrollDuration(getLeftPaneSmoothScrollDuration());
      scrollable.syncFromElement();
      scrollable.setScrollDimensions();
      return scrollable;
    };

    leftPane.addEventListener('wheel', (event) => {
      if (event.defaultPrevented) return;

      const target = resolveScrollable(event.target);
      if (!target) return;

      const standard = createStandardWheelEvent(event);
      if (LEFT_PANE_SCROLL_WHEEL_SMOOTH_SCROLL_ENABLED) {
        wheelClassifier.acceptStandardWheelEvent(standard);
      }

      let deltaY = standard.deltaY * LEFT_PANE_MOUSE_WHEEL_SCROLL_SENSITIVITY;
      let deltaX = standard.deltaX * LEFT_PANE_MOUSE_WHEEL_SCROLL_SENSITIVITY;

      if (LEFT_PANE_SCROLL_PREDOMINANT_AXIS) {
        if (LEFT_PANE_SCROLL_Y_TO_X && deltaX + deltaY === 0) {
          deltaX = 0;
          deltaY = 0;
        } else if (Math.abs(deltaY) >= Math.abs(deltaX)) {
          deltaX = 0;
        } else {
          deltaY = 0;
        }
      }

      if (LEFT_PANE_SCROLL_FLIP_AXES) {
        [deltaY, deltaX] = [deltaX, deltaY];
      }

      const shiftConvert = !isMacPlatform() && event.shiftKey;
      if ((LEFT_PANE_SCROLL_Y_TO_X || shiftConvert) && !deltaX) {
        deltaX = deltaY;
        deltaY = 0;
      }

      if (event.altKey) {
        deltaX *= LEFT_PANE_FAST_SCROLL_SENSITIVITY;
        deltaY *= LEFT_PANE_FAST_SCROLL_SENSITIVITY;
      }

      let didScroll = false;
      const element = target.element;
      const scrollable = getScrollable(element);
      const future = scrollable.getFutureScrollPosition();
      let desiredScrollTop = future.scrollTop;
      let desiredScrollLeft = future.scrollLeft;

      if (deltaY && target.canScrollY) {
        const deltaScrollTop = LEFT_PANE_SCROLL_WHEEL_SENSITIVITY * deltaY;
        desiredScrollTop = future.scrollTop - (deltaScrollTop < 0 ? Math.floor(deltaScrollTop) : Math.ceil(deltaScrollTop));
      }
      if (deltaX && target.canScrollX) {
        const deltaScrollLeft = LEFT_PANE_SCROLL_WHEEL_SENSITIVITY * deltaX;
        desiredScrollLeft = future.scrollLeft - (deltaScrollLeft < 0 ? Math.floor(deltaScrollLeft) : Math.ceil(deltaScrollLeft));
      }

      const validated = scrollable.validateScrollPosition({
        scrollTop: desiredScrollTop,
        scrollLeft: desiredScrollLeft,
      });
      desiredScrollTop = validated.scrollTop;
      desiredScrollLeft = validated.scrollLeft;

      if (future.scrollTop !== desiredScrollTop || future.scrollLeft !== desiredScrollLeft) {
        const smoothDuration = getLeftPaneSmoothScrollDuration();
        const canSmoothScroll = (
          LEFT_PANE_SCROLL_WHEEL_SMOOTH_SCROLL_ENABLED
          && LEFT_PANE_MOUSE_WHEEL_SMOOTH_SCROLL
          && smoothDuration > 0
          && wheelClassifier.isPhysicalMouseWheel()
        );
        if (canSmoothScroll) {
          scrollable.setScrollPositionSmooth({ scrollTop: desiredScrollTop, scrollLeft: desiredScrollLeft });
        } else {
          scrollable.setScrollPositionNow({ scrollTop: desiredScrollTop, scrollLeft: desiredScrollLeft });
        }
        didScroll = true;
      }

      let consumeMouseWheel = didScroll;
      if (!consumeMouseWheel && LEFT_PANE_ALWAYS_CONSUME_MOUSE_WHEEL) {
        consumeMouseWheel = true;
      }
      if (!consumeMouseWheel && LEFT_PANE_CONSUME_MOUSE_WHEEL_IF_SCROLLBAR_IS_NEEDED) {
        consumeMouseWheel = target.canScrollY || target.canScrollX;
      }

      if (consumeMouseWheel) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, { passive: false });
  }

  function setLeftPaneHidden(hidden, options = {}) {
    const leftPane = document.getElementById('left-pane');
    const activityBar = document.getElementById('activity-bar');
    if (!leftPane) return;

    if (hidden) {
      let widthToSave = null;
      if (typeof options.preserveWidth === 'number' && Number.isFinite(options.preserveWidth)) {
        widthToSave = options.preserveWidth;
      } else if (leftPane.getAttribute('aria-hidden') !== 'true') {
        widthToSave = leftPane.getBoundingClientRect().width || 0;
      }
      if (widthToSave != null && Number.isFinite(widthToSave) && widthToSave > 0) {
        leftPane.dataset.savedWidth = String(widthToSave);
        localStorage.setItem(LEFT_PANE_WIDTH_KEY, String(widthToSave));
      }
      leftPane.setAttribute('aria-hidden', 'true');
      document.body.classList.add('left-pane-hidden');
      leftPane.style.width = '0px';
      localStorage.setItem(SESSION_SIDEBAR_STORAGE_KEY, 'false');
      activityBar?.querySelectorAll('.activity-item[data-pane]').forEach((btn) => {
        btn.classList.remove('active');
      });
      return;
    }

    leftPane.setAttribute('aria-hidden', 'false');
    document.body.classList.remove('left-pane-hidden');
    const storedWidth = parseFloat(leftPane.dataset.savedWidth || localStorage.getItem(LEFT_PANE_WIDTH_KEY) || '');
    const width = Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : DEFAULT_LEFT_PANE_WIDTH;
    leftPane.dataset.savedWidth = String(width);
    leftPane.style.width = `${Math.round(width)}px`;
    localStorage.setItem(SESSION_SIDEBAR_STORAGE_KEY, 'true');
  }

  function setLeftPaneActive(pane, options = {}) {
    const leftPane = document.getElementById('left-pane');
    const activityBar = document.getElementById('activity-bar');
    if (!leftPane || !activityBar) return;

    const toggle = options?.toggle !== false;
    const targetPane = pane === 'pins' || pane === 'search' || pane === 'history' || pane === 'active'
      ? pane
      : 'active';
    const currentlyHidden = leftPane.getAttribute('aria-hidden') === 'true';
    const currentPane = leftPane.dataset.activePane || 'active';
    if (!currentlyHidden && currentPane === targetPane && toggle) {
      setLeftPaneHidden(true);
      return;
    }
    leftPane.dataset.activePane = targetPane;
    leftPane.querySelectorAll('.left-pane-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.pane === targetPane);
    });
    activityBar.querySelectorAll('.activity-item[data-pane]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pane === targetPane);
    });

    if (leftPane.getAttribute('aria-hidden') === 'true') {
      setLeftPaneHidden(false);
    }

    if (targetPane === 'pins') {
      window.pinManager?.renderPins?.();
    } else if (targetPane === 'search') {
      window.historyManager?.refreshSearchPane?.();
      window.historyManager?.focusSearchPane?.({ selectAll: Boolean(options.focusSelectAll) });
    } else {
      if (window.historyManager) {
        window.historyManager.sidebarDirty = true;
        window.historyManager.scheduleRender();
      }
    }

  }

  function getStoredActivePane() {
    return 'active';
  }

  function setupLeftActivityBar() {
    const activityBar = document.getElementById('activity-bar');
    if (!activityBar) return;

    activityBar.querySelectorAll('.activity-item[data-pane]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const pane = btn.dataset.pane;
        if (!pane) return;
        setLeftPaneActive(pane);
      });
    });

    const settingsActivity = activityBar.querySelector('.activity-item[data-action="settings"]');
    if (settingsActivity) {
      settingsActivity.addEventListener('click', (event) => {
        event.stopPropagation();
        const settingsBtn = document.getElementById('settings-btn');
        settingsBtn?.click();
      });
    }

    const saved = getStoredActivePane();
    const leftPane = document.getElementById('left-pane');
    const storedWidthRaw = localStorage.getItem(LEFT_PANE_WIDTH_KEY);
    let initialWidth = parseFloat(storedWidthRaw || '');
    if (!Number.isFinite(initialWidth) || initialWidth <= 0) {
      initialWidth = DEFAULT_LEFT_PANE_WIDTH;
      localStorage.setItem(LEFT_PANE_WIDTH_KEY, String(initialWidth));
    }
    const storedVisible = localStorage.getItem(SESSION_SIDEBAR_STORAGE_KEY);
    if (storedVisible == null) {
      localStorage.setItem(SESSION_SIDEBAR_STORAGE_KEY, 'true');
    }
    if (leftPane) {
      leftPane.dataset.activePane = saved;
      leftPane.dataset.savedWidth = String(initialWidth);
      const shouldHide = localStorage.getItem(SESSION_SIDEBAR_STORAGE_KEY) === 'false';
      if (shouldHide) {
        setLeftPaneHidden(true, { preserveWidth: initialWidth });
      } else {
        leftPane.setAttribute('aria-hidden', 'false');
        leftPane.style.width = `${Math.round(initialWidth)}px`;
        leftPane.querySelectorAll('.left-pane-panel').forEach((panel) => {
          panel.classList.toggle('active', panel.dataset.pane === saved);
        });
      }
    }
    const visible = localStorage.getItem(SESSION_SIDEBAR_STORAGE_KEY);
    if (leftPane && visible !== 'false') {
      activityBar.querySelectorAll('.activity-item[data-pane]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.pane === saved);
      });
    }
    window.leftPaneAPI = {
      setActivePane: setLeftPaneActive,
      getActivePane: () => document.getElementById('left-pane')?.dataset?.activePane || 'active',
    };
  }

  function setupSessionSidebarFocus() {
    const sidebar = document.getElementById('left-shell');
    const resizer = document.getElementById('session-sidebar-resizer');
    if (!sidebar) return;

    const isSidebarTarget = (target) =>
      sidebar.contains(target) || (resizer && resizer.contains(target));

    let hoverActive = false;
    let focusActive = false;

    const updateState = () => {
      document.body.classList.toggle('session-sidebar-focused', hoverActive || focusActive);
    };

    const handleEnter = () => {
      hoverActive = true;
      updateState();
    };

    const handleLeave = (event) => {
      if (isSidebarTarget(event.relatedTarget)) return;
      hoverActive = false;
      updateState();
    };

    sidebar.addEventListener('mouseenter', handleEnter);
    sidebar.addEventListener('mouseleave', handleLeave);
    if (resizer) {
      resizer.addEventListener('mouseenter', handleEnter);
      resizer.addEventListener('mouseleave', handleLeave);
    }

    document.addEventListener('focusin', (event) => {
      focusActive = isSidebarTarget(event.target);
      updateState();
    });

    window.addEventListener('blur', () => {
      hoverActive = false;
      focusActive = false;
      updateState();
    });
  }

  function setupSessionSidebarResizer() {
    const sidebar = document.getElementById('left-pane');
    const resizer = document.getElementById('session-sidebar-resizer');
    if (!sidebar || !resizer) return;

    const minWidth = 180;
    const maxWidth = 760;
    const collapseThreshold = 80;
    let dragState = null;

    const clampWidth = (value) => Math.max(minWidth, Math.min(maxWidth, value));
    const stopDrag = () => {
      if (!dragState) return;
      dragState = null;
      document.body.classList.remove('session-sidebar-resizing');
      resizer.classList.remove('dragging');
      resizeFocusHandler?.();
    };

    resizer.addEventListener('pointerdown', (event) => {
      const isHidden = sidebar.getAttribute('aria-hidden') === 'true';
      const storedWidth = parseFloat(
        sidebar.dataset.savedWidth || localStorage.getItem(LEFT_PANE_WIDTH_KEY) || ''
      );
      const lastVisibleWidth = Number.isFinite(storedWidth) ? storedWidth : minWidth;
      dragState = {
        startX: event.clientX,
        startWidth: isHidden ? 0 : sidebar.getBoundingClientRect().width,
        pointerId: event.pointerId,
        lastWidth: isHidden ? 0 : sidebar.getBoundingClientRect().width,
        lastVisibleWidth,
      };
      resizer.setPointerCapture?.(event.pointerId);
      document.body.classList.add('session-sidebar-resizing');
      resizer.classList.add('dragging');
      event.preventDefault();
    });

    resizer.addEventListener('pointermove', (event) => {
      if (!dragState) return;
      const dx = event.clientX - dragState.startX;
      const rawWidth = dragState.startWidth + dx;
      if (rawWidth <= collapseThreshold) {
        if (sidebar.getAttribute('aria-hidden') !== 'true') {
          const preserveWidth = dragState.lastVisibleWidth || clampWidth(dragState.startWidth);
          setLeftPaneHidden(true, { preserveWidth });
        }
        dragState.lastWidth = 0;
        return;
      }

      if (sidebar.getAttribute('aria-hidden') === 'true') {
        setLeftPaneActive(sidebar.dataset.activePane || 'active');
      }

      const nextWidth = Math.max(0, Math.min(maxWidth, rawWidth));
      dragState.lastWidth = nextWidth;
      dragState.lastVisibleWidth = nextWidth;
      sidebar.style.width = `${Math.round(nextWidth)}px`;
    });

    resizer.addEventListener('pointerup', () => {
      if (dragState?.pointerId != null) {
        resizer.releasePointerCapture?.(dragState.pointerId);
      }
      const finalWidth = dragState?.lastWidth ?? sidebar.getBoundingClientRect().width;
      if (finalWidth <= collapseThreshold || sidebar.getAttribute('aria-hidden') === 'true') {
        const preserveWidth = clampWidth(dragState?.lastVisibleWidth ?? minWidth);
        setLeftPaneHidden(true, { preserveWidth });
      } else {
        const width = clampWidth(finalWidth);
        sidebar.style.width = `${Math.round(width)}px`;
        sidebar.dataset.savedWidth = String(width);
        localStorage.setItem(LEFT_PANE_WIDTH_KEY, String(width));
        localStorage.setItem(SESSION_SIDEBAR_STORAGE_KEY, 'true');
      }
      stopDrag();
    });

    resizer.addEventListener('pointercancel', stopDrag);
    window.addEventListener('blur', stopDrag);
  }

  function toggleSessionSidebar() {
    const leftPane = document.getElementById('left-pane');
    if (!leftPane) return;

    const currentlyHidden = leftPane.getAttribute('aria-hidden') === 'true';
    if (currentlyHidden) {
      setLeftPaneActive(leftPane.dataset.activePane || 'active');
      return;
    }
    setLeftPaneHidden(true);
  }

  function setResizeFocusHandler(handler) {
    resizeFocusHandler = typeof handler === 'function' ? handler : null;
  }

  window.LeftPane = {
    setupSessionSidebar,
    setupSessionSidebarResizer,
    setupSessionSidebarFocus,
    setupLeftActivityBar,
    setActivePane: setLeftPaneActive,
    setHidden: setLeftPaneHidden,
    toggleSidebar: toggleSessionSidebar,
    initFontScaleUI: initLeftPaneFontScaleUI,
    initSmoothScrollUI: initLeftPaneSmoothScrollUI,
    applyStoredSettings: applyStoredLeftPaneSettings,
    getStoredActivePane,
    getActivePane: () => document.getElementById('left-pane')?.dataset?.activePane || getStoredActivePane(),
    setResizeFocusHandler,
  };
  window.toggleSessionSidebar = toggleSessionSidebar;
})();
