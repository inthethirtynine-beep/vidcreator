const { groupWords } = require('../../public/js/editor-model');
function stamp(seconds,ass=false){const ms=Math.max(0,Math.round(seconds*(ass?100:1000))),div=ass?100:1000;const h=Math.floor(ms/(3600*div)),m=Math.floor(ms/(60*div))%60,s=Math.floor(ms/div)%60;return`${ass?h:String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${ass?'.':','}${String(ms%div).padStart(ass?2:3,'0')}`;}
const escapeAss=text=>String(text).replace(/\\/g,'\\\\').replace(/[{}]/g,'').replace(/\r?\n/g,'\\N');
const assColor=hex=>'&H00'+hex.slice(5,7)+hex.slice(3,5)+hex.slice(1,3);
function makeAss(subtitles,width,height,start,duration){
  const p=subtitles,scale=width/1080,primary=p.preset==='karaoke'?p.highlight:p.color;
  const style=`Style: Main,Arial,${p.fontSize*scale},${assColor(primary)},${assColor(p.color)},&H00101010,&HAA101010,${p.preset==='classic'?0:-1},0,0,0,100,100,0,0,${p.preset==='box'?3:1},${p.outline*scale},${p.preset==='box'?0:1},5,20,20,20,1`;
  const lines=['[Script Info]','ScriptType: v4.00+',`PlayResX: ${width}`,`PlayResY: ${height}`,'WrapStyle: 0','ScaledBorderAndShadow: yes','','[V4+ Styles]','Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',style,'','[Events]','Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  for(const cue of p.cues){
    const from=Math.max(start,cue.start),to=Math.min(start+duration,cue.end);if(to<=from)continue;
    let text=escapeAss(cue.text);
    if(p.preset==='karaoke'&&cue.words?.length){
      let cursor=from;text=cue.words.filter(w=>w.end>from&&w.start<to).map(word=>{const gap=Math.max(0,word.start-cursor),length=Math.max(.01,Math.min(to,word.end)-Math.max(from,word.start));cursor=word.end;return`${gap?`{\\k${Math.round(gap*100)}} `:''}{\\kf${Math.round(length*100)}}${escapeAss(word.text.trim())} `;}).join('').trim();
    }
    lines.push(`Dialogue: 0,${stamp(from-start,true)},${stamp(to-start,true)},Main,,0,0,0,,{\\pos(${Math.round(p.x*width)},${Math.round(p.y*height)})}${text}`);
  }
  return lines.join('\n');
}
function makeSrt(cues){return cues.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text.replace(/\r/g,'')}\n`).join('\n');}
function parseSrt(text){
  const cues=[];
  for(const block of String(text).replace(/^\uFEFF/,'').replace(/\r/g,'').split(/\n\s*\n/)){
    const lines=block.split('\n'),at=lines.findIndex(line=>line.includes('-->'));if(at<0)continue;
    const times=lines[at].match(/(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})/);if(!times)continue;
    const t=offset=>+times[offset]*3600 + +times[offset+1]*60 + +times[offset+2] + +times[offset+3]/1000;
    if(t(5)<=t(1))throw new Error('Некорректный интервал в SRT');
    cues.push({id:require('crypto').randomUUID(),start:t(1),end:t(5),text:lines.slice(at+1).join('\n').replace(/<[^>]*>/g,'').trim(),words:[]});
  }
  if(!cues.length)throw new Error('В файле не найдены субтитры SRT');return cues;
}
function fromWhisper(data,duration){
  const words=[];
  for(const segment of data.transcription||[]){
    const tokens=segment.tokens||[];
    for(const token of tokens){
      if(/^\[_/.test(token.text)||/^\[.*\]$/.test(token.text))continue;
      const start=(token.offsets?.from ?? segment.offsets?.from ?? 0)/1000;
      const end=(token.offsets?.to ?? segment.offsets?.to ?? 0)/1000;
      const text=String(token.text||'');if(!text.trim())continue;
      if(!/^\s/.test(text)&&words.length){words.at(-1).text+=text;words.at(-1).end=Math.min(duration,Math.max(words.at(-1).end,end));}
      else words.push({text,start:Math.max(0,start),end:Math.min(duration,Math.max(start+.04,end))});
    }
  }
  if(words.length)return groupWords(words,5);
  return(data.transcription||[]).map(s=>({id:require('crypto').randomUUID(),start:Math.max(0,(s.offsets?.from||0)/1000),end:Math.min(duration,(s.offsets?.to||0)/1000),text:s.text.trim(),words:[]})).filter(c=>c.end>c.start&&c.text);
}
module.exports={makeAss,makeSrt,parseSrt,fromWhisper,stamp};
