const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { outputEvents, outputDuration } = require('../../public/js/ad-schedule');

/** Insert frame holds and silent audio pads without consuming source content. */
function freezeFilters(inputLabel, events, audioFilters = [], hasAudio = false) {
  const holds = events.filter(event => event.freeze).sort((a, b) => a.start - b.start);
  if (!holds.length) return { filter: '', videoLabel: inputLabel, audioLabel: null };
  const count = holds.length + 1;
  const filters = [`[${inputLabel}]split=${count}${Array.from({length:count}, (_,i)=>`[holdv${i}]`).join('')}`];
  if (hasAudio) filters.push(`[0:a]${audioFilters.length ? audioFilters.join(',') + ',' : ''}asplit=${count}${Array.from({length:count}, (_,i)=>`[holda${i}]`).join('')}`);
  let start = 0;
  holds.forEach((event, i) => {
    if (event.start > start) {
      filters.push(`[holdv${i}]trim=start=${start}:end=${event.start},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${event.duration}[holdvc${i}]`);
      if (hasAudio) filters.push(`[holda${i}]atrim=start=${start}:end=${event.start},asetpts=PTS-STARTPTS,apad=pad_dur=${event.duration}[holdac${i}]`);
    } else {
      filters.push(`[holdv${i}]trim=start=${start},trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${event.duration},trim=duration=${event.duration}[holdvc${i}]`);
      if (hasAudio) filters.push(`[holda${i}]atrim=start=${start}:end=${start + .001},asetpts=PTS-STARTPTS,volume=0,apad=whole_dur=${event.duration},atrim=duration=${event.duration}[holdac${i}]`);
    }
    start = event.start;
  });
  const last = count - 1;
  filters.push(`[holdv${last}]trim=start=${start},setpts=PTS-STARTPTS[holdvc${last}]`);
  if (hasAudio) filters.push(`[holda${last}]atrim=start=${start},asetpts=PTS-STARTPTS[holdac${last}]`);
  // Separate audio/video concats avoid stretching one stream to the other's frame rounding.
  filters.push(`${Array.from({length:count},(_,i)=>`[holdvc${i}]`).join('')}concat=n=${count}:v=1:a=0[frozenvideo]`);
  if (hasAudio) filters.push(`${Array.from({length:count},(_,i)=>`[holdac${i}]`).join('')}concat=n=${count}:v=0:a=1[frozenaudio]`);
  return { filter: ';' + filters.join(';'), videoLabel: 'frozenvideo', audioLabel: hasAudio ? 'frozenaudio' : null };
}

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
          fps: videoStream ? (() => { const [n, d = 1] = videoStream.r_frame_rate.split('/').map(Number); return n / d || 30; })() : 30,
          codec: videoStream ? videoStream.codec_name : 'unknown',
          audioCodec: audioStream ? audioStream.codec_name : null,
          bitrate: parseInt(info.format.bit_rate) || 0,
          size: parseInt(info.format.size) || 0,
        });
      } catch (e) {
        reject(e);
      }
    });
    proc.on('error', reject);
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
    proc.on('error', reject);
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
  if(template.composition){
    const composed=require('./compositor').compose(template.composition,outputWidth,outputHeight);
    filters.push(...composed.filters);currentLabel=composed.label;
  } else {

  // 1. Crop/Zoom — extract region from source and scale to output
  const crop = template.crop || {};
  const cropX = crop.x || 'iw/2-ow/2';
  const cropY = crop.y || '0';
  const cropW = crop.custom ? crop.width : `min(iw,ih*${outputWidth}/${outputHeight})`;
  const cropH = crop.custom ? crop.height : `min(ih,iw*${outputHeight}/${outputWidth})`;
  
  // Clamp legacy crop presets so portrait and landscape sources are both valid.
  filters.push(`[${currentLabel}]crop=w='min(iw,${cropW})':h='min(ih,${cropH})':x='${cropX}':y='${cropY}'[cropped${filterIndex}]`);
  currentLabel = `cropped${filterIndex}`;
  filterIndex++;

  filters.push(`[${currentLabel}]scale=${outputWidth}:${outputHeight}:flags=lanczos[scaled${filterIndex}]`);
  currentLabel = `scaled${filterIndex}`;
  filterIndex++;

  // 2. Color correction
  }
  const color = template.colorCorrection || {};
  if (color.brightness !== undefined || color.contrast !== undefined || color.saturation !== undefined) {
    const brightness = color.brightness || 0;
    const contrast = color.contrast ?? 1;
    const saturation = color.saturation ?? 1;
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

    let drawText = text.textFile
      ? `drawtext=textfile='${text.textFile.replace(/\\/g, '/').replace(/:/g, '\\:')}':expansion=none`
      : `drawtext=text='${content}':expansion=none`;
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
  if(template.subtitleFile){
    const escaped=template.subtitleFile.replace(/\\/g,'/').replace(/:/g,'\\:');
    filters.push(`[${currentLabel}]ass=filename='${escaped}'[captioned]`);currentLabel='captioned';
  }
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
async function renderClip(inputPath, outputPath, startTime, duration, template, onProgress, adEvents = []) {
  const hasHolds = adEvents.some(event => event.freeze);
  // Video banners keep their own soundtrack (unless switched off); probe each file once.
  const probes = new Map();
  const adHasAudio = await Promise.all(adEvents.map(event => {
    const file = event.asset?.filePath;
    if (!event.asset?.animated || event.audio === false || !file || /\.gif$/i.test(file)) return false;
    if (!probes.has(file)) probes.set(file, getVideoInfo(file).then(info => !!info.audioCodec).catch(() => false));
    return probes.get(file);
  }));
  const inputInfo = hasHolds || adHasAudio.some(Boolean) ? await getVideoInfo(inputPath) : null;
  const finalDuration = outputDuration(duration, adEvents);
  return new Promise((resolve, reject) => {
    const textFiles = [];
    template = { ...template, textOverlays: (template.textOverlays || []).filter(text=>!template.sourceTimed||text.showTo>startTime&&text.showFrom<startTime+duration).map((text, i) => {
      const textFile = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}-text-${i}.txt`);
      fs.writeFileSync(textFile, text.content || '', 'utf8'); textFiles.push(textFile);
      return { ...text, textFile, ...(template.sourceTimed?{showFrom:Math.max(0,text.showFrom-startTime),showTo:Math.min(duration,text.showTo-startTime)}:{}) };
    }) };
    if(template.subtitles?.enabled&&template.subtitles.cues?.length){
      const subtitleFile=path.join(path.dirname(outputPath),`.${path.basename(outputPath)}.ass`);
      fs.writeFileSync(subtitleFile,require('./subtitles').makeAss(template.subtitles,template.output.width,template.output.height,startTime,duration),'utf8');
      textFiles.push(subtitleFile);template.subtitleFile=subtitleFile;
    }
    const cleanup = () => textFiles.forEach(file => { try { fs.unlinkSync(file); } catch {} });
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
    adEvents.forEach(event => {
      // Animated creatives play once. Never restart them to fill a fixed slot.
      if (!event.asset.animated) args.push('-loop', '1');
      if (/\.gif$/i.test(event.asset.filePath)) args.push('-ignore_loop', '1');
      args.push('-i', event.asset.filePath);
    });

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
      const wmOpacity = wm.opacity ?? 0.7;
      finalFilter += `;[1:v]format=rgba,colorchannelmixer=aa=${wmOpacity}[wm];[${outputLabel}][wm]overlay=${wmX}:${wmY}[final]`;
    } else {
      finalFilter += `;[${outputLabel}]null[final]`;
    }
    let label = 'final';
    const audioFilters = [];
    if (template.audio) {
      if (template.audio.volume !== undefined) audioFilters.push(`volume=${template.audio.volume}`);
      if (template.audio.fadeIn) audioFilters.push(`afade=t=in:st=0:d=${template.audio.fadeIn}`);
      if (template.audio.fadeOut) audioFilters.push(`afade=t=out:st=${Math.max(0, duration - template.audio.fadeOut)}:d=${template.audio.fadeOut}`);
    }
    const frozen = freezeFilters(label, adEvents, audioFilters, !!inputInfo?.audioCodec);
    finalFilter += frozen.filter;
    label = frozen.videoLabel;
    outputEvents(adEvents).forEach((event, i) => {
      const input = i + (hasWatermark ? 2 : 1);
      const w = Math.max(2, Math.round((template.output?.width || 1080) * event.width / 100 / 2) * 2);
      const h = Math.max(2, Math.round((template.output?.height || 1920) / 2) * 2);
      let adFilter = `[${input}:v]setpts=PTS-STARTPTS,scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=${event.opacity},trim=duration=${event.duration}`;
      const localProgress = event.fade > 0 ? `max(0,min(1,min(t/${event.fade},(${event.duration}-t)/${event.fade})))` : '1';
      const zoom = `0.88+0.12*(${localProgress})*(${localProgress})*(3-2*(${localProgress}))`;
      if (event.animation === 'zoom' && event.fade > 0) adFilter += `,scale=w='max(2,trunc(iw*(${zoom})/2)*2)':h='max(2,trunc(ih*(${zoom})/2)*2)':eval=frame`;
      if (event.fade > 0) adFilter += `,fade=t=in:st=0:d=${event.fade}:alpha=1,fade=t=out:st=${event.duration - event.fade}:d=${event.fade}:alpha=1`;
      adFilter += `,setpts=PTS+${event.start}/TB[ad${i}]`;
      const progress = event.fade > 0 ? `max(0,min(1,min((t-${event.start})/${event.fade},(${event.start + event.duration}-t)/${event.fade})))` : '1';
      // Smoothstep gives the slide a soft start and stop, within the creative's duration.
      const eased = `(${progress})*(${progress})*(3-2*(${progress}))`;
      const x = `max(0,min(W-w,W*${event.x / 100}-w/2))${event.animation === 'slide-left' ? `+W*0.1*(1-(${eased}))` : ''}`;
      const y = `max(0,min(H-h,H*${event.y / 100}-h/2))${event.animation === 'slide-up' ? `+H*0.08*(1-(${eased}))` : ''}`;
      finalFilter += `;${adFilter};[${label}][ad${i}]overlay=x='${x}':y='${y}':enable='gte(t,${event.start})*lt(t,${event.start + event.duration})':eof_action=pass:repeatlast=0[advert${i}]`;
      label = `advert${i}`;
    });

    // Banner sound plays at the banner's output time, faded with its picture, over the
    // clip audio (which is silent during a freeze, so the ad is heard on its own).
    const adAudioLabels = [];
    outputEvents(adEvents).forEach((event, i) => {
      if (!adHasAudio[i]) return;
      const input = i + (hasWatermark ? 2 : 1);
      let adAudio = `[${input}:a]atrim=duration=${event.duration},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo`;
      if (event.fade > 0) adAudio += `,afade=t=in:st=0:d=${event.fade},afade=t=out:st=${Math.max(0, event.duration - event.fade)}:d=${event.fade}`;
      finalFilter += `;${adAudio},adelay=${Math.round(event.start * 1000)}:all=1[adaudio${i}]`;
      adAudioLabels.push(`[adaudio${i}]`);
    });
    let audioMap = frozen.audioLabel ? `[${frozen.audioLabel}]` : '0:a?';
    if (adAudioLabels.length) {
      let main = frozen.audioLabel;
      if (!main) {
        finalFilter += inputInfo?.audioCodec
          ? `;[0:a]${audioFilters.length ? audioFilters.join(',') : 'anull'}[mainaudio]`
          : `;anullsrc=r=48000:cl=stereo,atrim=duration=${finalDuration}[mainaudio]`;
        main = 'mainaudio';
      }
      finalFilter += `;[${main}]aformat=sample_rates=48000:channel_layouts=stereo[mainstereo];[mainstereo]${adAudioLabels.join('')}amix=inputs=${adAudioLabels.length + 1}:duration=first:normalize=0[mixedaudio]`;
      audioMap = '[mixedaudio]';
    }

    args.push('-filter_complex', finalFilter);
    args.push('-map', `[${label}]`);
    args.push('-map', audioMap);

    // Audio filters
    if (audioFilters.length > 0 && audioMap === '0:a?') {
      args.push('-af', audioFilters.join(','));
    }

    // Output settings
    args.push('-c:v', 'libx264');
    args.push('-preset', template.output?.preset || 'medium');
    args.push('-crf', String(template.output?.crf || 23));
    args.push('-c:a', 'aac');
    args.push('-b:a', template.output?.audioBitrate || '192k');
    args.push('-movflags', '+faststart');
    args.push('-pix_fmt', 'yuv420p', '-t', String(finalDuration));
    args.push('-progress', 'pipe:1');
    args.push(outputPath);

    const proc = spawn('ffmpeg', args);
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('out_time_ms=')) {
          const timeMs = parseInt(line.split('=')[1]) / 1000000;
          const progress = Math.min(100, (timeMs / finalDuration) * 100);
          if (onProgress) onProgress(progress);
        }
      }
    });

    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        return reject(new Error(`FFmpeg render failed (code ${code}): ${stderr.slice(-500)}`));
      }
      if (onProgress) onProgress(100);
      resolve(outputPath);
    });

    proc.on('error', error => { cleanup(); reject(error); });
  });
}

module.exports = {
  getVideoInfo,
  generateThumbnail,
  generateTimelineThumbnails,
  buildFilterComplex,
  renderClip,
};
