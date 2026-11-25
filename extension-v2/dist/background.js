"use strict";
// CSV Studio Crawler — service worker (v1.4.0).
// Bấm icon extension sẽ mở BẢNG BÊN CẠNH (side panel) thay vì popup. Popup
// của Chrome tự đóng khi đổi tab/bấm ra ngoài và làm mất lượt crawl đang
// chạy; side panel giữ nguyên khi chuyển trang và tự cập nhật theo tab.
function enableSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);
enableSidePanel();
