// 利用可能なアバタータイプ
const AVATAR_TYPES = {
  default: {
    open: '../../assets/avatar/default.png',
    closed: '../../assets/avatar/default-close.png',
  },
  dolph: {
    open: '../../assets/avatar/dolph.png',
    closed: '../../assets/avatar/dolph-close.png',
  },
};

class AvatarManager {
  constructor(imageId) {
    this.imageElement = document.getElementById(imageId);

    // 現在のアバタータイプ
    this.avatarType = 'default';

    // アバター画像
    this.openImage = AVATAR_TYPES.default.open;
    this.closedImage = AVATAR_TYPES.default.closed;

    // まばたき設定
    this.blinkTimer = null;
    this.isBlinking = false;

    // 変更リスナー
    this.changeListeners = [];
  }

  // アバタータイプを設定
  setAvatarType(type) {
    const avatarConfig = AVATAR_TYPES[type];
    if (!avatarConfig) {
      console.warn(`Unknown avatar type: ${type}, falling back to default`);
      type = 'default';
    }

    this.avatarType = type;
    this.openImage = AVATAR_TYPES[type].open;
    this.closedImage = AVATAR_TYPES[type].closed;

    // 現在の画像を更新（まばたき中でなければ）
    if (!this.isBlinking && this.imageElement) {
      this.imageElement.src = this.openImage;
    }

    // リスナーに通知
    this.changeListeners.forEach(listener => listener(type));
  }

  // 現在のアバタータイプを取得
  getAvatarType() {
    return this.avatarType;
  }

  // 利用可能なアバタータイプ一覧を取得
  static getAvailableTypes() {
    return Object.keys(AVATAR_TYPES);
  }

  // 変更リスナーを追加
  onChange(listener) {
    this.changeListeners.push(listener);
    return () => {
      const index = this.changeListeners.indexOf(listener);
      if (index >= 0) this.changeListeners.splice(index, 1);
    };
  }

  initialize() {
    // 画像エラーハンドリング
    this.imageElement.onerror = () => {
      this.imageElement.style.display = 'none';
      console.warn('Avatar image not found. Place your image at assets/avatar/default.png');
    };

    this.imageElement.onload = () => {
      this.imageElement.style.display = 'block';
    };

    // 画像が既に読み込まれている場合も対応
    if (this.imageElement.complete && this.imageElement.naturalWidth > 0) {
      this.imageElement.style.display = 'block';
    }

    // 初期画像を設定
    this.imageElement.src = this.openImage;

    // まばたき開始（画像の読み込み状態に関係なく）
    this.scheduleNextBlink();
  }

  // 次のまばたきをスケジュール（3〜7.5秒間隔）
  scheduleNextBlink() {
    const minInterval = 3000;  // 3秒
    const maxInterval = 7500;  // 7.5秒
    const interval = minInterval + Math.random() * (maxInterval - minInterval);

    this.blinkTimer = setTimeout(() => {
      this.doBlink();
    }, interval);
  }

  // まばたき実行
  async doBlink() {
    if (this.isBlinking) return;
    this.isBlinking = true;

    // 70%で1回、30%で2回まばたき
    const isDoubleBlink = Math.random() < 0.3;

    await this.singleBlink();

    if (isDoubleBlink) {
      // 2回目のまばたきまで少し待つ
      await this.sleep(150);
      await this.singleBlink();
    }

    this.isBlinking = false;
    this.scheduleNextBlink();
  }

  // 1回のまばたき
  async singleBlink() {
    // 目を閉じる
    this.imageElement.src = this.closedImage;
    await this.sleep(100 + Math.random() * 50);  // 100-150ms

    // 目を開ける
    this.imageElement.src = this.openImage;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// グローバルに公開
window.AvatarManager = AvatarManager;
