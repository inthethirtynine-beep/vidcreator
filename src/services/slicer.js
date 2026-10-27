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
  const segments = [];
  let start = 0;
  let index = 0;

  while (start < totalDuration) {
    const end = Math.min(start + segmentDuration, totalDuration);
    const duration = end - start;

    // Skip very short segments (less than 3 seconds)
    if (duration < 3 && index > 0) break;

    segments.push({
      index,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      duration: Math.round(duration * 1000) / 1000,
    });

    start = end - overlap;
    index++;
  }

  return segments;
}

/**
 * Manual slice: create segments from timecode pairs
 * @param {Array<{start: number, end: number}>} timecodes - array of {start, end} in seconds
 * @returns {Array<{index: number, start: number, end: number, duration: number}>}
 */
function manualSlice(timecodes) {
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
  manualSlice,
  parseTimecode,
  formatTimecode,
};
