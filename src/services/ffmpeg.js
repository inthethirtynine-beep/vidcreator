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

        // Phone videos are often stored sideways with a rotation flag; FFmpeg turns the frames upright,
        // so report the size as it is displayed.
        const rotation = Number(videoStream?.tags?.rotate ?? videoStream?.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? 0);
        const sideways = Math.abs(rotation) % 180 === 90;
        resolve({
          duration: parseFloat(info.format.duration),
          width: videoStream ? (sideways ? videoStream.height : videoStream.width) : 0,
          height: videoStream ? (sideways ? videoStream.width : videoStream.height) : 0,
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
 * Loudness envelope for the editor waveform: the peak of each 1/rate-second
 * window, 0–100. Decoded at 8 kHz mono, so even long sources stay small.
 */
function audioPeaks(inputPath, rate = 50) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-v', 'error', '-i', inputPath, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const window = Math.round(8000 / rate), peaks = [];
    let peak = 0, filled = 0, carry = null, stderr = '';
    proc.stdout.on('data', chunk => {
      if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
      const even = chunk.length - (chunk.length % 2);
      if (even < chunk.length) carry = chunk.subarray(even);
      for (let i = 0; i < even; i += 2) {
        const sample = Math.abs(chunk.readInt16LE(i));
        if (sample > peak) peak = sample;
        if (++filled === window) { peaks.push(Math.round(peak / 327.67)); peak = 0; filled = 0; }
      }
    });
    proc.stderr.on('data', data => { stderr += data.toString(); });
    proc.on('close', code => {
      if (filled) peaks.push(Math.round(peak / 327.67));
      // A source without an audio stream is not an error: it simply has no waveform.
      if (code !== 0 && !/does not contain any stream|matches no streams/i.test(stderr) && !peaks.length) return reject(new Error(`Waveform failed: ${stderr.slice(-300)}`));
      resolve({ rate, peaks });
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
/**
 * Rounded corners and a soft drop shadow for a w×h picture (the framed video or a banner).
 * radius/shadow are 0–100. The corner mask is a single generated frame that alphamerge repeats for
 * the whole clip; the shadow is a blurred black copy with a margin, so it is not clipped. The result
 * is (w + 2·margin) × (h + 2·margin) with the picture centred, ready for a centred overlay.
 */
function decorate(input, w, h, { radius = 0, shadow = 0 } = {}, tag, frameWidth) {
  const filters = [];
  let label = input, margin = 0;
  const r = Math.round(Math.max(0, Math.min(100, radius)) / 100 * Math.min(w, h) / 2);
  if (r > 0) {
    filters.push(`color=c=black:s=${w}x${h}:d=1:r=1,format=gray,geq=lum='255*clip(${r}+0.5-hypot(max(abs(X-W/2+0.5)-(W/2-${r}),0),max(abs(Y-H/2+0.5)-(H/2-${r}),0)),0,1)'[${tag}mask]`);
    filters.push(`[${label}]format=rgba[${tag}rgba]`, `[${tag}rgba][${tag}mask]alphamerge[${tag}round]`);
    label = `${tag}round`;
  }
  if (shadow > 0) {
    const s = Math.min(100, shadow) / 100, sigma = frameWidth * (.006 + .02 * s), opacity = (.2 + .5 * s).toFixed(2);
    margin = Math.ceil(sigma * 3);
    const drop = Math.round(sigma * .6);
    filters.push(`[${label}]format=rgba,split[${tag}top][${tag}copy]`);
    filters.push(`[${tag}copy]colorchannelmixer=rr=0:gg=0:bb=0:aa=${opacity},pad=iw+${margin * 2}:ih+${margin * 2}:${margin}:${margin}:color=black@0,gblur=sigma=${sigma.toFixed(1)}[${tag}shadow]`);
    filters.push(`[${tag}shadow][${tag}top]overlay=${margin}:${margin - drop}:format=auto[${tag}done]`);
    label = `${tag}done`;
  }
  return { filters, label, margin };
}

function buildFilterComplex(template, videoInfo) {
  const filters = [];
  let currentLabel = '0:v';
  let filterIndex = 0;

  const outputWidth = template.output?.width || 1080;
  const outputHeight = template.output?.height || 1920;
  // Playback speed from the studio (0.25–4×): retime the picture first, keep a steady frame rate.
  // Output frame rate: the export setting (30 by default) caps the source rate. Dropping frames first
  // halves the work of every later filter and of the encoder for 60 fps recordings.
  const speed = Number(template.framing?.speed) || 1;
  const sourceFps = Number(template._fps) || 0, cap = Number(template.output?.fps) || 0;
  const targetFps = sourceFps ? Math.min(60, cap ? Math.min(cap, sourceFps) : sourceFps) : cap;
  const retime = Math.abs(speed - 1) > .001, dropFrames = targetFps && (!sourceFps || sourceFps > targetFps + .5);
  if (retime || dropFrames) {
    filters.push(`[0:v]${retime ? `setpts=PTS/${speed},` : ''}fps=${Math.round(targetFps * 1000) / 1000 || 30}[speedv]`);
    currentLabel = 'speedv';
  }
  if(template.composition){
    const composed=require('./compositor').compose(template.composition,outputWidth,outputHeight,currentLabel);
    filters.push(...composed.filters);currentLabel=composed.label;
  } else if (template.framing) {
    // 1. Framing chosen in the studio: zoom 0 shows the whole source, 1 fills the frame, >1 zooms in.
    // The source is scaled between the "fit" and "fill" sizes, panned by x/y, optionally given rounded
    // corners and a drop shadow, and placed on a blurred copy of itself (or black).
    const f = template.framing, W = outputWidth, H = outputHeight;
    const zoom = Math.max(0, Math.min(1.5, Number(f.zoom ?? 1))), x = Math.max(0, Math.min(1, Number(f.x ?? .5))), y = Math.max(0, Math.min(1, Number(f.y ?? .5)));
    const radius = Math.max(0, Math.min(100, Number(f.radius) || 0)), shadow = Math.max(0, Math.min(100, Number(f.shadow) || 0));
    const src = f._source;
    let foreground, fgW, fgH;
    if (src?.width && src?.height) {
      // Exact pixel sizes (same formula as the preview), so the corner mask matches the picture.
      const fit = Math.min(W / src.width, H / src.height), fill = Math.max(W / src.width, H / src.height), scale = fit * Math.pow(fill / fit, zoom);
      const sw = Math.max(2, Math.round(src.width * scale / 2) * 2), sh = Math.max(2, Math.round(src.height * scale / 2) * 2);
      fgW = Math.min(sw, W); fgH = Math.min(sh, H);
      foreground = `scale=${sw}:${sh}:flags=lanczos,crop=${fgW}:${fgH}:${Math.round((sw - fgW) * x)}:${Math.round((sh - fgH) * y)},setsar=1`;
    } else {
      const fit = `min(${W}/iw,${H}/ih)`, fill = `max(${W}/iw,${H}/ih)`, scale = `${fit}*pow(${fill}/${fit},${zoom})`;
      foreground = `scale=w='max(2,trunc(iw*${scale}/2)*2)':h='max(2,trunc(ih*${scale}/2)*2)':flags=lanczos,crop=w='min(iw,${W})':h='min(ih,${H})':x='(iw-ow)*${x}':y='(ih-oh)*${y}',setsar=1`;
    }
    const decorated = fgW && (radius > 0 || shadow > 0);
    if (!decorated && (f.background === 'black' || zoom >= 1)) {
      filters.push(`[${currentLabel}]${foreground},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black[framed]`);
    } else {
      // Background = the source covering the frame, blurred on a quarter-size copy (cheap), then
      // dimmed toward black by its opacity (fully black for the "black" background).
      // Blur radius is a share of the frame width, as in the preview.
      const bw = Math.max(2, Math.round(W / 8) * 2), bh = Math.max(2, Math.round(H / 8) * 2);
      const black = f.background === 'black';
      const blur = black ? 0 : Math.max(0, Math.min(100, Number(f.blur ?? 50))), opacity = black ? 0 : Math.max(0, Math.min(1, Number(f.opacity ?? .8)));
      const sigma = blur / 100 * .06 * bw;
      filters.push(`[${currentLabel}]split=2[framebg][framefg]`);
      filters.push(`[framebg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh}${sigma > .2 ? `,gblur=sigma=${sigma.toFixed(2)}` : ''},colorchannelmixer=rr=${opacity}:gg=${opacity}:bb=${opacity},scale=${W}:${H},setsar=1[frameblur]`);
      filters.push(`[framefg]${foreground}[framefront]`);
      let front = 'framefront';
      if (decorated) {
        const deco = decorate(front, fgW, fgH, { radius, shadow }, 'framedeco', W);
        filters.push(...deco.filters); front = deco.label;
      }
      filters.push(`[frameblur][${front}]overlay=x='(W-w)/2':y='(H-h)/2'[framed]`);
    }
    currentLabel = 'framed';
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
/**
 * options.control: { procs: Set } — the caller can kill running ffmpeg processes to cancel.
 * options.encoder: force an encoder kind ('cpu' is used to retry after a GPU failure).
 */
async function renderClip(inputPath, outputPath, startTime, duration, template, onProgress, adEvents = [], options = {}) {
  const encoder = require('./encoder');
  let kind = options.encoder || await encoder.detect();
  // A GPU switched off after a failure in this run stays off for every worker.
  if (kind !== 'cpu' && (await encoder.detect()) === 'cpu') kind = 'cpu';
  const hasHolds = adEvents.some(event => event.freeze);
  // Video banners keep their own soundtrack (unless switched off); probe each file once.
  const probes = new Map();
  const adHasAudio = await Promise.all(adEvents.map(event => {
    const file = event.asset?.filePath;
    if (!event.asset?.animated || event.audio === false || !file || /\.gif$/i.test(file)) return false;
    if (!probes.has(file)) probes.set(file, getVideoInfo(file).then(info => !!info.audioCodec).catch(() => false));
    return probes.get(file);
  }));
  const speed = Math.max(.25, Math.min(4, Number(template.framing?.speed) || 1));
  // Probed every time: source frame rate, size and audio drive the frame-rate cap, framing and speed.
  const inputInfo = await getVideoInfo(inputPath).catch(() => null);
  // `duration` is source time; after a speed change the clip lasts duration / speed, and ad times,
  // fades and the final length are all measured in that output time.
  const contentDuration = duration / speed;
  const finalDuration = outputDuration(contentDuration, adEvents);
  const originalTemplate = template;
  template = { ...template, _fps: inputInfo?.fps, ...(template.framing ? { framing: { ...template.framing, _source: inputInfo?.width ? { width: inputInfo.width, height: inputInfo.height } : null } } : {}) };
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

    // Input (decoded on the GPU when the encoder is a GPU one; filters still run on the CPU)
    args.push(...encoder.inputArgs(kind));
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
      const fadeOutStart = contentDuration - template.transitions.fadeOut;
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
      if (template.audio.fadeOut) audioFilters.push(`afade=t=out:st=${Math.max(0, contentDuration - template.audio.fadeOut)}:d=${template.audio.fadeOut}`);
    }
    // Speed change keeps the pitch: atempo handles 0.5–2× per step, so chain steps beyond that.
    if (Math.abs(speed - 1) > .001 && inputInfo?.audioCodec) {
      const tempo = [];
      let rest = speed;
      while (rest > 2) { tempo.push('atempo=2'); rest /= 2; }
      while (rest < .5) { tempo.push('atempo=0.5'); rest /= .5; }
      tempo.push(`atempo=${rest.toFixed(4)}`);
      audioFilters.unshift(...tempo);
    }
    const frozen = freezeFilters(label, adEvents, audioFilters, !!inputInfo?.audioCodec);
    finalFilter += frozen.filter;
    label = frozen.videoLabel;
    outputEvents(adEvents).forEach((event, i) => {
      const input = i + (hasWatermark ? 2 : 1);
      const w = Math.max(2, Math.round((template.output?.width || 1080) * event.width / 100 / 2) * 2);
      const h = Math.max(2, Math.round((template.output?.height || 1920) / 2) * 2);
      const aspect = event.asset?.width && event.asset?.height ? event.asset.width / event.asset.height : null;
      const decorated = aspect && (event.radius > 0 || event.shadow > 0);
      let adFilter;
      if (decorated) {
        // Exact banner size (needed for the corner mask), then rounded corners / shadow, then animation.
        const bw = Math.max(2, Math.round(Math.min(w, h * aspect) / 2) * 2), bh = Math.max(2, Math.round(Math.min(h, w / aspect) / 2) * 2);
        finalFilter += `;[${input}:v]setpts=PTS-STARTPTS,scale=${bw}:${bh},format=rgba,colorchannelmixer=aa=${event.opacity},trim=duration=${event.duration}[adbase${i}]`;
        const deco = decorate(`adbase${i}`, bw, bh, { radius: event.radius, shadow: event.shadow }, `addeco${i}`, template.output?.width || 1080);
        finalFilter += ';' + deco.filters.join(';');
        adFilter = `[${deco.label}]null`;
      } else {
        adFilter = `[${input}:v]setpts=PTS-STARTPTS,scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=${event.opacity},trim=duration=${event.duration}`;
      }
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
    args.push(...encoder.videoArgs(kind, template, { threads: options.threads, fast: options.fast && kind === 'cpu' }));
    // Filter graphs (blur, overlays, text) are CPU work: each parallel render gets its share of the cores.
    args.push('-filter_complex_threads', String(options.threads || Math.max(2, require('os').cpus().length)));
    args.push('-c:a', 'aac');
    args.push('-b:a', template.output?.audioBitrate || '192k');
    args.push('-movflags', '+faststart');
    args.push('-pix_fmt', 'yuv420p', '-t', String(finalDuration));
    args.push('-progress', 'pipe:1');
    args.push(outputPath);

    const proc = require('./process').track(spawn('ffmpeg', args, { windowsHide: true }));
    options.control?.procs?.add(proc);
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
      options.control?.procs?.delete(proc);
      if (options.control?.cancelled) return reject(Object.assign(new Error('Рендер отменён'), { cancelled: true }));
      if (code !== 0) {
        // A GPU encoder that fails mid-job (driver, session limit, odd source) is retried on the CPU.
        if (kind !== 'cpu') {
          console.warn(`Encoder ${kind} failed, retrying on CPU:`, stderr.slice(-300));
          if (/nvenc|cuda|qsv|amf|hwaccel|OpenEncodeSession|No capable devices/i.test(stderr)) encoder.disable(kind);
          return resolve(renderClip(inputPath, outputPath, startTime, duration, originalTemplate, onProgress, adEvents, { ...options, encoder: 'cpu' }));
        }
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
  audioPeaks,
  buildFilterComplex,
  renderClip,
};
