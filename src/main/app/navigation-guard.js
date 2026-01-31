function parseUrlSafe(value) {
  try {
    return new URL(String(value || ''));
  } catch (_) {
    return null;
  }
}

function isIndexHtmlFileUrl(urlString) {
  if (typeof urlString !== 'string') return false;
  if (!/^file:/i.test(urlString)) return false;
  const parsed = parseUrlSafe(urlString);
  if (!parsed) return false;
  const pathname = parsed.pathname || '';
  return pathname.endsWith('/index.html') || pathname.endsWith('index.html');
}

function isAllowedNavigationUrl(urlString) {
  if (typeof urlString !== 'string') return false;
  if (/^devtools:\/\//i.test(urlString)) return true;
  if (/^about:/i.test(urlString)) return true;
  if (/^data:text\/html/i.test(urlString)) return true;
  return isIndexHtmlFileUrl(urlString);
}

function hardenWebContents(contents) {
  if (!contents) return;
  try {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  } catch (_) { /* noop */ }

  const blockIfUntrusted = (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    try {
      event.preventDefault();
    } catch (_) { /* noop */ }
  };

  contents.on('will-navigate', blockIfUntrusted);
  contents.on('will-redirect', blockIfUntrusted);
}

function isTrustedIpcSender(event) {
  try {
    const url = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    return isIndexHtmlFileUrl(url);
  } catch (_) {
    return false;
  }
}

module.exports = {
  hardenWebContents,
  isAllowedNavigationUrl,
  isIndexHtmlFileUrl,
  isTrustedIpcSender,
  parseUrlSafe,
};
