(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdSchedule = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function number(value, fallback, min, max, name) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}: допустимо от ${min} до ${max}`);
    return n;
  }
  function plan(config, segments, getAsset = () => null) {
    if (!config || !config.enabled) return segments.map(() => []);
    return segments.map((segment, index) => {
      const c = { ...config, ...(config.clips?.[index] || {}) };
      if (c.enabled === false) return [];
      const count = number(c.count, 2, 0, 20, 'Количество показов');
      if (!Number.isInteger(count)) throw new Error('Количество показов должно быть целым');
      if (!count) return [];
      const assets = c.assetIds || [];
      if (!assets.length) throw new Error(`Клип ${index + 1}: выбери хотя бы один баннер`);
      const staticDuration = c.duration ?? 6;
      const selected = Array.from({length:count}, (_,i) => assets[c.rotation === 'clip' ? index % assets.length : c.rotation === 'fixed' ? 0 : (index * count + i) % assets.length]);
      const durations = selected.map((id, i) => {
        const asset = getAsset(id);
        return asset?.animated ? number(asset.duration, 0, .02, 86400, 'Длительность файла баннера') : number(c.staticDurations?.[i], staticDuration, .2, 120, 'Длительность изображения');
      });
      const first = number(c.firstStart, 26, 0, 86400, 'Первый показ');
      const gap = number(c.minGap, 8, 0, 3600, 'Пауза между показами');
      const padding = number(c.endPadding, 3, 0, 3600, 'Отступ от конца');
      const freeze = c.freezeOnAd === true;
      const latest = segment.duration - padding - (freeze ? 0 : durations.at(-1));
      const starts = c.starts === undefined
        ? Array.from({ length: count }, (_, i) => count === 1 ? first : first + (latest - first) * i / (count - 1))
        : c.starts.map(Number);
      if (starts.length !== count) throw new Error(`Клип ${index + 1}: нужно ${count} таймкодов`);
      starts.forEach((start, i) => {
        if (!Number.isFinite(start) || start < 0 || start > segment.duration - padding - (freeze ? 0 : durations[i]) + 0.001 || (i && start - starts[i - 1] < (freeze ? 0 : durations[i-1]) + gap - 0.001)) {
          throw new Error(`Клип ${index + 1}: показы не помещаются. Измени время первого показа, паузу или число показов. Для статичного изображения можно уменьшить длительность`);
        }
      });
      const width = number(c.width, 90, 10, 100, 'Ширина');
      const x = number(c.x, 50, 0, 100, 'Позиция X');
      const y = number(c.y, 48, 0, 100, 'Позиция Y');
      const opacity = number(c.opacity, 1, 0, 1, 'Прозрачность');
      const animation = c.animation || 'fade';
      if (!['fade','slide-up','slide-left','zoom','none'].includes(animation)) throw new Error('Неизвестная анимация баннера');
      const transition = number(c.fade, 0.25, 0, 3, 'Длительность анимации');
      return starts.map((start, i) => ({
        assetId: selected[i],
        start: Math.round(start * 1000) / 1000, duration: durations[i], width, x, y, opacity,
        fade: animation === 'none' ? 0 : Math.min(transition, durations[i] / 2), animation, freeze,
        audio: c.adAudio !== false,
      }));
    });
  }
  // Stored starts refer to source content; inserted holds shift later output events.
  function outputEvents(events = []) {
    let inserted = 0;
    return [...events].sort((a, b) => a.start - b.start).map(event => {
      const mapped = { ...event, sourceStart: event.start, start: event.start + inserted };
      if (event.freeze) inserted += event.duration;
      return mapped;
    });
  }
  function outputDuration(duration, events = []) {
    return duration + events.reduce((sum, event) => sum + (event.freeze ? event.duration : 0), 0);
  }
  function sourceAt(time, events = []) {
    let inserted = 0;
    for (const event of outputEvents(events)) {
      if (!event.freeze) continue;
      if (time < event.start) break;
      if (time < event.start + event.duration) return { time: event.sourceStart, frozen: true };
      inserted += event.duration;
    }
    return { time: Math.max(0, time - inserted), frozen: false };
  }
  return { plan, outputEvents, outputDuration, sourceAt };
});
