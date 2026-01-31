const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAllowedNavigationUrl,
  isIndexHtmlFileUrl,
  isTrustedIpcSender,
} = require('./navigation-guard');

test('isIndexHtmlFileUrl detects file index.html', () => {
  assert.equal(isIndexHtmlFileUrl('file:///Users/example/index.html'), true);
  assert.equal(isIndexHtmlFileUrl('file:///Users/example/app/index.html'), true);
  assert.equal(isIndexHtmlFileUrl('file:///Users/example/app/Index.html'), false);
  assert.equal(isIndexHtmlFileUrl('https://example.com/index.html'), false);
});

test('isAllowedNavigationUrl allowlist matches expected schemes', () => {
  assert.equal(isAllowedNavigationUrl('devtools://devtools/bundled/inspector.html'), true);
  assert.equal(isAllowedNavigationUrl('about:blank'), true);
  assert.equal(isAllowedNavigationUrl('data:text/html,<h1>ok</h1>'), true);
  assert.equal(isAllowedNavigationUrl('file:///Users/example/index.html'), true);
  assert.equal(isAllowedNavigationUrl('file:///Users/example/other.html'), false);
});

test('isTrustedIpcSender trusts only index.html file origins', () => {
  assert.equal(isTrustedIpcSender({ senderFrame: { url: 'file:///app/index.html' } }), true);
  assert.equal(isTrustedIpcSender({ sender: { getURL: () => 'file:///app/index.html' } }), true);
  assert.equal(isTrustedIpcSender({ senderFrame: { url: 'file:///app/other.html' } }), false);
  assert.equal(isTrustedIpcSender(null), false);
});
