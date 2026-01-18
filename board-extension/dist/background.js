chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'board/board.html' });
});