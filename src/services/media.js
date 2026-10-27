const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'../../uploads');
function source(id){
  if(!/^[a-f\d-]{36}$/i.test(id||''))throw new Error('Некорректный идентификатор видео');
  const dir=path.join(ROOT,id),manifest=path.join(dir,'video.json');
  if(!fs.existsSync(manifest))throw new Error('Видео не найдено. Загрузи исходник в студию.');
  const data=JSON.parse(fs.readFileSync(manifest,'utf8'));
  if(!fs.existsSync(data.path)||path.dirname(path.resolve(data.path))!==dir)throw new Error('Исходник недоступен');
  return{...data,public:{videoId:id,name:data.originalName,width:data.info.width,height:data.info.height,duration:data.info.duration,videoUrl:`/uploads/${id}/${path.basename(data.path)}`,thumbnailUrl:data.thumbnailUrl}};
}
module.exports={source};
