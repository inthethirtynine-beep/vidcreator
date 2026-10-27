function compose(composition,width,height){
  const layers=composition.layers.filter(l=>l.enabled);
  const filters=[`[0:v]split=${layers.length+1}[sceneBg]${layers.map((_,i)=>`[sceneSrc${i}]`).join('')}`];
  filters.push(`[sceneBg]scale=${width}:${height},setsar=1,drawbox=c=${composition.background}:t=fill[scene0]`);
  layers.forEach((layer,i)=>{
    const c=layer.crop,r=layer.rect;
    const w=Math.max(2,Math.round(r.w*width/2)*2),h=Math.max(2,Math.round(r.h*height/2)*2);
    const x=Math.min(width-w,Math.round(r.x*width)),y=Math.min(height-h,Math.round(r.y*height));
    let filter=`[sceneSrc${i}]crop=w='max(2,trunc(iw*${c.w}/2)*2)':h='max(2,trunc(ih*${c.h}/2)*2)':x='min(iw-ow,iw*${c.x})':y='min(ih-oh,ih*${c.y})',setpts=PTS-STARTPTS,setsar=1`;
    if(layer.flip)filter+=',hflip';
    if(layer.fit==='contain')filter+=`,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${composition.background}`;
    else filter+=`,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    filter+=',format=rgba';
    if(layer.mask==='circle')filter+=`,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1),255,0)'`;
    if(layer.mask==='rounded'){
      const radius=Math.max(2,Math.round(Math.min(w,h)*.08));
      filter+=`,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow(max(abs(X-W/2)-(W/2-${radius}),0),2)+pow(max(abs(Y-H/2)-(H/2-${radius}),0),2),${radius*radius}),255,0)'`;
    }
    if(layer.opacity!==1)filter+=`,colorchannelmixer=aa=${layer.opacity}`;
    filters.push(`${filter}[sceneLayer${i}]`);
    filters.push(`[scene${i}][sceneLayer${i}]overlay=${x}:${y}:eof_action=pass[scene${i+1}]`);
  });
  return{filters,label:`scene${layers.length}`};
}
module.exports={compose};
