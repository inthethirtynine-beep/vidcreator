const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Get video metadata using ffprobe
 */
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
      try {
        const info = JSON.parse(stdout);
        const videoStream = info.streams.find(s => s.codec_type === 'video');
        const audioStream = info.streams.find(s => s.codec_type === 'audio');

        resolve({
          duration: parseFloat(info.format.duration),
          width: videoStream ? videoStream.width : 0,
          height: videoStream ? videoStream.height : 0,
          fps: videoStream ? eval(videoStream.r_frame_rate) : 30,
          codec: videoStream ? videoStream.codec_name : 'unknown',
          audioCodec: audioStream ? audioStream.codec_name : null,
          bitrate: parseInt(info.format.bit_rate) || 0,
          size: parseInt(info.format.size) || 0,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Generate a thumbnail from a video at a specific time
 */
function generateThumbnail(inputPath, outputPath, timeSeconds = 1) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-ss', String(timeSeconds),
      '-i', inputPath,
      '-vframes', '1',
      '-q:v', '3',
      '-vf', 'scale=320:-1',
      outputPath
    ]);

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Thumbnail generation failed: ${stderr}`));
      resolve(outputPath);
    });
  });
}

/**
 * Generate multiple thumbnails for timeline preview
 */
async function generateTimelineThumbnails(inputPath, outputDir, count = 20) {
  const info = await getVideoInfo(inputPath);
  const interval = info.duration / count;
  const thumbnails = [];

  for (let i = 0; i < count; i++) {
    const time = i * interval;
    const outPath = path.join(outputDir, `thumb_${String(i).padStart(4, '0')}.jpg`);
    await generateThumbnail(inputPath, outPath, time);
    thumbnails.push({ time, path: outPath });
  }

  return thumbnails;
}

/**
 * Build FFmpeg filter complex for template application
 */
function buildFilterComplex(template, videoInfo) {
  const filters = [];
  let currentLabel = '0:v';
  let filterIndex = 0;

  const outputWidth = template.output?.width || 1080;
  const outputHeight = template.output?.height || 1920;

  // 1. Crop/Zoom — extract region from source and scale to output
  const crop = template.crop || {};
  const cropX = crop.x || 'iw/2-ow/2';
  const cropY = crop.y || '0';
  const cropW = crop.width || 'ih*9/16';
  const cropH = crop.height || 'ih';
  
  filters.push(`[${currentLabel}]crop=${cropW}:${cropH}:${cropX}:${cropY}[cropped${filterIndex}]`);
  currentLabel = `cropped${filterIndex}`;
  filterIndex++;

  filters.push(`[${currentLabel}]scale=${outputWidth}:${outputHeight}:flags=lanczos[scaled${filterIndex}]`);
  currentLabel = `scaled${filterIndex}`;
  filterIndex++;

  // 2. Color correction
  const color = template.colorCorrection || {};
  if (color.brightness !== undefined || color.contrast !== undefined || color.saturation !== undefined) {
    const brightness = color.brightness || 0;
    const contrast = color.contrast || 1;
    const saturation = color.saturation || 1;
    filters.push(`[${currentLabel}]eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}[color${filterIndex}]`);
    currentLabel = `color${filterIndex}`;
    filterIndex++;
  }

  // 3. Text overlays
  const texts = template.textOverlays || [];
  texts.forEach((text, i) => {
    let fontFile = text.fontFile || '';
    if (!fontFile && process.platform === 'win32' && fs.existsSync('C:/Windows/Fonts/arial.ttf')) {
      fontFile = 'C:/Windows/Fonts/arial.ttf';
    }
    const fontSize = text.fontSize || 48;
    const fontColor = text.fontColor || 'white';
    const x = text.x || '(w-text_w)/2';
    const y = text.y || '(h-text_h)/2';
    const borderW = text.borderWidth || 2;
    const shadowColor = text.shadowColor || 'black';
    const content = (text.content || '').replace(/\\/g, '\\\\').replace(/'/g, "'\\\\\\''").replace(/:/g, '\\:');

    let drawText = `drawtext=text='${content}'`;
    if (fontFile) {
      const escapedFont = fontFile.replace(/\\/g, '/').replace(/:/g, '\\:');
      drawText += `:fontfile='${escapedFont}'`;
    }
    drawText += `:fontsize=${fontSize}:fontcolor=${fontColor}`;
    drawText += `:x=${x}:y=${y}`;
    drawText += `:borderw=${borderW}:bordercolor=${shadowColor}`;

    if (text.showFrom !== undefined && text.showTo !== undefined) {
      drawText += `:enable='between(t,${text.showFrom},${text.showTo})'`;
    }

    filters.push(`[${currentLabel}]${drawText}[text${filterIndex}]`);
    currentLabel = `text${filterIndex}`;
    filterIndex++;
  });

  // 4. Fade transitions
  const transitions = template.transitions || {};
  if (transitions.fadeIn) {
    filters.push(`[${currentLabel}]fade=t=in:st=0:d=${transitions.fadeIn}[fadein${filterIndex}]`);
    currentLabel = `fadein${filterIndex}`;
    filterIndex++;
  }
  if (transitions.fadeOut) {
    filters.push(`[${currentLabel}]fade=t=out:st=FADE_OUT_START:d=${transitions.fadeOut}[fadeout${filterIndex}]`);
    currentLabel = `fadeout${filterIndex}`;
    filterIndex++;
  }

  return { filterComplex: filters.join(';'), outputLabel: currentLabel };
}

/**
 * Render a single clip with template applied
 * Returns a progress emitter
 */
function renderClip(inputPath, outputPath, startTime, duration, template, onProgress) {
  return new Promise((resolve, reject) => {
    const args = ['-y'];

    // Input
    args.push('-ss', String(startTime));
    args.push('-t', String(duration));
    args.push('-i', inputPath);

    // Watermark input if specified & enabled
    let hasWatermark = false;
    if (template.watermark && template.watermark.enabled && template.watermark.path && fs.existsSync(template.watermark.path)) {
      args.push('-i', template.watermark.path);
      hasWatermark = true;
    }

    // Build filter complex
    const { filterComplex, outputLabel } = buildFilterComplex(template, null);

    // Replace FADE_OUT_START placeholder
    let finalFilter = filterComplex;
    if (template.transitions && template.transitions.fadeOut) {
      const fadeOutStart = duration - template.transitions.fadeOut;
      finalFilter = finalFilter.replace('FADE_OUT_START', String(Math.max(0, fadeOutStart)));
    }

    // Add watermark overlay if present
    if (hasWatermark) {
      const wm = template.watermark;
      const wmX = wm.x || 'W-w-20';
      const wmY = wm.y || '20';
      const wmOpacity = wm.opacity || 0.7;
      finalFilter += `;[1:v]format=rgba,colorchannelmixer=aa=${wmOpacity}[wm];[${outputLabel}][wm]overlay=${wmX}:${wmY}[final]`;
    } else {
      finalFilter += `;[${outputLabel}]null[final]`;
    }

    args.push('-filter_complex', finalFilter);
    args.push('-map', '[final]');
    args.push('-map', '0:a?');

    // Audio filters
    const audioFilters = [];
    if (template.audio) {
      if (template.audio.volume !== undefined) {
        audioFilters.push(`volume=${template.audio.volume}`);
      }
      if (template.audio.fadeIn) {
        audioFilters.push(`afade=t=in:st=0:d=${template.audio.fadeIn}`);
      }
      if (template.audio.fadeOut) {
        const afadeStart = duration - template.audio.fadeOut;
        audioFilters.push(`afade=t=out:st=${Math.max(0, afadeStart)}:d=${template.audio.fadeOut}`);
      }
    }
    if (audioFilters.length > 0) {
      args.push('-af', audioFilters.join(','));
    }

    // Output settings
    args.push('-c:v', 'libx264');
    args.push('-preset', template.output?.preset || 'medium');
    args.push('-crf', String(template.output?.crf || 23));
    args.push('-c:a', 'aac');
    args.push('-b:a', template.output?.audioBitrate || '192k');
    args.push('-movflags', '+faststart');
    args.push('-progress', 'pipe:1');
    args.push(outputPath);

    const proc = spawn('ffmpeg', args);
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('out_time_ms=')) {
          const timeMs = parseInt(line.split('=')[1]) / 1000000;
          const progress = Math.min(100, (timeMs / duration) * 100);
          if (onProgress) onProgress(progress);
        }
      }
    });

    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`FFmpeg render failed (code ${code}): ${stderr.slice(-500)}`));
      }
      if (onProgress) onProgress(100);
      resolve(outputPath);
    });

    proc.on('error', reject);
  });
}

module.exports = {
  getVideoInfo,
  generateThumbnail,
  generateTimelineThumbnails,
  buildFilterComplex,
  renderClip,
};
