/* Bootstrap Icons from @icons0/bi. No network dependency beyond the local SVG sprite. */
function uiIcon(name) {
  if (!/^[a-z0-9-]+-fill$/.test(name)) throw new Error('Only Fill / solid icons are allowed: ' + name);
  return `<svg class="ui-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-bi="${name}"><use href="/icons/bi.svg#bi-${name}"></use></svg>`;
}

function uiSetIcon(element, name) {
  if (typeof element === 'string') element = document.getElementById(element);
  if (!element || element.firstElementChild?.dataset.bi === name) return;
  element.innerHTML = uiIcon(name);
}
