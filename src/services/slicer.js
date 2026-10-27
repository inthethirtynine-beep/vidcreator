/**
 * Slicer — splits a video into segments based on mode
 */

/**
 * Auto-slice: split video into equal segments
 * @param {number} totalDuration - total video duration in seconds
 * @param {number} segmentDuration - desired segment duration in seconds
 * @param {number} [overlap=0] - overlap between segments in seconds
 * @returns {Array<{index: number, start: number, end: number, duration: number}>}
 */
function autoSlice(totalDuration, segmentDuration, overlap = 0) {
  if (![totalDuration, segmentDuration, overlap].every(Number.isFinite) || totalDuration <= 0 || segmentDuration <= 0 || overlap < 0 || overlap >= segmentDuration) {
    throw new Error('Длительность должна быть положительной, перекрытие — меньше длины клипа');
  }
  if (Math.ceil(totalDuration / (segmentDuration - overlap)) > 1000) throw new Error('Максимум 1000 клипов за одну задачу');
  const segments = [];
  let start = 0;
  let index = 0;

  while (start < totalDuration) {
    const end = Math.min(start + segmentDuration, totalDuration);
    const duration = end - start;

    segments.push({
      index,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      duration: Math.round(duration * 1000) / 1000,
    });

    if (end >= totalDuration) break;
    start = end - overlap;
    index++;
  }

  return segments;
}

function sliceByCount(totalDuration, count) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0 || !Number.isInteger(count) || count < 1 || count > 1000 || totalDuration / count < 0.1) throw new Error('Укажи корректное количество клипов');
  return Array.from({ length: count }, (_, index) => {
    const start = totalDuration * index / count;
    const end = totalDuration * (index + 1) / count;
    return { index, start, end, duration: end - start };
  });
}

function createSegments(totalDuration, config = {}) {
  switch (config.mode || 'auto') {
    case 'auto': return autoSlice(totalDuration, config.segmentDuration ?? 120, config.overlap ?? 0);
    case 'count': return sliceByCount(totalDuration, config.clipCount);
    case 'manual': return manualSlice(config.timecodes, totalDuration);
    default: throw new Error('Неизвестный режим нарезки');
  }
}

/**
 * Manual slice: create segments from timecode pairs
 * @param {Array<{start: number, end: number}>} timecodes - array of {start, end} in seconds
 * @returns {Array<{index: number, start: number, end: number, duration: number}>}
 */
function manualSlice(timecodes, totalDuration = Infinity) {
  if (!Array.isArray(timecodes) || !timecodes.length || timecodes.length > 1000) throw new Error('Укажи от 1 до 1000 сегментов');
  timecodes.forEach(tc => {
    if (!Number.isFinite(tc.start) || !Number.isFinite(tc.end) || tc.start < 0 || tc.end <= tc.start || tc.end > totalDuration + 0.001) throw new Error('Проверь таймкоды: начало меньше конца, конец в пределах видео');
  });
  return timecodes.map((tc, index) => ({
    index,
    start: tc.start,
    end: tc.end,
    duration: Math.round((tc.end - tc.start) * 1000) / 1000,
  }));
}

/**
 * Parse timecode string (HH:MM:SS or MM:SS or SS) to seconds
 */
function parseTimecode(tc) {
  if (typeof tc === 'number') return tc;

  const parts = tc.toString().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/**
 * Format seconds to HH:MM:SS
 */
function formatTimecode(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

module.exports = {
  autoSlice,
  sliceByCount,
  createSegments,
  manualSlice,
  parseTimecode,
  formatTimecode,
};
