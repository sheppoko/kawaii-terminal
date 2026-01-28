class AvatarManager {
  constructor(imageId) {
    this.imageElement = document.getElementById(imageId);

    // アバター画像
    this.openImage = '../../assets/avatar/default.png';
    this.closedImage = '../../assets/avatar/default-close.png';

    // まばたき設定
    this.blinkTimer = null;
    this.isBlinking = false;
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
